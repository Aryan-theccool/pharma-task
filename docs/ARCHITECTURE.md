# Architecture — Amrutam Telemedicine Backend

> Target: 100,000 consultations/day · p95 < 200 ms reads, < 500 ms writes ·
> 99.95% availability · PHI under HIPAA-aligned controls.

---

## 1. Context and shape

A telemedicine platform is a **booking system that happens to carry medical
data**. That framing drives every decision below: the hard parts are not CRUD
endpoints, they are (a) never double-booking a doctor, (b) never
double-charging a patient, and (c) never leaking or silently altering a
clinical record.

A modular monolith on Node/NestJS, deployed as two process roles from one
image:

```
                      ┌──────────┐
   Internet ─── WAF ──│   ALB    │── TLS 1.3 termination
                      └────┬─────┘
                           │  (private subnets)
              ┌────────────┴────────────┐
              │                         │
        ┌─────▼─────┐             ┌─────▼──────┐
        │ API tasks │             │  Workers   │   same image,
        │  (3–30)   │             │   (2–20)   │   different command
        └─────┬─────┘             └─────┬──────┘
              │                         │
      ┌───────┴─────────┬───────────────┴───────┐
      │                 │                       │
┌─────▼──────┐   ┌──────▼──────┐        ┌───────▼───────┐
│ PostgreSQL │   │    Redis    │        │      S3       │
│  16 Multi- │   │  locks,     │        │  prescription │
│  AZ + RO   │   │  idempotency│        │     PDFs      │
│  replica   │   │  queues,    │        └───────────────┘
└────────────┘   │  cache      │
  (isolated      └─────────────┘
   subnets, no NAT route)
```

**Why a modular monolith, not microservices.** Booking, payment and
consultation state change **together**. Across services that needs distributed
transactions; inside one database it is a single `BEGIN…COMMIT`. At 100k
consultations/day (~12 bookings/s at peak) there is no throughput argument for
splitting, and splitting would trade a solved problem (ACID) for an unsolved
one (eventual consistency in a system that charges money). The code is
organised into 11 feature modules with explicit boundaries, so extraction
later is mechanical if it is ever justified. See
[ADR-0001](adr/0001-modular-monolith.md).

**Why API and worker split.** Same image, different command. A burst of PDF
rendering must not steal CPU from p95-sensitive reads, and the two scale on
different signals — requests/target versus queue depth.

| Layer | Choice | Reasoning |
| --- | --- | --- |
| Runtime | Node 20, TypeScript strict | I/O-bound workload; one language across API and workers |
| Framework | NestJS 10 | DI and guard/interceptor pipeline make cross-cutting concerns (authz, idempotency, audit) declarative rather than copy-pasted |
| Database | PostgreSQL 16 | Exclusion constraints, partitioning, `FOR UPDATE NOWAIT`, full-text search — the booking correctness story depends on all four |
| Data access | Drizzle ORM + `pg` | Typed queries without hiding SQL; the concurrency work needs exact control over lock syntax |
| Cache/locks | Redis 7 | Locks, idempotency claims, rate-limit windows, BullMQ queues, audit chain head |
| Queue | BullMQ | Redis-backed, retries with exponential backoff, no extra broker to operate |

---

## 2. Data model

Eight core tables from the brief plus the machinery correctness requires:

```
users ──1:1── profiles                    identity, encrypted PII
  │
  ├──1:1── doctors ──1:n── availability_rules  (recurring schedule)
  │                    └──1:n── availability_slots  (materialised instances)
  │
  └──1:n── consultations ──1:n── prescriptions
                │          └──1:1── payments
                │
              audit_logs   (hash-chained, append-only)

supporting: refresh_tokens · mfa_recovery_codes · idempotency_keys ·
            outbox · saga_instances · processed_events ·
            payment_webhook_events · notifications · encryption_keys · reviews
```

23 tables, 38 indexes, 2 materialised views.

Three schema decisions carry most of the weight:

**Monthly RANGE partitioning on `consultations` and `audit_logs`.** These are
the only unbounded-growth tables — at 100k/day, `consultations` gains ~36M
rows/year. Partitioning keeps index depth constant, makes the 7-year retention
policy a `DETACH PARTITION` instead of a multi-hour `DELETE`, and lets
analytics prune to a date range. Two PG16 constraints shaped the DDL: a unique
index on a partitioned table must include the partition key
(`consultations_slot_unique (slot_id, scheduled_at)`), and a STORED generated
column needs an IMMUTABLE function, so the search vector pins
`'simple'::regconfig` explicitly.

**A GiST exclusion constraint on `availability_slots`.** Overlapping slots for
one doctor are rejected by the database itself, not by application logic. See
§3.

