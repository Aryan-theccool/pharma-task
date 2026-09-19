import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import type { CreateAvailabilityRuleDto } from '../doctors/dto/doctors.dto';

export interface SlotRow {
  id: string;
  doctor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  held_until: Date | null;
}

/**
 * Availability: recurring rules -> materialised concrete slots.
 *
 * Timezone correctness: rules are authored in the doctor's local wall-clock
 * time ("every Monday 09:00-13:00 Asia/Kolkata") but slots are stored as
 * absolute UTC `tstzrange`. Materialisation walks each local calendar day via
 * Luxon, so DST transitions and offset changes produce the times a human
 * expects rather than drifting by an hour.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async createRule(doctorId: string, dto: CreateAvailabilityRuleDto) {
    const timezone = dto.timezone ?? 'Asia/Kolkata';
    if (!DateTime.local().setZone(timezone).isValid) {
      throw new BadRequestException({ title: `Unknown timezone: ${timezone}` });
    }
    if (dto.endTime <= dto.startTime) {
      throw new BadRequestException({ title: 'endTime must be after startTime' });
    }

    const res = await this.db.query(
      `INSERT INTO availability_rules
         (doctor_id, day_of_week, start_time, end_time, slot_minutes, valid_from, valid_to, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, doctor_id, day_of_week, start_time, end_time, slot_minutes,
                 valid_from, valid_to, timezone, active`,
      [
        doctorId,
        dto.dayOfWeek,
        dto.startTime,
        dto.endTime,
        dto.slotMinutes ?? 30,
        dto.validFrom,
        dto.validTo ?? null,
        timezone,
      ],
    );
    return res.rows[0];
  }

  async listRules(doctorId: string) {
    const res = await this.db.queryReplica(
      `SELECT id, day_of_week, start_time, end_time, slot_minutes, valid_from, valid_to, timezone, active
         FROM availability_rules WHERE doctor_id = $1 AND active = true ORDER BY day_of_week, start_time`,
      [doctorId],
    );
    return res.rows;
  }

  async deleteRule(doctorId: string, ruleId: string) {
    const res = await this.db.query(
      `UPDATE availability_rules SET active = false WHERE id = $1 AND doctor_id = $2 RETURNING id`,
      [ruleId, doctorId],
    );
    if (!res.rowCount) throw new NotFoundException({ title: 'Availability rule not found' });
  }

  /**
   * Expand active rules into concrete slots for `days` calendar days from
   * `fromDate`. Existing slots are left untouched — the EXCLUDE constraint
   * rejects overlaps, and we swallow that specific error so re-running the
   * materialiser is idempotent.
   */
  async materialize(doctorId: string, fromDate: string, days: number): Promise<{ created: number }> {
    const rules = await this.db.query<{
      day_of_week: number;
      start_time: string;
      end_time: string;
      slot_minutes: number;
      valid_from: Date;
      valid_to: Date | null;
      timezone: string;
    }>(
      `SELECT day_of_week, start_time, end_time, slot_minutes, valid_from, valid_to, timezone
         FROM availability_rules WHERE doctor_id = $1 AND active = true`,
      [doctorId],
    );
    if (!rules.rowCount) return { created: 0 };

    let created = 0;

    for (const rule of rules.rows) {
      const zone = rule.timezone;
      const start = DateTime.fromISO(fromDate, { zone });
      if (!start.isValid) throw new BadRequestException({ title: 'Invalid `from` date' });

      for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const day = start.plus({ days: dayOffset });
        // Luxon weekday: 1=Mon..7=Sun. Our schema: 0=Sun..6=Sat.
        const dow = day.weekday === 7 ? 0 : day.weekday;
        if (dow !== rule.day_of_week) continue;

        const validFrom = DateTime.fromJSDate(rule.valid_from, { zone }).startOf('day');
        const validTo = rule.valid_to
          ? DateTime.fromJSDate(rule.valid_to, { zone }).endOf('day')
          : null;
        if (day < validFrom.startOf('day')) continue;
        if (validTo && day > validTo) continue;

        const [sh, sm] = rule.start_time.split(':').map(Number);
        const [eh, em] = rule.end_time.split(':').map(Number);
        let cursor = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
        const dayEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

        while (cursor < dayEnd) {
          const slotEnd = cursor.plus({ minutes: rule.slot_minutes });
          if (slotEnd > dayEnd) break;
          // Never materialise a slot in the past.
          if (slotEnd > DateTime.utc()) {
            const inserted = await this.insertSlot(doctorId, cursor.toUTC(), slotEnd.toUTC());
            if (inserted) created++;
          }
          cursor = slotEnd;
        }
      }
    }

    if (created) await this.invalidateSlotCache(doctorId);
    this.logger.log(`materialised ${created} slots for doctor ${doctorId}`);
    return { created };
  }

  private async insertSlot(doctorId: string, from: DateTime, to: DateTime): Promise<boolean> {
    try {
      const res = await this.db.query(
        `INSERT INTO availability_slots (doctor_id, slot_range)
         VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'))
         RETURNING id`,
        [doctorId, from.toISO(), to.toISO()],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (error) {
      // 23P01 = exclusion violation: the slot already exists. Idempotent.
      if ((error as { code?: string }).code === '23P01') return false;
      throw error;
    }
  }

  /** Public slot listing, cached for 30s and invalidated on any state change. */
  async listSlots(doctorId: string, from: string, to: string, status?: string) {
    const cacheKey = `slots:${doctorId}:${from}:${to}:${status ?? 'any'}`;
    return this.redis.cached(cacheKey, 30, async () => {
      const params: unknown[] = [doctorId, from, to];
      let statusClause = '';
      if (status) {
        params.push(status);
        statusClause = `AND status = $${params.length}`;
      }
      const res = await this.db.queryReplica<{
        id: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
      }>(
        `SELECT id, lower(slot_range) AS starts_at, upper(slot_range) AS ends_at, status
           FROM availability_slots
          WHERE doctor_id = $1
            AND slot_range && tstzrange($2::timestamptz, $3::timestamptz, '[)')
            ${statusClause}
          ORDER BY lower(slot_range)
          LIMIT 1000`,
        params,
      );
      return res.rows.map((r) => ({
        id: r.id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
      }));
    });
  }

  /** Doctor blocks a window (leave). Any free slot inside it becomes blocked. */
  async blockRange(doctorId: string, from: string, to: string): Promise<{ blocked: number }> {
    const res = await this.db.query(
      `UPDATE availability_slots
          SET status = 'blocked', updated_at = now(), version = version + 1
        WHERE doctor_id = $1
          AND status = 'available'
          AND slot_range <@ tstzrange($2::timestamptz, $3::timestamptz, '[]')`,
      [doctorId, from, to],
    );
    await this.invalidateSlotCache(doctorId);
    return { blocked: res.rowCount ?? 0 };
  }

  async invalidateSlotCache(doctorId: string): Promise<void> {
    await this.redis.delByPattern(`slots:${doctorId}:*`);
  }

  /**
   * Release holds whose TTL elapsed. Run every 30s by a repeatable job; also
   * safe to call inline before a booking attempt.
   */
  async releaseExpiredHolds(): Promise<number> {
    const res = await this.db.query<{ doctor_id: string }>(
      `UPDATE availability_slots
          SET status = 'available', hold_token = NULL, held_by = NULL, held_until = NULL,
              version = version + 1, updated_at = now()
        WHERE status = 'held' AND held_until < now()
        RETURNING doctor_id`,
    );
    const doctors = new Set(res.rows.map((r) => r.doctor_id));
    for (const id of doctors) await this.invalidateSlotCache(id);
    if (res.rowCount) this.logger.log(`released ${res.rowCount} expired holds`);
    return res.rowCount ?? 0;
  }
}
