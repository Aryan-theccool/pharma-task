import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../../common/utils/canonical-json';

/**
 * Signed, expiring capability token for joining a consultation's media session.
 *
 * The previous implementation returned `stub-rtc-token-${consultationId}`. That
 * is not a credential: the consultation id appears in URLs, in the patient's
 * own consultation list, and in any log or referrer that captures the path.
 * Anyone who learned an id could construct a "valid" token for someone else's
 * medical consultation. For a telemedicine platform that is a confidentiality
 * breach of the actual clinical encounter, not merely of its metadata.
 *
 * This is the same shape every real RTC provider expects (Agora, Twilio Video,
 * LiveKit and Daily all issue a short-lived signed join credential), so
 * swapping in a vendor means re-implementing `issue()` against their signing
 * scheme — the callers and the API contract do not change.
 *
 * Token: `v1.<payloadB64url>.<hmacB64url>`
 *   payload = { cid, uid, role, exp, nonce }
 *   hmac    = HMAC-SHA256(key, "v1." + payloadB64url)
 *
 * Properties that matter:
 *  - **Bound to one user AND one consultation.** A patient's token for their
 *    own consultation cannot be replayed against a different one, and cannot
 *    be lent to another account.
 *  - **Short-lived.** A leaked token expires in minutes, not for ever.
 *  - **Role-scoped.** The media server can refuse to let a patient claim the
 *    practitioner's publish rights.
 *  - **Verifiable without state.** No Redis round-trip on the join path.
 */

export type JoinRole = 'host' | 'guest';

export interface JoinTokenPayload {
  /** Consultation id. */
  cid: string;
  /** User id the token was minted for. */
  uid: string;
  role: JoinRole;
  /** Expiry, unix seconds. */
  exp: number;
  /** Makes two tokens for the same user+consultation distinguishable. */
  nonce: string;
}

export interface JoinTokenVerification {
  valid: boolean;
  reason?: 'malformed' | 'bad-version' | 'bad-signature' | 'expired' | 'wrong-subject';
  payload?: JoinTokenPayload;
}

const VERSION = 'v1';

@Injectable()
export class JoinTokenService {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService) {
    // Derived from its own secret when provided; otherwise from the
    // prescription signing key, which is already required to exist. Distinct
    // HKDF-style info via the HMAC label keeps the two uses separate.
    const material =
      config.get<string>('JOIN_TOKEN_SECRET') ??
      config.getOrThrow<string>('PRESCRIPTION_SIGNING_KEY');
    const isHex = /^[0-9a-f]+$/i.test(material) && material.length % 2 === 0;
    const raw = isHex ? Buffer.from(material, 'hex') : Buffer.from(material, 'utf8');
    this.key = createHmac('sha256', raw).update('amrutam-join-token').digest();
    this.ttlSeconds = config.get<number>('JOIN_TOKEN_TTL_SECONDS', 900);
  }

  /** Mint a token for one user joining one consultation. */
  issue(
    consultationId: string,
    userId: string,
    role: JoinRole,
    now: Date = new Date(),
  ): { token: string; expiresAt: string } {
    const exp = Math.floor(now.getTime() / 1000) + this.ttlSeconds;
    const payload: JoinTokenPayload = {
      cid: consultationId,
      uid: userId,
      role,
      exp,
      nonce: randomNonce(),
    };

    // canonicalJson, never JSON.stringify: the signature must survive a
    // round-trip through any store that reorders object keys.
    const encoded = b64url(Buffer.from(canonicalJson(payload), 'utf8'));
    const signature = this.sign(encoded);
    return {
      token: `${VERSION}.${encoded}.${signature}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /**
   * Verify a token, optionally pinning it to an expected subject.
   *
   * The media gateway calls this. Passing `expect` is what prevents a valid
   * token for consultation A being presented to join consultation B.
   */
  verify(
    token: string,
    expect?: { consultationId?: string; userId?: string },
    now: Date = new Date(),
  ): JoinTokenVerification {
    const parts = token?.split('.') ?? [];
    if (parts.length !== 3) return { valid: false, reason: 'malformed' };

    const [version, encoded, signature] = parts;
    if (version !== VERSION) return { valid: false, reason: 'bad-version' };

    const expected = this.sign(encoded);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'bad-signature' };
    }

    let payload: JoinTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed' };
    }

    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) {
      return { valid: false, reason: 'expired', payload };
    }
    if (expect?.consultationId && payload.cid !== expect.consultationId) {
      return { valid: false, reason: 'wrong-subject', payload };
    }
    if (expect?.userId && payload.uid !== expect.userId) {
      return { valid: false, reason: 'wrong-subject', payload };
    }

    return { valid: true, payload };
  }

  private sign(encodedPayload: string): string {
    return b64url(createHmac('sha256', this.key).update(`${VERSION}.${encodedPayload}`).digest());
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function randomNonce(): string {
  return randomBytes(9).toString('base64url');
}
