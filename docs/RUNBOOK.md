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

## rate-limiter-failing-open

**Alerts:** `RateLimiterFailingOpen` (critical, `rate_limit_enforcing == 0`) and
`RateLimiterFailOpenBurst` (warning, sustained `rate_limit_fail_open_total`
growth).

**What it means:** the rate limiter cannot reach Redis and is **allowing every
request through unthrottled**. The API is up; the protection in front of it is
not. Brute-force lockout, per-IP auth throttling and abuse limits are all
inert for as long as this lasts.

This is a deliberate trade-off — availability over throttling — and it is the
right default for a clinical platform. What is *not* acceptable is it happening
quietly, which is why these alerts exist.

1. **Confirm scope.** One task or all of them?
   ```
   sum by (task) (rate_limit_enforcing)
   ```
   A single task means a network partition for that task; zero across the fleet
   means ElastiCache itself.
2. **Check the cluster:**
   ```bash
   aws elasticache describe-replication-groups --replication-group-id amrutam-prod \
     --query 'ReplicationGroups[0].{Status:Status,Nodes:MemberClusters}'
   ```
   Also check `CPUUtilization`, `DatabaseMemoryUsagePercentage` and `Evictions`
   in CloudWatch — memory pressure presents as timeouts before it presents as
   an outage.
3. **Assess exposure while unprotected.** The limiter is one layer; the WAF
   rate limit is still active and account lockout is enforced in Postgres, so
   credential stuffing is bounded even now. Check for abuse during the window:
   ```
   fields @timestamp, req.remoteAddress, path
   | filter status = 401 or status = 429
   | stats count() by req.remoteAddress | sort count desc | limit 20
   ```
4. **Tighten the WAF** if the outage will be prolonged and traffic looks
   abusive — it is the only remaining throttle:
   ```bash
   aws wafv2 update-web-acl --name amrutam-prod --scope REGIONAL --id <id> \
     --lock-token <token> --rules file://waf-strict-rate-rules.json
   ```
5. **Recovery is automatic.** ioredis reconnects in the background and the
   guard flips `rate_limit_enforcing` back to 1 on the first successful command
   — no deploy or restart. Confirm:
   ```
   min(rate_limit_enforcing)        # expect 1
   rate(rate_limit_fail_open_total[5m])   # expect 0
   ```

**Do not "fix" this by making the limiter fail closed.** A Redis blip would
then return 429 to every caller, including clinicians mid-consultation. The
failure mode is intentional; the alert is the control.

**Related, opposite polarity:** `auth_denylist_unavailable_total` counts
requests *rejected* (503) because the session-revocation denylist was
unreachable. That check fails **closed** on purpose — an unreadable denylist
cannot prove a session was not revoked, and a revoked session is precisely what
an attacker replays. If you see both metrics moving together, Redis is down and
the system is correctly erring in opposite directions for the two cases:
admitting unthrottled traffic, refusing unverifiable sessions.

**Why a Redis outage no longer hangs the API:** the request-path client is
configured with `commandTimeout`, bounded `maxRetriesPerRequest` and
`enableOfflineQueue: false`. Before that, commands queued indefinitely, so the
fail-open path was unreachable and requests hung until the client gave up —
`/healthz` included. If you ever see request latency climb to tens of seconds
during a Redis incident rather than these alerts firing, check that those
options are still set in `src/infra/redis.service.ts`. The BullMQ connections
deliberately keep `maxRetriesPerRequest: null`; blocking queue commands are
supposed to wait.

---

## clinical-integrity-violation

**Alert:** `ClinicalIntegrityViolation` · **Severity:** critical · page immediately

Clinical data was modified by something that is not this application. Treat as
a confirmed breach until you have proven otherwise.

**Do not** start by "fixing" the data. The rows are evidence.

1. **Get the report.**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.amrutam.example/api/v1/admin/integrity/verify | jq
   ```
   Each finding names `table`, `rowId`, `dbUser` and `clientAddr`.

2. **Read the finding kind — it tells you what happened.**

   | Kind | Meaning |
   | --- | --- |
   | `unattributed_write` | Someone wrote using a direct database session |
   | `divergent_row` | A row was changed with the capture trigger disabled |
   | `unjournaled_row` | A row was inserted while protection was off |
   | `vanished_row` | A row was deleted while protection was off |
   | `forged_journal_entry` | The journal itself was edited |
   | `checkpoint_mismatch` | Journal entries were deleted |
   | `protection_disabled` | A trigger is off **right now** — fix first |

3. **Get the per-row timeline.**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     ".../api/v1/admin/integrity/history/consultations/$ROW_ID" | jq
   ```
   `attributed: false` entries are the intruder's. `dbUser`, `clientAddr` and
   `transactionId` are your pivot points into the Postgres and CloudTrail logs.

