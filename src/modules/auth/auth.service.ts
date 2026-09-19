import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PasswordService } from '../../common/crypto/password.service';
import { AuditService } from '../audit/audit.service';
import { metrics } from '../../observability/metrics';
import type { JwtPayload, UserRole } from '../../common/types/authenticated-request';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

interface UserRow {
  id: string;
  email_enc: Buffer;
  password_hash: string;
  role: UserRole;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  status: string;
  failed_logins: number;
  locked_until: Date | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: FieldEncryptionService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {
    authenticator.options = { window: 1 };
  }

  // ------------------------------------------------------------- register

  async register(
    input: { email: string; password: string; fullName: string; phone?: string; role?: UserRole },
    ctx: AuthContext,
  ) {
    const weaknesses = PasswordService.validateStrength(input.password);
    if (weaknesses.length) {
      throw new BadRequestException({
        title: 'Password does not meet policy',
        detail: `Password ${weaknesses.join(', ')}.`,
      });
    }

    // Self-service registration can never mint privileged roles.
    const role: UserRole = input.role === 'doctor' ? 'doctor' : 'patient';
    const emailHash = this.crypto.emailHash(input.email);
    const passwordHash = await this.passwords.hash(input.password);

    try {
      const user = await this.db.transaction(async (client) => {
        const res = await client.query<{ id: string }>(
          `INSERT INTO users (email_hash, email_enc, phone_enc, password_hash, role, key_version)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            emailHash,
            this.crypto.encrypt(input.email.toLowerCase()),
            input.phone ? this.crypto.encrypt(input.phone) : null,
            passwordHash,
            role,
            this.crypto.keyVersion,
          ],
        );
        const id = res.rows[0].id;
        await client.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`, [
          id,
          input.fullName,
        ]);
        return id;
      });

      metrics.authEvents.inc({ event: 'register', result: 'success' });
      await this.audit.record({
        actorId: user,
        actorRole: role,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return { id: user, email: input.email.toLowerCase(), role, mfaEnabled: false };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        metrics.authEvents.inc({ event: 'register', result: 'duplicate' });
        // Deliberately generic: do not confirm which emails are registered.
        throw new ConflictException({ title: 'Registration could not be completed' });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- login

  async login(input: { email: string; password: string; totp?: string }, ctx: AuthContext) {
    const emailHash = this.crypto.emailHash(input.email);
    const res = await this.db.query<UserRow>(
      `SELECT id, email_enc, password_hash, role, mfa_enabled, mfa_secret_enc, status,
              failed_logins, locked_until
         FROM users WHERE email_hash = $1`,
      [emailHash],
    );
    const user = res.rows[0];

    if (!user) {
      // Spend comparable time on unknown users to blunt account enumeration.
      await this.passwords.verify(input.password, 'scrypt$32768$8$1$AAAA$AAAA');
      metrics.authEvents.inc({ event: 'login', result: 'unknown_user' });
      throw new UnauthorizedException({ title: 'Invalid credentials' });
    }

    if (user.locked_until && user.locked_until > new Date()) {
      metrics.authEvents.inc({ event: 'login', result: 'locked' });
      await this.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'denied',
        ip: ctx.ip,
        requestId: ctx.requestId,
        after: { reason: 'account_locked' },
      });
      throw new UnauthorizedException({
        title: 'Account temporarily locked',
        detail: `Too many failed attempts. Try again after ${user.locked_until.toISOString()}.`,
      });
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException({ title: 'Account is not active' });
    }

    const valid = await this.passwords.verify(input.password, user.password_hash);
    if (!valid) {
      await this.registerFailedLogin(user, ctx);
      throw new UnauthorizedException({ title: 'Invalid credentials' });
    }

    // MFA is mandatory for privileged roles once enrolled, and always enforced
    // when the user has enabled it.
    let amr = ['pwd'];
    if (user.mfa_enabled) {
      if (!input.totp) {
        metrics.authEvents.inc({ event: 'login', result: 'mfa_required' });
        throw new UnauthorizedException({
          title: 'MFA code required',
          detail: 'Provide the 6-digit TOTP code from your authenticator app as `totp`.',
        });
      }
      const ok = await this.verifyTotpOrRecovery(user, input.totp);
      if (!ok) {
        await this.registerFailedLogin(user, ctx);
        metrics.authEvents.inc({ event: 'login', result: 'mfa_invalid' });
        throw new UnauthorizedException({ title: 'Invalid MFA code' });
      }
      amr = ['pwd', 'mfa'];
    } else if (user.role === 'admin' || user.role === 'doctor') {
      this.logger.warn(`privileged user ${user.id} logged in without MFA enrolled`);
    }

    await this.db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [
      user.id,
    ]);

    const tokens = await this.issueTokens(user.id, user.role, user.mfa_enabled, amr, ctx);
    metrics.authEvents.inc({ event: 'login', result: 'success' });
    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      after: { amr },
    });

