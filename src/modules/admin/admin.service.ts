import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';

/**
 * Admin analytics.
 *
 * Every aggregate reads from an hourly-refreshed materialized view or the read
 * replica — heavy GROUP BY never runs on the OLTP write path. Results are
 * additionally cached in Redis for 60s to absorb dashboard refresh storms.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async overview() {
    return this.redis.cached('admin:overview', 60, async () => {
      const [totals, today, pipeline] = await Promise.all([
        this.db.queryReplica<{ users: string; doctors: string; consultations: string }>(
          `SELECT (SELECT count(*) FROM users)          AS users,
                  (SELECT count(*) FROM doctors)        AS doctors,
                  (SELECT count(*) FROM consultations)  AS consultations`,
        ),
        this.db.queryReplica<{ booked: string; revenue: string }>(
          `SELECT count(*) AS booked,
                  coalesce(sum(amount),0) AS revenue
             FROM consultations
            WHERE scheduled_at >= date_trunc('day', now())`,
        ),
        this.db.queryReplica<{ status: string; count: string }>(
          `SELECT status, count(*) AS count FROM consultations GROUP BY status`,
        ),
      ]);

      return {
        totals: {
          users: Number(totals.rows[0].users),
          doctors: Number(totals.rows[0].doctors),
          consultations: Number(totals.rows[0].consultations),
        },
        today: {
          booked: Number(today.rows[0].booked),
          revenue: Number(today.rows[0].revenue),
        },
        byStatus: Object.fromEntries(pipeline.rows.map((r) => [r.status, Number(r.count)])),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async revenue(days = 30) {
    return this.redis.cached(`admin:revenue:${days}`, 300, async () => {
      const res = await this.db.queryReplica<{
        day: Date;
        consultations_total: string;
        completed: string;
        revenue: string;
      }>(
        `SELECT day, consultations_total, completed, revenue
           FROM mv_daily_kpis
          WHERE day >= date_trunc('day', now()) - ($1 || ' days')::interval
          ORDER BY day DESC`,
        [String(days)],
      );
      return {
        source: 'mv_daily_kpis (materialized view, refreshed hourly)',
        series: res.rows.map((r) => ({
          day: r.day,
          consultations: Number(r.consultations_total),
          completed: Number(r.completed),
          revenue: Number(r.revenue),
        })),
      };
    });
  }

  async doctorUtilization(limit = 20) {
    return this.redis.cached(`admin:utilization:${limit}`, 300, async () => {
      const res = await this.db.queryReplica<{
        doctor_id: string;
        display_name: string;
        slots_total: string;
        slots_booked: string;
        utilization_pct: string;
        rating_avg: string;
      }>(
        `SELECT doctor_id, display_name, slots_total, slots_booked, utilization_pct, rating_avg
           FROM mv_doctor_utilization
          ORDER BY utilization_pct DESC, slots_booked DESC
          LIMIT $1`,
        [limit],
      );
      return {
        source: 'mv_doctor_utilization (materialized view, refreshed hourly)',
        items: res.rows.map((r) => ({
          doctorId: r.doctor_id,
          displayName: r.display_name,
          slotsTotal: Number(r.slots_total),
          slotsBooked: Number(r.slots_booked),
          utilizationPct: Number(r.utilization_pct),
          ratingAvg: Number(r.rating_avg),
        })),
      };
    });
  }

  /** Conversion funnel: hold → confirm → complete. */
  async funnel(days = 7) {
    return this.redis.cached(`admin:funnel:${days}`, 120, async () => {
      const res = await this.db.queryReplica<{
        holds: string;
        booked: string;
        completed: string;
        cancelled: string;
        no_show: string;
      }>(
        `SELECT
           (SELECT count(*) FROM audit_logs
             WHERE action = 'booking.hold'
               AND occurred_at >= now() - ($1 || ' days')::interval)                 AS holds,
           (SELECT count(*) FROM consultations
             WHERE created_at >= now() - ($1 || ' days')::interval)                  AS booked,
           (SELECT count(*) FROM consultations
             WHERE status='completed' AND created_at >= now() - ($1 || ' days')::interval) AS completed,
           (SELECT count(*) FROM consultations
             WHERE status='cancelled' AND created_at >= now() - ($1 || ' days')::interval) AS cancelled,
           (SELECT count(*) FROM consultations
             WHERE status='no_show'  AND created_at >= now() - ($1 || ' days')::interval)  AS no_show`,
        [String(days)],
      );
      const r = res.rows[0];
      const holds = Number(r.holds);
      const booked = Number(r.booked);
      const completed = Number(r.completed);
      return {
        windowDays: days,
        stages: {
          holds,
          booked,
          completed,
          cancelled: Number(r.cancelled),
          noShow: Number(r.no_show),
        },
        conversion: {
          holdToBooking: holds ? Number(((booked / holds) * 100).toFixed(2)) : 0,
          bookingToCompletion: booked ? Number(((completed / booked) * 100).toFixed(2)) : 0,
        },
      };
    });
  }

  /** Refreshed by the hourly worker job; CONCURRENTLY so readers never block. */
  async refreshMaterializedViews(): Promise<void> {
    for (const view of ['mv_daily_kpis', 'mv_doctor_utilization']) {
      try {
        await this.db.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      } catch {
        // CONCURRENTLY needs a prior non-concurrent populate.
        await this.db.query(`REFRESH MATERIALIZED VIEW ${view}`);
      }
    }
    this.logger.log('analytics materialized views refreshed');
  }
}