4. **Contain.** Rotate the database credential the attacker used. If
   `INTEGRITY_PROOF_KEY` may itself be exposed (the finding says
   `failed verification` rather than absent), rotate that too — a valid-looking
   proof means they tried to forge attribution.

5. **Scope it.** Correlate `transactionId` in Postgres logs to find every other
   statement in the same transaction. One reported row is rarely the only one.

6. **Only then restore.** Use a PITR restore to just before the offending
   transaction. Re-run the sweep afterwards and confirm `ok: true`.

7. **Notify.** Altered clinical records are reportable under most health-data
   regimes. Involve the DPO before the clock starts.

If `protection_disabled` is the only finding, re-enable it immediately —
detection is blind until you do:

```sql
ALTER TABLE consultations ENABLE TRIGGER clinical_integrity_consultations;
```

---

## stuck-sagas

**Alerts:** `SagasStuck` (warning) · `SagaDeadLettered` (critical)

A saga is mid-flight with no process driving it — usually a pod killed between
steps. The reconciler runs every minute and normally clears these unaided.

**`SagasStuck` firing for 10+ minutes** means recovery is failing, not pending.

1. Force a pass and read the result:
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.amrutam.example/api/v1/admin/integrity/reconcile-sagas | jq
   ```
2. If `recovered` stays at 0, check `last_error` on the saga rows:
   ```sql
   SELECT id, type, step, recovery_attempts, last_error
     FROM saga_instances
    WHERE state IN ('running','compensating')
      AND updated_at < now() - interval '5 minutes';
   ```
   A repeated payment-provider error usually means the circuit breaker is open —
   see [circuit-breaker](#circuit-breaker) first.

**`SagaDeadLettered`** means the reconciler gave up. Each entry is money or
inventory in an indeterminate state and needs a decision.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.amrutam.example/api/v1/admin/integrity/saga-dead-letters | jq
```

For each one, establish the true state before acting:

```sql
-- Did the consultation get created?
SELECT id, status FROM consultations WHERE slot_id = '<slotId>';
-- What happened to the money?
SELECT id, status, amount, refunded_amount FROM payments WHERE booking_ref = '<bookingRef>';
-- Is the slot still held?
SELECT id, status, held_until FROM availability_slots WHERE id = '<slotId>';
```

Then resolve in the patient's favour:

- **Payment captured, no consultation** → refund, release the slot, apologise.
- **Consultation exists, payment not captured** → capture, or honour the
  consultation and write it off. Never cancel on the patient silently.
- **Neither** → release the slot; nothing else to do.

Mark it resolved so it stops paging:

```sql
UPDATE saga_instances
   SET state = 'compensated', recovered_at = now(),
       last_error = 'manually resolved: <ticket>'
 WHERE id = '<sagaId>';
```

---

## Common procedures

### Going live with a real PSP

The Razorpay adapter is contract-tested but has never spoken to Razorpay. Before
taking real money:

1. Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
   `RAZORPAY_WEBHOOK_SECRET` from Secrets Manager. (The app refuses to boot with
   `PAYMENT_PROVIDER=mock` when `NODE_ENV=production`.)
2. Against their **sandbox**, verify each verb end to end: authorize, capture,
   void an uncaptured authorization, full refund, partial refund.
3. Replay a request with the same `X-Razorpay-Idempotency` value and confirm the
   provider returns the original charge rather than creating a second one. This
   is the one that prevents double-charging on retry.
4. Point a webhook at `/api/v1/payments/webhook` and confirm: a valid signature
   is accepted, a tampered body is rejected with 403, and a replayed event is
   deduplicated rather than double-applied.
5. Force a 5xx from the sandbox and confirm the circuit breaker opens and the
   saga compensates cleanly.
6. Reconcile a day of sandbox traffic against `payments` before switching DNS.


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