**PHI is encrypted at the column level**, not just at rest. `profiles`
and `prescriptions` store `bytea` ciphertext with a `key_version` prefix.
Storage encryption protects against a stolen disk; it does nothing against a
leaked database credential. Field encryption does.

---

## 3. The booking flow — the core problem

Two patients tap "book" on the same 09:00 slot at the same instant. Exactly
one must win, the loser must get a clean 409, and neither may be charged for a
consultation that does not exist.

### Triple defence against double-booking

```
1. Redis lock     SET lock:slot:{id} NX PX 5000      → 409 defence="redis_lock"
2. Row lock       SELECT … FOR UPDATE NOWAIT         → 55P03 → 409 "row_lock"
3. DB constraint  GiST EXCLUDE + partial UNIQUE      → 23P01/23505 → 409 "db_constraint"
```

Three layers because each fails differently. Redis is fast but can lose a lock
to a failover or an expiry mid-transaction. The row lock is authoritative but
only within one transaction. The constraint is absolute but the most expensive
to reach. Ordering them cheap-to-expensive means contention is usually
resolved without touching Postgres at all.

**Measured under load** (`load/README.md`): 19,912 concurrent attempts on a
single slot produced **exactly 1 booking and 19,911 clean 409s**, with 93% of
conflicts absorbed by the Redis lock before reaching the database. The metric
`booking_conflicts_total{defence}` reports which layer caught each one, so the
lower layers firing is an observable signal that something upstream broke.

### Hold → confirm saga

Booking is two steps, not one: a patient holds a slot (5 min TTL) and then
confirms with payment. The confirm runs as a saga with explicit compensations:

```
validate_hold → authorize_payment → create_consultation → capture_payment
                      │                      │                   │
                 void_payment        cancel_consultation    refund_payment
                      └──────── reverse order on failure ─────────┘
```

Local ACID transactions plus compensations, not 2PC: the payment provider is a
third party that cannot join our transaction, so a distributed commit protocol
is not available regardless. See [ADR-0004](adr/0004-saga-vs-2pc.md).

A saga abandoned by a *crashed process* cannot compensate itself — the catch
block never runs. A reconciler sweeps every minute, claims stale sagas with
`FOR UPDATE SKIP LOCKED`, replays their recorded compensations in reverse, and
dead-letters whatever it cannot fix rather than retrying forever. It rolls
back rather than forward: charging a patient for a consultation nobody told
them about is worse than refunding one who wanted it.
See [ADR-0011](adr/0011-saga-recovery.md).

A subtle bug the tests caught: the losing racer's compensation was releasing
the *winner's* hold, because the compensation scoped its release by
`hold_token` and all racers shared one token. Fixed with an `ownsHold` flag set
only by the transaction that actually claimed it. This is precisely the class
of defect that only appears under real concurrency — which is why
`test/integration/booking.spec.ts` fires genuinely parallel requests rather
than mocking.

### Idempotency

Every mutating endpoint requires an `Idempotency-Key` header.

| Situation | Response |
| --- | --- |
| Missing header | `400` |
| Replay, identical payload | Original status + body, `Idempotent-Replay: true` |
| Same key, **different** payload | `409` |
| Still in flight | `409` |
| Original failed | Claim deleted — the retry executes normally |

The fingerprint is SHA-256 over **canonical JSON**, not `JSON.stringify`.
Postgres `jsonb` does not preserve key order, so a round-trip through the
database reorders keys and `JSON.stringify` would produce a different hash for
identical data. Every hash, signature and fingerprint in the system goes
through `canonicalJson()`. This invariant is load-bearing in three places
(idempotency, audit chain, prescription signatures); it is documented in
[ADR-0008](adr/0008-canonical-json.md) and enforced by a unit test.

---

## 4. Security

Defence in depth, on the assumption that any single control will eventually
fail.

**Authentication.** Access tokens live 10 minutes; refresh tokens 7 days and
rotate on every use. Refresh tokens are stored as SHA-256 hashes and carry a
family id — **reuse of an already-rotated token revokes the entire family**,
which converts a stolen refresh token from persistent access into a single
detected event. Passwords use scrypt (N=32768, r=8, p=1) with
`timingSafeEqual` comparison. TOTP MFA is required for doctor and admin roles
and for step-up operations; a used code is blocked from replay within its
30-second window.

**Authorisation** is a guard chain — `RateLimit → Jwt → Roles → Mfa` — plus
per-resource ownership checks in services. A doctor requesting another
doctor's consultation gets 404, not 403: existence itself is information.

