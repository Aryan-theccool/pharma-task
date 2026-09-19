-- =====================================================================
-- Analytics: materialized views refreshed hourly by a worker job so that
-- heavy aggregates never run on the OLTP request path.
-- =====================================================================

DROP MATERIALIZED VIEW IF EXISTS mv_doctor_utilization;
DROP MATERIALIZED VIEW IF EXISTS mv_daily_kpis;

CREATE MATERIALIZED VIEW mv_daily_kpis AS
SELECT
  date_trunc('day', c.scheduled_at)                               AS day,
  count(*)                                                        AS consultations_total,
  count(*) FILTER (WHERE c.status = 'completed')                  AS completed,
  count(*) FILTER (WHERE c.status = 'cancelled')                  AS cancelled,
  count(*) FILTER (WHERE c.status = 'no_show')                    AS no_show,
  count(DISTINCT c.patient_id)                                    AS unique_patients,
  count(DISTINCT c.doctor_id)                                     AS active_doctors,
  coalesce(sum(c.amount) FILTER (WHERE c.status = 'completed'), 0) AS revenue
FROM consultations c
GROUP BY 1;

CREATE UNIQUE INDEX mv_daily_kpis_day_idx ON mv_daily_kpis (day);

CREATE MATERIALIZED VIEW mv_doctor_utilization AS
SELECT
  d.id                                                            AS doctor_id,
  d.display_name,
  count(s.id)                                                     AS slots_total,
  count(s.id) FILTER (WHERE s.status = 'booked')                  AS slots_booked,
  CASE WHEN count(s.id) = 0 THEN 0
       ELSE round(100.0 * count(s.id) FILTER (WHERE s.status = 'booked') / count(s.id), 2)
  END                                                             AS utilization_pct,
  d.rating_avg,
  d.rating_count
FROM doctors d
LEFT JOIN availability_slots s ON s.doctor_id = d.id
GROUP BY d.id, d.display_name, d.rating_avg, d.rating_count;

CREATE UNIQUE INDEX mv_doctor_utilization_idx ON mv_doctor_utilization (doctor_id);
