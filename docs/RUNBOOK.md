# Runbook

Operational procedures for the alerts in `observability/alerts.yml`. Each alert
annotation links to a section here by anchor.

**Before anything else:** check the Grafana "Amrutam — Service Overview"
dashboard. The SLO row shows immediately whether this is a latency problem, an
error problem, or neither.

---

## read-latency

**Alert:** `ReadLatencySLOBreach` — p95 GET above 200 ms for 10 minutes.

1. **Is it one route or all of them?** Dashboard → "Slowest routes (p95)". A
   single route points at a query or a cache; all routes point at saturation.
2. **Check the cache hit ratio panel.** A collapse from ~99% means Redis is
   evicting or was flushed — every request is now hitting Postgres.
   ```
   redis-cli INFO stats | grep evicted_keys
   redis-cli INFO memory | grep used_memory_human
   ```
   If `evicted_keys` is climbing, the node is undersized → scale the
   replication group node type.
3. **Check `db_pool_waiting`.** Above zero means requests are queueing for a
   connection; the database, not the app, is the constraint.
4. **Check RDS Performance Insights** for the top wait event. `IO:DataFileRead`
   suggests a missing index or a cold cache; `Lock:transactionid` suggests
   contention.
5. **Mitigation:** scale API tasks (autoscaling should already be doing this —
   confirm it is not at `api_max_capacity`), then scale the RDS instance class
   if the database is the bottleneck.

---

## write-latency

**Alert:** `WriteLatencySLOBreach` — p95 writes above 500 ms.

1. **Check "Booking duration by stage".** If `confirm` is slow but `hold` is
   not, the payment provider is the cause — check `circuit_breaker_state`.
2. **Check `db_transaction_retries_total`.** Elevated retries mean
   serialisation failures under contention.
3. **Check for long-running transactions:**
   ```sql
   SELECT pid, now() - xact_start AS duration, state, left(query, 120)
   FROM pg_stat_activity
   WHERE xact_start IS NOT NULL AND now() - xact_start > interval '5 seconds'
   ORDER BY duration DESC;
   ```
4. An idle-in-transaction session blocks vacuum and holds locks.
   `idle_in_transaction_session_timeout` is 60 s, so these should self-clear;
   if they do not, the parameter group is not applied.

---

## elevated-5xx

**Alert:** `ErrorBudgetBurnFast` — 5xx rate burning the monthly budget 14× too fast.

**This is a page.** At this rate the 21.9 min/month budget is gone in under two days.

1. **Was there a deploy in the last 30 minutes?**
   ```bash
   aws ecs describe-services --cluster amrutam-prod --services amrutam-prod-api \
     --query 'services[0].deployments'
   ```
   If yes and the circuit breaker has not already rolled back, roll back now:
   ```bash
   aws ecs update-service --cluster amrutam-prod --service amrutam-prod-api \
     --task-definition <previous-revision> --force-new-deployment
   ```
2. **Are all tasks unhealthy, or some?** `UnHealthyHostCount` alarm plus the
   target group health. Some → a bad task; all → a shared dependency.
3. **Check `/readyz` from inside the VPC.** It reports which dependency failed.
4. **Check the logs for the dominant error:**
   ```
   fields @timestamp, status, path, msg
   | filter status >= 500
   | stats count() by path, msg
   | sort count desc
   ```

---

## booking-conflicts

**Alert:** `BookingConflictSpike` — more than 25% of hold attempts conflicting.

This is often **correct behaviour** — popular doctors genuinely have contended
slots. Confirm it is not something else:

1. **Check the defence breakdown** on "Conflicts by defence layer".
   - Mostly `redis_lock` → normal contention, working as designed.
   - Significant `row_lock` or `db_constraint` → the Redis lock is not doing
     its job. Check Redis health; this is the real signal.
2. **Check whether holds are expiring correctly.** Abandoned holds that never
   expire make slots permanently unavailable:
   ```sql
   SELECT count(*) FROM availability_slots
   WHERE status = 'held' AND hold_expires_at < now();
   ```
   A non-zero count means the expiry sweep is not running — check the worker.