**Encryption.** AES-256-GCM envelope encryption, ciphertext laid out as
`[2B keyVersion | 12B IV | ciphertext | 16B tag]`. The version prefix is what
makes rotation possible without re-encrypting history — new writes use the new
key, old rows decrypt with the old one. Email uses an HMAC-SHA256 blind index
so login can look up an account without the address being searchable in
plaintext.

**Audit.** `audit_logs` is append-only (enforced by rules, not convention) and
**hash-chained**: each row's hash covers the previous row's hash, so deleting
or editing any entry breaks verification from that point forward.
`GET /admin/audit-logs/verify` walks the chain and reports
`{verified, checked, brokenAtId?}`.

**Clinical integrity.** The audit chain covers `audit_logs` and nothing else,
so a second control covers the clinical tables. Every mutation of
`consultations`, `prescriptions` and `payments` fires a `SECURITY DEFINER`
trigger that journals a row digest plus a **proof of application origin** — an
HMAC token the API presents on each database connection. The key is held by
the application and KMS, never by the database, so an attacker with full
database write access cannot mint a valid proof; their write is recorded as
unattributed, with the database user and client address. A sweep every five
minutes also catches the evasions that bypass the trigger entirely: rows
changed while it was disabled, unjournaled inserts, vanished rows, edited
journal entries, and deleted journal ranges (via chained checkpoints).

`GET /admin/integrity/verify` returns the findings;
`GET /admin/integrity/history/:table/:rowId` gives an incident responder a
per-row timeline. Nine tests in `test/integration/integrity.spec.ts` each
perform the actual attack and assert it is caught.

**What this is and is not.** It is detection, not prevention: nothing here
stops a privileged write, it makes one impossible to hide. Prevention remains
the least-privilege grants in `0004_grants.sql` and IAM. The residual risk is
an attacker who compromises **both** the database and the integrity key —
which is why the pre-production checklist requires that key to be distinct
from the encryption master key. See [ADR-0010](adr/0010-clinical-integrity.md).

Full analysis: [SECURITY.md](SECURITY.md) (OWASP Top 10, data classification,
key rotation) and [THREAT_MODEL.md](THREAT_MODEL.md) (STRIDE, attack surface,
abuse cases).

---

## 5. Scale and performance

**Read path.** Redis cache-aside on search and slot queries — measured 99.87%
hit rate under load, which is why search sustains ~1,900 rps on two shared
vCPUs. Analytics runs against a read replica so dashboard aggregations never
contend with booking row locks.

**Write path.** Short transactions, no user-facing work inside a lock, and
`NOWAIT` so a contended write fails in microseconds instead of queueing.

**Async work** goes through a **transactional outbox**: domain events are
written in the same transaction as the state change, then drained by a poller
using `FOR UPDATE SKIP LOCKED` with exponential backoff. This removes the
dual-write problem — there is no window where a consultation exists but its
notification was lost, or vice versa.

**Measured headroom.** One API process on 2 shared vCPUs (competing with
Postgres, Redis and the load generator):

| Scenario | RPS | p95 | Budget |
| --- | --- | --- | --- |
| Doctor search | 1,910 | 61 ms | 200 ms |
| Slot availability | 1,902 | 55 ms | 200 ms |
| Authenticated profile | 1,066 | 76 ms | 200 ms |
| Booking under contention | 996 | 38 ms | 500 ms |

The design point is ~2,000 rps at peak. A single small task already delivers
most of that, and production runs at least three across AZs.

**Scaling path, in order:** (1) horizontal API tasks — stateless, trivial;
(2) read replicas for analytics — already provisioned; (3) PgBouncer when
connection count rather than CPU becomes the limit; (4) partition pruning and
archival, which the partitioning scheme already enables; (5) only then,
extracting a service. Steps 1–4 carry this design well past 100k/day.

---

## 6. Observability

Every request carries an `x-request-id` and a W3C trace context; logs, metrics
and traces share those ids, so an alert leads to a trace leads to the exact log
lines.

- **Metrics** — Prometheus, RED plus domain-specific: `booking_conflicts_total{defence}`,
  `saga_compensations_total{step}`, `idempotency_events_total{outcome}`,
  `outbox_pending_events`, `circuit_breaker_state`. A 37-panel Grafana
  dashboard is provisioned in `observability/grafana/`.
- **Logs** — Pino JSON with automatic PHI redaction.
- **Traces** — OpenTelemetry → OTLP, spanning HTTP, Postgres, Redis and queue jobs.
- **Alerts** — 13 rules in `observability/alerts.yml` that page on *symptoms*
  (latency, error budget burn, saga compensations, outbox backlog) rather than
  causes (CPU), each linking to a runbook section.

The domain metrics are the ones that matter. `saga_compensations_total` rising
means money is being authorised and reversed — a business problem invisible to
CPU graphs.

