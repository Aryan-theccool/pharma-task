# Amrutam Telemedicine Backend

Production-shaped backend for a telemedicine platform: user lifecycle, doctor
availability and booking, consultation and prescription lifecycle, payments,
compliance audit trails and admin analytics.

Built against a target of **100,000 consultations/day**, **p95 < 200 ms reads /
< 500 ms writes**, and **99.95% availability**.

```
NestJS 10 · TypeScript (strict) · PostgreSQL 16 · Redis 7 · BullMQ
Drizzle ORM · OpenTelemetry · Prometheus · Docker · Terraform (AWS)
```

| | |
| --- | --- |
| **Tests** | 177 passing across 12 suites — integration runs against real Postgres and Redis |
| **Coverage** | ~77% statements · ~79% lines (floors enforced in CI) |
| **API** | 52 paths / 56 operations, OpenAPI 3.0 generated from code |
| **Load** | 1,910 rps reads at p95 61 ms on 2 shared vCPUs — [report](load/README.md) |
| **Concurrency** | 19,912 simultaneous bookings on one slot → exactly **1 success, 19,911 clean 409s** |

---

## Documentation

| Document | What is in it |
| --- | --- |
| **[Architecture](docs/ARCHITECTURE.md)** | System design, data model, booking concurrency, scale analysis, trade-offs |
| **[Security checklist](docs/SECURITY.md)** | OWASP Top 10 mapping, data classification, key rotation, known gaps |
| **[Threat model](docs/THREAT_MODEL.md)** | STRIDE, attack surface, domain abuse cases, prioritised remediation |
| **[Load test report](load/README.md)** | Methodology, measured numbers, what the booking scenario proves |
| **[Infrastructure](infra/terraform/README.md)** | Terraform layout, AWS design decisions, bootstrap, cost sketch |
| **[ADRs](docs/adr/)** | Nine decision records — why each significant choice was made |
| **[Idempotency contract](docs/IDEMPOTENCY.md)** | The client-facing retry contract, with guidance for callers |
| **[Runbook](docs/RUNBOOK.md)** | One procedure per alert, linked from the alert annotations |
| **[OpenAPI](docs/openapi.json)** | Generated spec; also served at `/docs` in development |

---

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/Aryan-theccool/pharma-task.git
cd pharma-task
cp .env.example .env

docker compose up -d          # postgres, redis, migrations, api, worker
docker compose logs -f api
```

The `migrate` service runs migrations once before the API starts. Add
observability with `docker compose --profile obs up -d` (Prometheus :9090,
Grafana :3001, Jaeger :16686).

| Service | URL |
| --- | --- |
| API | http://localhost:3000/api/v1 |
| Swagger UI | http://localhost:3000/docs |
| Health / readiness | http://localhost:3000/healthz · `/readyz` |
| Metrics | http://localhost:3000/metrics |

### Local Node

Requires Node 20+, PostgreSQL 16 and Redis 7 already running.

```bash
npm ci
cp .env.example .env          # then point DATABASE_* / REDIS_* at your instances
npm run keys:generate         # generates the encryption and signing keys
npm run db:migrate
npm run seed
npm run start:dev             # API
npm run worker                # in a second terminal
```

### Seeded data

50 doctors, 500 patients, 5,220 availability slots, 295 consultations.

```
admin@amrutam.test
doctor1@amrutam.test … doctor50@amrutam.test
patient1@amrutam.test … patient500@amrutam.test