3. **Possible abuse:** see the slot-squatting case in
   [THREAT_MODEL.md](THREAT_MODEL.md#4-domain-specific-abuse-cases). Check for
   one user id holding many slots.

---

## saga-compensations

**Alert:** `SagaCompensationsElevated` — bookings rolling back.

**This is a page: money is being authorised and reversed.**

1. **Which step is failing?** `saga_compensations_total{step}`.
   - `authorize_payment` → provider rejecting; check `circuit_breaker_state`
     and the provider's status page.
   - `create_consultation` → a database problem; the payment was authorised
     and then voided, so patients saw a failure after being charged-then-refunded.
   - `capture_payment` → the worst case: the consultation exists and capture
     failed. Verify the refund actually completed.
2. **Find affected users:**
   ```sql
   SELECT id, saga_type, current_step, status, created_at, last_error
   FROM saga_instances
   WHERE status IN ('compensating', 'compensated', 'failed')
     AND created_at > now() - interval '1 hour'
   ORDER BY created_at DESC;
   ```
3. **Check for stuck sagas** — non-terminal and old. There is currently **no
   automatic reconciler** ([ADR-0004](adr/0004-saga-vs-2pc.md)), so these need
   manual resolution:
   ```sql
   SELECT * FROM saga_instances
   WHERE status = 'running' AND created_at < now() - interval '10 minutes';
   ```
4. Reconcile each against the payment provider's dashboard before deciding
   whether to refund or complete manually.

---

## outbox-backlog

**Alert:** `OutboxBacklogGrowing` — more than 500 pending events.

Notifications and PDFs are lagging. No data is lost — the outbox is durable —
but users are not being told things.

1. **Is the worker running?**
   ```bash
   aws ecs describe-services --cluster amrutam-prod --services amrutam-prod-worker \
     --query 'services[0].runningCount'
   ```
2. **Is it failing to drain?** Check worker logs for repeated errors on the
   same event, and look at `attempts`:
   ```sql
   SELECT event_type, count(*), max(attempts) AS max_attempts
   FROM outbox WHERE published_at IS NULL GROUP BY event_type ORDER BY 2 DESC;
   ```
   Backoff is `least(power(2, attempts+1), 300)` seconds, so a poison event
   retries at most every 5 minutes rather than blocking the queue.
3. **A poison event** (high `attempts`, same id) should be moved aside:
   ```sql
   UPDATE outbox SET published_at = now(), notes = 'quarantined: <reason>'
   WHERE id = '<uuid>';
   ```
   Record it — this is data loss for that notification.
4. **Scale workers** if the backlog is volume rather than failure.

---

## circuit-breaker

**Alert:** `CircuitBreakerOpen` — a downstream dependency is failing.

1. `circuit_breaker_state`: 0 closed, 1 half-open, 2 open.
2. For the payment breaker: check the provider's status page. While open,
   bookings fail fast and compensate cleanly — patients see an honest error
   rather than a hang. **This is the breaker working.**
3. Do not force it closed. It will probe (half-open) and recover on its own.
4. If the provider is down for an extended period, consider a maintenance
   banner; booking is unavailable but consultations, prescriptions and all
   read paths continue to work.

---

## pool-saturation

**Alert:** `ConnectionPoolSaturated` — `db_pool_waiting > 5`.

1. **Total connections versus `max_connections`:**
   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   SHOW max_connections;
   ```
2. **Tasks × pool size must stay under `max_connections`.** 30 tasks × 20 =
   600 connections; verify the RDS instance class supports that. This is the
   constraint that eventually forces PgBouncer.
3. **Short term:** reduce `api_max_capacity` or the per-task pool size.
4. **Long term:** PgBouncer in transaction-pooling mode.

---

## auth-failure-spike

**Alert:** `AuthFailureSpike` — more than 10 failed logins/second.

1. **Distinguish credential stuffing from an outage.** If *successes* also
   dropped to zero, authentication is broken — check the database and the JWT
   secret. If successes are normal and failures spiked, it is an attack.
2. **Find the source:**
   ```
   fields @timestamp, req.remoteAddress, req.headers.user-agent
   | filter path = "/api/v1/auth/login" and status = 401
   | stats count() by req.remoteAddress | sort count desc | limit 20
   ```
3. **Block at the WAF** if concentrated:
   ```bash
   aws wafv2 update-ip-set --name amrutam-prod-blocklist --scope REGIONAL \
     --id <id> --addresses 203.0.113.0/24 --lock-token <token>
   ```
4. Account lockout (5 per 15 min) already limits per-account damage. A
   distributed attack across many accounts is the harder case — consider
   temporarily lowering the WAF rate limit.
5. **Afterwards:** check for any *successful* logins from the attacking IPs.
   Those accounts are compromised and their token families must be revoked.

---

## Common procedures

### Verify the audit chain

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.amrutam.example/api/v1/admin/audit-logs/verify
```

`{"verified": false, "brokenAtId": N}` means the chain broke at entry N.
**Treat as a security incident**: preserve the database, take a snapshot, and
compare against the last known-good offsite hash before changing anything.

### Rotate the field-encryption key

```bash
aws ecs run-task --cluster amrutam-prod --task-definition amrutam-prod-api \
  --launch-type FARGATE --network-configuration "..." \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/scripts/rotate-keys.js"]}]}'
```

Adds a new `key_version`. Existing ciphertext stays readable under its own
version — no re-encryption, no downtime.

### Emergency scale-up

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/amrutam-prod/amrutam-prod-api \
  --min-capacity 10 --max-capacity 50
```

Remember to set it back.

### Break-glass shell access

Disabled in production by default. Enable deliberately, use, then disable —
every session is recorded to CloudWatch and CloudTrail.

```bash
terraform -chdir=infra/terraform/envs/prod apply -var enable_exec=true
aws ecs execute-command --cluster amrutam-prod --task <id> \
  --container api --interactive --command "/bin/sh"
```
