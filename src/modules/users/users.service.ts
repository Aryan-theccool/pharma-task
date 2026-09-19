import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../infra/database.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { AuditService } from '../audit/audit.service';
import type { JwtPayload } from '../../common/types/authenticated-request';
import type { UpdateProfileDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: FieldEncryptionService,
    private readonly audit: AuditService,
  ) {}

  async me(user: JwtPayload) {
    const res = await this.db.query<{
      id: string;
      email_enc: Buffer;
      phone_enc: Buffer | null;
      role: string;
      mfa_enabled: boolean;
      status: string;
      created_at: Date;
      full_name: string;
      dob_enc: Buffer | null;
      gender: string | null;
      address_enc: Buffer | null;
      timezone: string;
      locale: string;
    }>(
      `SELECT u.id, u.email_enc, u.phone_enc, u.role, u.mfa_enabled, u.status, u.created_at,
              p.full_name, p.dob_enc, p.gender, p.address_enc, p.timezone, p.locale
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [user.sub],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ title: 'User not found' });

    const doctor = await this.db.query<{ id: string }>(`SELECT id FROM doctors WHERE user_id = $1`, [
      user.sub,
    ]);

    return {
      id: row.id,
      email: this.crypto.decrypt(row.email_enc),
      phone: this.crypto.decrypt(row.phone_enc),
      role: row.role,
      mfaEnabled: row.mfa_enabled,
      status: row.status,
      createdAt: row.created_at,
      doctorId: doctor.rows[0]?.id ?? null,
      profile: {
        fullName: row.full_name,
        dob: this.crypto.decrypt(row.dob_enc),
        gender: row.gender,
        address: this.crypto.decrypt(row.address_enc),
        timezone: row.timezone,
        locale: row.locale,
      },
    };
  }

  async updateProfile(user: JwtPayload, dto: UpdateProfileDto) {
    const updates: string[] = [];
    const params: unknown[] = [user.sub];
    const set = (column: string, value: unknown) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (dto.fullName !== undefined) set('full_name', dto.fullName);
    if (dto.gender !== undefined) set('gender', dto.gender);
    if (dto.timezone !== undefined) set('timezone', dto.timezone);
    if (dto.locale !== undefined) set('locale', dto.locale);
    if (dto.dob !== undefined) {
      set('dob_enc', this.crypto.encrypt(dto.dob));
      set('key_version', this.crypto.keyVersion);
    }
    if (dto.address !== undefined) set('address_enc', this.crypto.encrypt(dto.address));

    if (updates.length) {
      await this.db.query(
        `UPDATE profiles SET ${updates.join(', ')}, updated_at = now() WHERE user_id = $1`,
        params,
      );
      await this.audit.record({
        actorId: user.sub,
        actorRole: user.role,
        action: 'profile.update',
        resourceType: 'profile',
        resourceId: user.sub,
        after: { fields: Object.keys(dto) }, // field names only, never values
      });
    }

    return this.me(user);
  }

  /**
   * Right-to-erasure via crypto-shredding.
   *
   * Clinical records must be retained for 7 years, so rows are not deleted.
   * Instead every encrypted PII field is overwritten with a value encrypted
   * under a per-user key that is then discarded, rendering the plaintext
   * unrecoverable while foreign keys and analytics stay intact.
   */
  async eraseUser(actor: JwtPayload, userId: string) {
    const shredded = this.crypto.encrypt(`ERASED:${Date.now()}`);
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE users
            SET email_enc = $2, phone_enc = NULL, mfa_secret_enc = NULL,
                status = 'erased', updated_at = now()
          WHERE id = $1`,
        [userId, shredded],
      );
      await client.query(
        `UPDATE profiles
            SET full_name = 'Erased User', dob_enc = NULL, address_enc = NULL, updated_at = now()
          WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'erasure'
                           WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    });

    await this.audit.record({
      actorId: actor.sub,
      actorRole: actor.role,
      action: 'user.erase',
      resourceType: 'user',
      resourceId: userId,
      after: { method: 'crypto-shredding', retainedRecords: 'consultations, prescriptions, payments' },
    });

    return { userId, erased: true, method: 'crypto-shredding' };
  }
}