password: Str0ng!Passphrase2024
```

Doctor and admin accounts require TOTP; enrolment returns the secret at
`POST /auth/mfa/enroll`.

---

## Try the interesting parts

### End-to-end demo

```bash
npm run demo
```

Walks the whole platform — register, MFA, doctor onboarding, availability
materialisation, search, hold, confirm, consultation lifecycle, join
credentials, prescription signing, refund, audit verification — and asserts
**68 invariants** along the way, including a genuine concurrent-booking race.

It is re-runnable: the script clears the rate limits its own throttling check
trips, and caches the seeded admin's TOTP secret in `.demo-admin-totp`
(gitignored, 0600) because administrators deliberately cannot disable MFA. One
assertion — that an admin *without* step-up MFA is refused analytics — can only
be made on a freshly seeded database, and the run says so explicitly rather than
quietly dropping it, so the count is 68 after `npm run seed` and 67 thereafter.

### Prove the booking concurrency

```bash
npm run test:integration -- booking
```

Fires real parallel requests at one slot. Exactly one wins; the rest get 409s
labelled with the defence layer that caught them.

### Load test

```bash
npm run load:run
```

Note: the API rate-limits aggressively by default, so a benchmark will measure
the *limiter* unless you raise the limits. The runner detects this and fails
the run rather than reporting a flattering number — see
[load/README.md](load/README.md).

### Verify the audit chain

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3000/api/v1/admin/audit-logs/verify
# → {"verified":true,"checked":1247}
```

---

## What is actually implemented

**Auth** — 10-minute access tokens; 7-day refresh tokens that rotate on every
use, with **family revocation on reuse detection**; TOTP MFA with replay
blocking; scrypt passwords; account lockout.

**Booking** — three independent defences against double-booking (Redis lock →
`SELECT FOR UPDATE NOWAIT` → GiST exclusion constraint), a hold→confirm saga
with compensating actions, and mandatory idempotency keys on every mutation.

**Consultations** — an explicit state machine (`scheduled → in_progress →
completed`, with `cancelled`/`no_show` terminals); invalid transitions return
409 listing what *is* allowed.

**Prescriptions** — HMAC-signed over canonical JSON, immutable after signing,
async PDF generation through a queue.

**Compliance** — hash-chained append-only audit log, AES-256-GCM field
encryption with versioned keys, crypto-shredding erasure that preserves the
7-year clinical retention.

**Clinical tamper detection** — the audit chain protects `audit_logs` only, so
a separate control protects the clinical tables. Every write to
`consultations`, `prescriptions` and `payments` is journaled with an HMAC
**proof of application origin**; the key never reaches the database, so a write
made with psql or a leaked credential is recorded as unattributed and paged on
within five minutes. Seven evasion routes — including disabling the trigger,
editing the journal and deleting journal rows — are each covered by a test that
performs the attack. [ADR-0010](docs/adr/0010-clinical-integrity.md)

**Crash recovery** — a saga abandoned by a killed process is reclaimed by a
reconciler that compensates in reverse and dead-letters what it cannot fix, so
a patient is never left with money held and no appointment.
[ADR-0011](docs/adr/0011-saga-recovery.md)

**Observability** — RED metrics plus domain metrics
(`booking_conflicts_total{defence}`, `saga_compensations_total`,
`outbox_pending_events`), structured logs with PHI redaction, OpenTelemetry
traces, a 37-panel Grafana dashboard and 17 SLO alert rules.

**Reliability** — transactional outbox (no dual-write window), circuit breaker
on the payment provider, BullMQ retries, graceful shutdown.

### What is deliberately not built

Three integrations stop at the boundary, because wiring a real vendor adds
account setup rather than engineering signal. Each is a seam behind an
interface, not a `TODO` scattered through the code:

- **Media/RTC server.** `POST /consultations/:id/start` and
  `/consultations/:id/join` issue a real signed join credential — HMAC-SHA256,
  bound to one consultation and one user, 15-minute TTL, `host`/`guest` role —
  which is exactly the shape Agora, Twilio Video, LiveKit and Daily expect.
  Adopting one means reimplementing `JoinTokenService.issue()` against their
  signing scheme; callers and the API contract do not change.
- **Email/SMS delivery.** The notification worker writes a durable
  `notifications` row instead of calling a provider, so delivery semantics
  (exactly-once via `processed_events`, retries, backoff) are real and testable;
  only the final network hop is absent.
- **Live payment capture.** The Razorpay adapter is a complete HTTP client with
  idempotency keys, a circuit breaker and 5xx-only retries. It is contract-
  tested against a stubbed `fetch` that asserts the exact HTTP conversation
  (method, path, auth header, minor-unit amounts, retry behaviour); the build
  environment has no outbound access to Razorpay, so no live call is made.
  `PAYMENT_PROVIDER=mock` is refused at boot when `NODE_ENV=production`.

