import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import { metrics } from '../../observability/metrics';
import type { JwtPayload } from '../../common/types/authenticated-request';
import type { OnboardDoctorDto, SearchDoctorsQuery, UpdateDoctorDto } from './dto/doctors.dto';

export interface DoctorRecord {
  id: string;
  user_id: string;
  display_name: string;
  registration_no: string;
  bio: string;
  specializations: string[];
  languages: string[];
  experience_years: number;
  consultation_fee: string;
  currency: string;
  rating_avg: string;
  rating_count: number;
  verification_state: string;
  timezone: string;
}

const DOCTOR_CACHE_TTL = 600; // 10 minutes
const SEARCH_CACHE_TTL = 60; // 60 seconds

@Injectable()
export class DoctorsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private cacheKey(id: string) {
    return `doctor:${id}`;
  }

  async onboard(user: JwtPayload, dto: OnboardDoctorDto) {
    if (user.role !== 'doctor' && user.role !== 'admin') {
      throw new ForbiddenException({ title: 'Only doctor accounts can be onboarded' });
    }
    const existing = await this.db.query(`SELECT id FROM doctors WHERE user_id = $1`, [user.sub]);
    if (existing.rowCount) throw new ConflictException({ title: 'Doctor profile already exists' });

    const res = await this.db.query<DoctorRecord>(
      `INSERT INTO doctors
         (user_id, display_name, registration_no, bio, specializations, languages,
          experience_years, consultation_fee, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        user.sub,
        dto.displayName,
        dto.registrationNo,
        dto.bio ?? '',
        dto.specializations,
        dto.languages,
        dto.experienceYears ?? 0,
        dto.consultationFee,
        dto.timezone ?? 'Asia/Kolkata',
      ],
    );
    await this.invalidateSearch();
    return this.present(res.rows[0]);
  }

  async findById(id: string) {
    const cached = await this.redis.get<DoctorRecord>(this.cacheKey(id));
    if (cached) {
      metrics.cacheEvents.inc({ cache: 'doctor', result: 'hit' });
      return this.present(cached);
    }
    metrics.cacheEvents.inc({ cache: 'doctor', result: 'miss' });

    const res = await this.db.queryReplica<DoctorRecord>(`SELECT * FROM doctors WHERE id = $1`, [id]);
    const doctor = res.rows[0];
    if (!doctor) throw new NotFoundException({ title: 'Doctor not found' });

    await this.redis.set(this.cacheKey(id), doctor, DOCTOR_CACHE_TTL);
    return this.present(doctor);
  }

  async findByUserId(userId: string): Promise<DoctorRecord | null> {
    const res = await this.db.query<DoctorRecord>(`SELECT * FROM doctors WHERE user_id = $1`, [userId]);
    return res.rows[0] ?? null;
  }

  /** Resolve the doctor row for the caller, or 403. */
  async requireOwnDoctor(user: JwtPayload): Promise<DoctorRecord> {
    const doctor = await this.findByUserId(user.sub);
    if (!doctor) {
      throw new ForbiddenException({ title: 'No doctor profile linked to this account' });
    }
    return doctor;
  }

  async update(id: string, user: JwtPayload, dto: UpdateDoctorDto) {
    const res = await this.db.query<DoctorRecord>(`SELECT * FROM doctors WHERE id = $1`, [id]);
    const doctor = res.rows[0];
    if (!doctor) throw new NotFoundException({ title: 'Doctor not found' });

    // ABAC: a doctor may only edit their own profile; admins may edit any.
    if (user.role !== 'admin' && doctor.user_id !== user.sub) {
      throw new ForbiddenException({ title: 'You may only modify your own doctor profile' });
    }

    const updates: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (dto.displayName !== undefined) set('display_name', dto.displayName);
    if (dto.bio !== undefined) set('bio', dto.bio);
    if (dto.specializations !== undefined) set('specializations', dto.specializations);
    if (dto.languages !== undefined) set('languages', dto.languages);
    if (dto.experienceYears !== undefined) set('experience_years', dto.experienceYears);
    if (dto.consultationFee !== undefined) set('consultation_fee', dto.consultationFee);
    if (dto.timezone !== undefined) set('timezone', dto.timezone);
    // Only an administrator may change the verification state.
    if (dto.verificationState !== undefined) {
      if (user.role !== 'admin') {
        throw new ForbiddenException({ title: 'Only administrators may change verification state' });
      }
      set('verification_state', dto.verificationState);
    }

    if (!updates.length) return this.present(doctor);

    const updated = await this.db.query<DoctorRecord>(
      `UPDATE doctors SET ${updates.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params,
    );

    // Write-through: refresh the cached entry rather than just dropping it.
    await this.redis.set(this.cacheKey(id), updated.rows[0], DOCTOR_CACHE_TTL);
    await this.invalidateSearch();
    return this.present(updated.rows[0]);
  }

  /**
   * Faceted doctor search.
   *
   * Full-text (`search_vector`) + trigram fuzzy name matching, array-contains
   * filters on specialization/language, numeric range on fee, and an optional
   * "has availability from" join. Keyset (cursor) pagination — never OFFSET,
   * which degrades linearly on deep pages.
   */
  async search(query: SearchDoctorsQuery) {
    const cacheKey = `search:${Buffer.from(JSON.stringify(query)).toString('base64url')}`;
    const cached = await this.redis.get<unknown>(cacheKey);
    if (cached) {
      metrics.cacheEvents.inc({ cache: 'search', result: 'hit' });
      return cached;
    }
    metrics.cacheEvents.inc({ cache: 'search', result: 'miss' });

    const where: string[] = [`d.verification_state = 'verified'`];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (query.q) {
      params.push(query.q);
      const i = params.length;
      where.push(
        `(d.search_vector @@ plainto_tsquery('simple', $${i}) OR d.display_name ILIKE '%' || $${i} || '%')`,
      );
    }
    if (query.specialization) add('d.specializations @> ARRAY[$?]::text[]', query.specialization);
    if (query.language) add('d.languages @> ARRAY[$?]::text[]', query.language);
    if (query.minFee !== undefined) add('d.consultation_fee >= $?', query.minFee);
    if (query.maxFee !== undefined) add('d.consultation_fee <= $?', query.maxFee);
    if (query.minRating !== undefined) add('d.rating_avg >= $?', query.minRating);
    if (query.minExperience !== undefined) add('d.experience_years >= $?', query.minExperience);

    if (query.availableFrom) {
      params.push(query.availableFrom);
      where.push(`EXISTS (
        SELECT 1 FROM availability_slots s
         WHERE s.doctor_id = d.id AND s.status = 'available'
           AND lower(s.slot_range) >= $${params.length}::timestamptz)`);
    }

    // Keyset cursor: (rating_avg, id) descending.
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        params.push(decoded.rating, decoded.id);
        where.push(`(d.rating_avg, d.id) < ($${params.length - 1}::numeric, $${params.length}::uuid)`);
      }
    }

    const limit = Math.min(query.limit ?? 20, 100);
    params.push(limit + 1);

    const sql = `
      SELECT d.id, d.display_name, d.specializations, d.languages, d.experience_years,
             d.consultation_fee, d.currency, d.rating_avg, d.rating_count, d.bio, d.timezone,
             (SELECT min(lower(s.slot_range)) FROM availability_slots s
               WHERE s.doctor_id = d.id AND s.status = 'available'
                 AND lower(s.slot_range) > now()) AS next_available_at
        FROM doctors d
       WHERE ${where.join(' AND ')}
       ORDER BY d.rating_avg DESC, d.id DESC
       LIMIT $${params.length}`;

    const res = await this.db.queryReplica(sql, params);
    const rows = res.rows.slice(0, limit);
    const nextCursor =
      res.rows.length > limit
        ? encodeCursor({
            rating: String(rows[rows.length - 1].rating_avg),
            id: String(rows[rows.length - 1].id),
          })
        : null;

    const facets = await this.facets(query);

    const result = {
      items: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        specializations: r.specializations,
        languages: r.languages,
        experienceYears: r.experience_years,
        consultationFee: Number(r.consultation_fee),
        currency: r.currency,
        ratingAvg: Number(r.rating_avg),
        ratingCount: r.rating_count,
        bio: r.bio,
        timezone: r.timezone,
        nextAvailableAt: r.next_available_at,
      })),
      nextCursor,
      facets,
    };

    await this.redis.set(cacheKey, result, SEARCH_CACHE_TTL);
    await this.redis.client.sadd('search:keys', cacheKey);
    return result;
  }

  /** Aggregate counts used to render filter chips in the client. */
  private async facets(query: SearchDoctorsQuery) {
    const res = await this.db.queryReplica<{ specialization: string; count: string }>(
      `SELECT unnest(specializations) AS specialization, count(*)::text AS count
         FROM doctors
        WHERE verification_state = 'verified'
          ${query.language ? `AND languages @> ARRAY[$1]::text[]` : ''}
        GROUP BY 1
        ORDER BY count(*) DESC
        LIMIT 20`,
      query.language ? [query.language] : [],
    );
    return {
      specializations: res.rows.map((r) => ({ value: r.specialization, count: Number(r.count) })),
    };
  }

  /** Tag-based invalidation of the whole search result namespace. */
  async invalidateSearch(): Promise<void> {
    const keys = await this.redis.client.smembers('search:keys');
    if (keys.length) {
      await this.redis.client.del(...keys);
      await this.redis.client.del('search:keys');
    }
  }

  async invalidateDoctor(id: string): Promise<void> {
    await this.redis.del(this.cacheKey(id));
  }

  private present(d: DoctorRecord) {
    return {
      id: d.id,
      userId: d.user_id,
      displayName: d.display_name,
      registrationNo: d.registration_no,
      bio: d.bio,
      specializations: d.specializations,
      languages: d.languages,
      experienceYears: d.experience_years,
      consultationFee: Number(d.consultation_fee),
      currency: d.currency,
      ratingAvg: Number(d.rating_avg),
      ratingCount: d.rating_count,
      verificationState: d.verification_state,
      timezone: d.timezone,
    };
  }
}

function encodeCursor(value: { rating: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): { rating: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof parsed?.rating === 'string' && typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