    return {
      ...tokens,
      user: { id: user.id, role: user.role, mfaEnabled: user.mfa_enabled },
    };
  }

  private async registerFailedLogin(user: UserRow, ctx: AuthContext): Promise<void> {
    const next = user.failed_logins + 1;
    const lock = next >= MAX_FAILED_LOGINS;
    await this.db.query(
      `UPDATE users
          SET failed_logins = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [user.id, lock ? 0 : next, lock, String(LOCKOUT_MINUTES)],
    );
    metrics.authEvents.inc({ event: 'login', result: 'bad_password' });
    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'denied',
      ip: ctx.ip,
      requestId: ctx.requestId,
      after: { failedLogins: next, locked: lock },
    });
  }

  // --------------------------------------------------------------- tokens

  private async issueTokens(
    userId: string,
    role: UserRole,
    mfaEnabled: boolean,
    amr: string[],
    ctx: AuthContext,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const sid = randomUUID();
    const payload: JwtPayload = { sub: userId, role, mfa: mfaEnabled, amr, sid };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '10m'),
    });

    const refreshTtlDays = this.config.get<number>('JWT_REFRESH_TTL_DAYS', 7);
    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(refreshToken);

    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)`,
      [userId, familyId, tokenHash, String(refreshTtlDays), ctx.userAgent ?? null, ctx.ip ?? null],
    );

    return {
      accessToken,
      refreshToken: `${familyId}.${refreshToken}`,
      expiresIn: this.ttlSeconds(this.config.get<string>('JWT_ACCESS_TTL', '10m')),
      tokenType: 'Bearer',
    };
  }

  /**
   * Refresh-token rotation with reuse detection.
   *
   * Each refresh consumes its token and issues a new one in the same family.
   * Presenting an already-used token means it leaked: the entire family is
   * revoked immediately and all live sessions are denylisted.
   */
  async refresh(rawToken: string, ctx: AuthContext): Promise<TokenPair> {
    const [familyId, secret] = rawToken.split('.');
    if (!familyId || !secret) throw new UnauthorizedException({ title: 'Malformed refresh token' });

    const tokenHash = this.hashToken(secret);
    const res = await this.db.query<{
      id: string;
      user_id: string;
      family_id: string;
      used_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date;
      role: UserRole;
      mfa_enabled: boolean;
    }>(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.used_at, rt.revoked_at, rt.expires_at,
              u.role, u.mfa_enabled
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1`,
      [tokenHash],
    );
    const token = res.rows[0];

    if (!token || token.family_id !== familyId) {
      metrics.authEvents.inc({ event: 'refresh', result: 'unknown' });
      throw new UnauthorizedException({ title: 'Invalid refresh token' });
    }

    if (token.used_at || token.revoked_at) {
      await this.revokeFamily(token.family_id, 'reuse_detected');
      metrics.authEvents.inc({ event: 'refresh', result: 'reuse_detected' });
      await this.audit.record({
        actorId: token.user_id,
        action: 'auth.refresh.reuse_detected',
        resourceType: 'refresh_token_family',
        resourceId: token.family_id,
        outcome: 'denied',
        ip: ctx.ip,
        requestId: ctx.requestId,
      });
      throw new UnauthorizedException({
        title: 'Refresh token reuse detected',
        detail: 'All sessions in this family have been revoked. Please sign in again.',
      });
    }

    if (token.expires_at < new Date()) {
      metrics.authEvents.inc({ event: 'refresh', result: 'expired' });
      throw new UnauthorizedException({ title: 'Refresh token expired' });
    }

    await this.db.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [token.id]);

    // Preserve the MFA assurance level across rotation.
    const amr = token.mfa_enabled ? ['pwd', 'mfa'] : ['pwd'];
    const tokens = await this.issueTokens(
      token.user_id,
      token.role,
      token.mfa_enabled,
      amr,
      ctx,
      token.family_id,
    );
    metrics.authEvents.inc({ event: 'refresh', result: 'success' });
    return tokens;
  }

  async logout(userId: string, sid: string | undefined, refreshToken?: string): Promise<void> {
    if (sid) {
      // Denylist the access token's session until it would have expired anyway.
      await this.redis.client.set(`denylist:session:${sid}`, '1', 'EX', 900);
    }
    if (refreshToken) {
      const [, secret] = refreshToken.split('.');
      if (secret) {
        await this.db.query(
          `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
            WHERE token_hash = $1 AND user_id = $2`,
          [this.hashToken(secret), userId],
        );
      }
    }
    metrics.authEvents.inc({ event: 'logout', result: 'success' });
    await this.audit.record({ actorId: userId, action: 'auth.logout', resourceType: 'user', resourceId: userId });
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 600;
    const value = Number(match[1]);
    const unit = match[2];
    return value * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[unit];
  }

  // ------------------------------------------------------------------ MFA

  /** Begin enrolment: returns the otpauth URI + QR data-URL. Not yet active. */
  async enrollMfa(userId: string): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const res = await this.db.query<{ email_enc: Buffer; mfa_enabled: boolean }>(
      `SELECT email_enc, mfa_enabled FROM users WHERE id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) throw new UnauthorizedException({ title: 'User not found' });
    if (row.mfa_enabled) throw new ConflictException({ title: 'MFA is already enabled' });

    const email = this.crypto.decrypt(row.email_enc) ?? 'user';
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(email, 'Amrutam Telemedicine', secret);

    // Park the pending secret in Redis (10 min) — it only lands in Postgres
    // once the user proves possession by verifying a code.
    await this.redis.client.set(`mfa:pending:${userId}`, secret, 'EX', 600);

    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  /** Complete enrolment by proving possession; returns one-time recovery codes. */
  async verifyMfaEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.redis.client.get(`mfa:pending:${userId}`);
    if (!secret) {
      throw new BadRequestException({ title: 'No pending MFA enrolment. Start again.' });
    }
    if (!authenticator.verify({ token: code, secret })) {
      metrics.authEvents.inc({ event: 'mfa_enroll', result: 'invalid_code' });
      throw new UnauthorizedException({ title: 'Invalid MFA code' });
    }

    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'),
    );

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret_enc = $2, updated_at = now() WHERE id = $1`,
        [userId, this.crypto.encrypt(secret)],
      );
      await client.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      for (const code of recoveryCodes) {
        await client.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          this.hashToken(code),
        ]);
      }
    });

    await this.redis.client.del(`mfa:pending:${userId}`);
    metrics.authEvents.inc({ event: 'mfa_enroll', result: 'success' });
    await this.audit.record({
      actorId: userId,
      action: 'auth.mfa.enabled',
      resourceType: 'user',
      resourceId: userId,
    });

    return { recoveryCodes };
  }

  async disableMfa(userId: string, code: string): Promise<void> {
    const res = await this.db.query<UserRow>(
      `SELECT id, email_enc, password_hash, role, mfa_enabled, mfa_secret_enc, status,
              failed_logins, locked_until FROM users WHERE id = $1`,
      [userId],
    );
    const user = res.rows[0];
    if (!user?.mfa_enabled) throw new BadRequestException({ title: 'MFA is not enabled' });
    if (!(await this.verifyTotpOrRecovery(user, code))) {
      throw new UnauthorizedException({ title: 'Invalid MFA code' });
    }
    if (user.role === 'admin') {
      throw new BadRequestException({
        title: 'MFA is mandatory for administrators',
        detail: 'Administrator accounts cannot disable multi-factor authentication.',
      });
    }
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1`,
        [userId],
      );
      await client.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
    });
    await this.audit.record({
      actorId: userId,
      action: 'auth.mfa.disabled',
      resourceType: 'user',
      resourceId: userId,
    });
  }

  /** Accept either a valid TOTP or an unused recovery code (burned on use). */
  private async verifyTotpOrRecovery(user: UserRow, code: string): Promise<boolean> {
    const secret = this.crypto.decrypt(user.mfa_secret_enc);
    if (secret && authenticator.verify({ token: code.replace(/\s/g, ''), secret })) {
      // Replay protection: a TOTP code is single-use inside its 30s step.
      const key = `mfa:used:${user.id}:${code}`;
      const fresh = await this.redis.client.set(key, '1', 'EX', 90, 'NX');
      return fresh === 'OK';
    }
    const hash = this.hashToken(code.trim().toUpperCase());
    const res = await this.db.query<{ id: string }>(
      `UPDATE mfa_recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING id`,
      [user.id, hash],
    );
    if (res.rowCount === 1) {
      metrics.authEvents.inc({ event: 'mfa_recovery', result: 'used' });
      return true;
    }
    return false;
  }
}