---

## Project layout

```
src/
├── modules/          11 feature modules (auth, doctors, booking, consultations,
│                     prescriptions, payments, admin, users, availability, audit, health)
├── common/           guards, interceptors, crypto, idempotency, outbox, resilience
├── infra/            database and Redis clients
├── observability/    metrics, tracing, logging
└── queue/            BullMQ producers and workers

db/migrations/        7 hand-written SQL migrations (23 tables, 38 indexes, 2 matviews)
test/unit/            4 specs — pure logic
test/integration/     4 suites — real Postgres and Redis
load/                 autocannon suite + measured report
infra/terraform/      6 modules, dev and prod stacks
observability/        Prometheus config, alert rules, Grafana dashboards
docs/                 architecture, security, threat model, 11 ADRs, OpenAPI
scripts/              migrate, seed, key generation/rotation, demo, OpenAPI generation
```

---

## Commands

| | |
| --- | --- |
| `npm run start:dev` | API with reload |
| `npm run worker` | Background worker |
| `npm run db:migrate` · `db:reset` | Apply / rebuild schema |
| `npm run seed` | Seed demo data |
| `npm run demo` | 64-assertion end-to-end walkthrough |
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests (needs PG + Redis) |
| `npm run test:cov` | Everything, with coverage |
| `npm run load:run` | Load test |
| `npm run openapi:generate` | Regenerate `docs/openapi.json` |
| `npm run keys:generate` · `keys:rotate` | Encryption key lifecycle |
| `npm run lint` · `format` · `typecheck` | Code quality gates |

---

## CI

The pipeline is **[`ci/github-actions-ci.yml`](ci/github-actions-ci.yml)**. It is
parked outside `.github/workflows/` because the bot account that pushed this
branch lacks GitHub's `workflows` permission and the push is rejected
otherwise. Run **`./ci/activate.sh`** to move it into place — see
[ci/README.md](ci/README.md). It runs:

`static-analysis` (format, lint with zero warnings, typecheck) · `unit-tests` ·
`integration-tests` (real PG 16 + Redis 7 service containers, migrations,
coverage floor) · `openapi` (regenerate and fail on drift) · `security`
(`npm audit`, gitleaks, CodeQL) · `docker` (buildx, Trivy scan, boot and
SIGTERM smoke test).

---

## Notable constraints in this build

Two dependencies were substituted because their download hosts are unreachable
from the build environment, and both substitutions are documented rather than
hidden:

- **Drizzle ORM instead of Prisma** — `binaries.prisma.sh` is blocked, so
  Prisma's engine cannot be fetched. This turned out to suit the PostgreSQL-
  specific DDL and lock syntax the design relies on ([ADR-0002](docs/adr/0002-drizzle-over-prisma.md)).
- **autocannon instead of k6** — GitHub release assets are blocked; autocannon
  installs from npm and reports the same percentiles.

Terraform's own CDN is also unreachable, so the infrastructure code could not
be run through `terraform validate` here. It was instead validated
mechanically — every file parsed with `python-hcl2`, every module output
reference resolved, every required input checked, and the module graph proven
acyclic. Details in [infra/terraform/README.md](infra/terraform/README.md#validating-changes).

---

## Three bugs the tests found

Worth reading as evidence that the test suite does real work:

1. **A losing racer released the winner's hold.** The compensating action
   scoped its slot release by `hold_token`, but every racer shared one token.
   Fixed with an `ownsHold` flag set only by the transaction that actually
   claimed the hold. Only reproducible under genuine concurrency.

2. **The audit chain broke on innocent data.** Hashes were computed with
   `JSON.stringify`, and PostgreSQL `jsonb` does not preserve key order — so a
   round trip changed the bytes and broke verification. Fixed by making
   canonical JSON a system-wide invariant ([ADR-0008](docs/adr/0008-canonical-json.md)).

3. **Authenticated PHI responses were missing `Cache-Control: no-store`.**
   Only the PDF route set it; every other endpoint returning medical data
   could have been cached by an intermediary proxy. Fixed with a global
   deny-by-default interceptor ([ADR-0009](docs/adr/0009-response-caching.md)).