---

## 7. Failure modes

| Failure | Behaviour |
| --- | --- |
| Redis down | Rate limiter **fails open** (availability over perfect throttling); booking still protected by two DB-level defences; queues pause and resume |
| Postgres primary fails | Multi-AZ failover, 60–120 s; `/readyz` pulls tasks from the ALB so no 500s are served |
| Payment provider down | Circuit breaker opens, saga compensates, hold released, patient sees a clean error rather than a silent charge |
| Worker crash mid-job | BullMQ retries (5 attempts, exponential); jobs are idempotent |
| Bad deploy | ECS circuit breaker auto-rolls back; new tasks must pass `/readyz` before old ones drain |
| AZ loss | 3 AZs, min 3 API tasks, NAT per AZ; capacity drops ~1/3, service continues |

**Error budget.** 99.95% allows 21.9 min/month. One RDS failover consumes
~10% of that. The `ErrorBudgetBurnFast` alert fires at 14× burn rate, which is
the threshold at which a month's budget would be gone in under two days.

---

## 8. Testing and CI

**163 tests across 11 suites** — 6 unit specs for pure logic (canonical JSON,
FSM transitions, field encryption, password rules) and 4 integration suites
(booking 19, auth 21, security 31, consultation 15) that run against **real
Postgres and Redis**, not mocks. Coverage: ~78% statements, ~80% lines, with
floors enforced in CI.

Integration tests use real infrastructure deliberately. The three defects these
tests found were all concurrency or protocol behaviours that a mocked database
would have reported as passing:

1. the losing racer releasing the winner's hold,
2. a canonical-JSON mismatch breaking the audit chain,
3. missing `Cache-Control: no-store` on authenticated PHI responses — only the
   PDF route had it, so a shared proxy could have cached a prescription.

CI runs static analysis, unit tests, integration tests against service
containers, a coverage floor, an **OpenAPI drift check** (regenerate and
`git diff --exit-code`, so the spec cannot silently diverge from the code),
`npm audit`, gitleaks, CodeQL, a Trivy image scan, and a container
boot/SIGTERM smoke test.

---

## 9. Trade-offs accepted

| Decision | Cost | Why anyway |
| --- | --- | --- |
| Modular monolith | Whole app scales together | Transactional integrity across booking/payment is worth more than independent scaling at this volume |
| Rate limiter fails open | A Redis outage removes throttling | Availability outranks throttling; WAF is the fail-closed backstop |
| Field encryption | ~40% slower authenticated reads (measured: 1,066 vs 1,910 rps) | A leaked DB credential should not equal a PHI breach |
| Hold TTL of 5 min | Slots briefly unavailable to others | Prevents payment-flow abandonment from silently losing bookings |
| Synchronous audit write | Adds latency to every mutation | An audit log that can be lost on crash is not an audit log |
| Drizzle over Prisma | Smaller ecosystem | Forced — Prisma's engine CDN is unreachable in this environment ([ADR-0002](adr/0002-drizzle-over-prisma.md)) — but exact SQL control turned out to be necessary for the `NOWAIT` and GiST work |

---

## 10. What I would do next

1. **PgBouncer** in front of RDS before connection count becomes the ceiling.
2. **Read-replica routing at the ORM layer**, so any read can opt into the
   replica rather than only analytics.
3. **Chaos testing** — kill Redis mid-booking in CI and assert the DB defences
   still hold. The property is designed for and unit-tested but not yet proven
   under injected failure.
4. **Soak testing.** The 20-second load runs prove throughput, not the absence
   of leaks.
5. **WORM backups of `audit_logs`** to close the gap described in §4.

---

### Index of decision records

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-modular-monolith.md) | Modular monolith over microservices |
| [0002](adr/0002-drizzle-over-prisma.md) | Drizzle ORM over Prisma |
| [0003](adr/0003-booking-concurrency.md) | Triple-defence booking concurrency |
| [0004](adr/0004-saga-vs-2pc.md) | Saga with compensations over 2PC |
| [0005](adr/0005-payment-adapter.md) | Payment provider behind an adapter + circuit breaker |
| [0006](adr/0006-audit-hash-chain.md) | Hash-chained append-only audit log |
| [0007](adr/0007-password-hashing.md) | scrypt over bcrypt/argon2 |
| [0008](adr/0008-canonical-json.md) | Canonical JSON as a hashing invariant |
| [0009](adr/0009-response-caching.md) | Deny-by-default response caching |
| [0010](adr/0010-clinical-integrity.md) | Proof-of-origin journal for clinical rows |
| [0011](adr/0011-saga-recovery.md) | Stuck-saga reconciler |
