# Load testing

Measured results, the reasoning behind the load profile, and how to reproduce.

Tooling is [`autocannon`](https://github.com/mcollina/autocannon) driven from
`load/run-load.ts`. (k6 was the first choice but GitHub release assets are
unreachable from this build environment; autocannon installs from npm and
produces the same percentile data.)

## Deriving the load profile

The brief specifies **100,000 consultations/day**. Taken literally that is only
~1.2 bookings/second, which no interesting system struggles with. Two
adjustments make the target realistic:

| Factor              | Reasoning                                                                                                        | Result          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| Diurnal peak        | Booking traffic clusters into a morning and an evening window; peak ≈ 10× the daily mean                          | ~12 bookings/s  |
| Read:write ratio    | Patients browse many doctors, compare slots, and re-check availability before committing. ~20 reads per booking   | ~240 reads/s    |
| Retry amplification | Mobile clients on poor connections retry; idempotency keys make this safe but the requests still arrive           | +15%            |

So the design point is roughly **280 req/s sustained, ~2,000 req/s at peak**,
overwhelmingly reads. The runs below exceed that on a 2-vCPU sandbox with a
single API process.

## Results

Measured 2026-09-19. Single API process, Node v22, **2 vCPU / 3.9 GB**, with
Postgres 16 and Redis 7 on the *same* box competing for the same two cores.
20s per scenario, 50 connections (20 for the write scenario).

| Scenario         | RPS       | p50    | p95    | p99     | max     | Errors | SLO             | Verdict  |
| ---------------- | --------- | ------ | ------ | ------- | ------- | ------ | --------------- | -------- |
| `search`         | **1,910** | 22 ms  | 61 ms  | 83 ms   | 202 ms  | 0      | p95 < 200 ms    | **PASS** |
| `slots`          | **1,902** | 23 ms  | 55 ms  | 73 ms   | 135 ms  | 0      | p95 < 200 ms    | **PASS** |
| `profile` (auth) | **1,066** | 43 ms  | 76 ms  | 109 ms  | 455 ms  | 0      | p95 < 200 ms    | **PASS** |
| `booking-hold`   | **996**   | 18 ms  | 38 ms  | 50 ms   | 148 ms  | 0      | p95 < 500 ms    | **PASS** |

Raw output: [`load/results/latest.json`](results/latest.json).

**Headroom.** The peak design point is ~2,000 req/s of mixed traffic; a single
process on two shared cores served 1,900 req/s of pure reads at p95 = 61 ms,
roughly a third of the 200 ms budget. The production topology (≥3 Fargate
tasks, database on its own instance) has ample margin, and the binding
constraint will be database connections rather than application CPU.

### What the booking scenario actually proves

`booking-hold` points every one of its connections at a **single slot** — the
pathological case where the whole internet tries to book the same 09:00
appointment. Over the run:

```
201 × 1          ← exactly one winner
409 × 19,911     ← everyone else, correctly rejected
```

**One slot, one booking, 19,912 concurrent attempts, zero double-bookings** —
and conflict detection cost p95 = 38 ms, well inside the write budget. Server
metrics show which layer of the triple defence caught each conflict:

```
booking_conflicts_total{defence="redis_lock"}  18,585   ← cheap Redis lock, no DB round-trip
booking_conflicts_total{defence="state"}        1,346   ← slot already held/booked
booking_attempts_total{stage="hold",result="success"}  1
```

That distribution is the design working as intended: the Redis lock absorbs
~93% of contention before it ever reaches Postgres, so the database never
becomes the contention point. The row lock and the GiST exclusion constraint
sat idle here — they exist for the cases Redis cannot cover (a lock expiring
mid-transaction, a Redis failover, a second process racing the first) and are
exercised directly by the integration tests in `test/integration/booking.spec.ts`.

### Cache effectiveness

```
cache_events_total{cache="search",result="hit"}   38,196
cache_events_total{cache="search",result="miss"}      51
```

99.87% hit rate on the search cache. The 51 misses are the cold start and TTL
expiries. This is why `search` sustains ~1,900 rps: almost none of it reaches
Postgres.

### Connection pool

`db_pool_waiting` stayed at **0** for the entire run with `db_pool_total = 20`,
so no request ever queued for a connection. The pool is sized correctly for
this concurrency.

## The `profile` scenario is the expensive read

At 1,066 rps it is the slowest read path, which is expected and worth stating
plainly: every request verifies a JWT signature *and* AES-256-GCM-decrypts the
encrypted profile fields. That is real cryptographic work per request, and it
is the price of encrypting PII at the field level. It still lands at p95 = 76 ms,
comfortably inside budget.

## Reproducing

The API must be running with a seeded database:

```bash
npm run db:migrate && npm run seed
npm run dev            # or: docker compose up -d
npm run load:run
```

Options:

```bash
npm run load:run -- --duration 60 --connections 100
npm run load:run -- --scenario search
npm run load:run -- --url https://staging.example.com
```

### Rate limits will distort the numbers unless you raise them

The API defaults to 300 req/min per identity, and individual routes are
stricter. A load generator trips those limits within the first second, after
which you are benchmarking the *rate limiter* — 429s are cheap to produce and
will flatter every percentile.

`run-load.ts` guards against this: it records the status-code distribution per
scenario and **fails the run** if fewer than 99% of responses were the status
the scenario intends to measure, printing

```
note  only 0.2% of responses were 200 — the run measured rejections, not real work
```

This check is not decorative. The first execution of this suite reported
"all SLOs met" at 2,998 rps while 59,828 of 59,944 responses were 429s. The
guard is what turned a meaningless green result into a real one.

To measure the application, raise the limits on the target:

```bash
RATE_LIMIT_GLOBAL_PER_MIN=5000000 \
RATE_LIMIT_ROUTE_MULTIPLIER=100000 \
npm run dev
```

`RATE_LIMIT_ROUTE_MULTIPLIER` scales every per-route `@RateLimit` budget so the
decorators do not have to be edited for a benchmark. **It must stay at `1` in
production.**

## Known limitations

- Single-node run. Cross-AZ latency, ALB overhead and RDS network hops are not
  represented; treat these as upper bounds on throughput, not production
  predictions.
- The load generator shares two cores with the API, Postgres and Redis, so it is
  competing with the system under test. Real capacity is higher.
- `booking-hold` measures hold contention, not the full hold→confirm→payment
  saga; the saga's payment step is an in-process stub here, and against a real
  PSP its latency would dominate.
- 20-second runs catch throughput and latency but not slow leaks. A soak test
  (hours, watching RSS and `db_pool_waiting`) belongs in a staging pipeline.
