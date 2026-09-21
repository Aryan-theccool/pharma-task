# ADR-0012 — Per-call-site Redis failure policy

**Status:** Accepted · **Date:** 2026-09-20

## Context

Redis backs five unrelated concerns in this system: response caching, rate
limiting, the session-revocation denylist, booking slot locks, and BullMQ.
They had one thing in common — none of them had a stated policy for what should
happen when Redis is unreachable. The behaviour was whatever the client library
happened to do.

What it happened to do was hang.

`RedisService` was constructed with `maxRetriesPerRequest: null`. That setting
is *required* by BullMQ, whose blocking commands (`BRPOPLPUSH`) are supposed to
wait indefinitely, and it had been copied to the request-path client. There it
means something quite different: ioredis queues commands forever rather than
rejecting them. No `commandTimeout` was set anywhere in the codebase.

The consequence was that the rate limiter's fail-open path — a deliberate,
documented, unit-tested availability trade-off — **was unreachable in
production**. Its `catch` block could only run if a Redis command rejected, and
no Redis command ever rejected. A live outage drill confirmed it: with Redis
killed, a login request hung for 20 seconds and was aborted with no status
code, and `/healthz` stopped responding too. A cache being down took the entire
API with it.

The unit tests passed throughout, because they mocked Redis with a stub that
rejected promptly. The mock asserted the behaviour the real client did not have.

## Decision

**1. The request-path client must be able to fail.**

`RedisService` now sets `commandTimeout` (250ms default), bounded
`maxRetriesPerRequest`, and `enableOfflineQueue: false` so commands issued
while disconnected fail immediately instead of buffering into a queue that
resolves long after the HTTP request has been abandoned. The BullMQ connections
in `QueueService` and `WorkersService` keep `maxRetriesPerRequest: null` — that
is correct for them — and each gained an `error` listener, because an `error`
event with no listener is rethrown by EventEmitter and would crash the process
during precisely the outage it needs to survive.

**2. Every call site declares whether it fails open or closed.**

| Call site | Policy | Why |
| --- | --- | --- |
| Response cache (`get`/`set`/`del`/`delByPattern`) | **Open** — treat as a miss | Postgres is the source of truth; the cache is an optimisation. If an unreachable cache throws, the optimisation has silently become a hard dependency. |
| Cache invalidation | **Open** — best-effort | Runs *after* the write has committed. Throwing would fail a request whose work is already durable. TTLs are the backstop. |
| Rate limiter | **Open** — admit the request | Availability outranks throttling. The WAF and DB-backed account lockout remain. |
| Session-revocation denylist | **Closed** — 503 | An unreadable denylist cannot prove a session was *not* revoked, and a revoked session is exactly what an attacker replays. |
| Booking slot lock | **Closed** — propagate | Admitting a booking without the lock risks a double-booked clinician. Two DB-level defences remain, but the caller must not proceed as though it holds a lock it does not. |
| BullMQ | **Retry forever** | Jobs are durable and queued work is not latency-bound. |

**3. Both polarities are separately observable.**

`rate_limit_enforcing` (1/0, seeded to 1 at construction) and
`rate_limit_fail_open_total{reason}` for the fail-open side;
`auth_denylist_unavailable_total{reason}` for the fail-closed side; and
`cache_events_total{result="error"}` distinguished from `result="miss"`, because
a miss is routine and an error means Postgres is absorbing the full read load.

**4. Boot degrades rather than crash-loops.** If Redis is down at startup the
app logs and starts anyway. `/readyz` reports 503 and keeps traffic away until
the dependency returns. Refusing to boot turns a partial outage into a total
one.

## Consequences

Verified by a live outage drill rather than mocks — Redis killed, then
restarted, with no application restart:

| | Redis down (before) | Redis down (after) | Recovered |
| --- | --- | --- | --- |
| `/healthz` | hangs | 200 in 18ms | 200 |
| `/readyz` | hangs | 503 in 10ms | 200 |
| `/doctors/search` | hangs | 200 in 23ms (from Postgres) | 200 |
| `/auth/login` | aborted at 20s, no status | 200 in 128ms | 200 |
| authenticated request | hangs | 503 in 8ms, retry-able | 200 |
| `rate_limit_enforcing` | n/a | 0 | back to 1 automatically |

A Redis outage is now a latency and throttling event, not an availability
event. Recovery needs no deploy or restart.

The residual risk is unchanged and intentional: while the limiter is failing
open, request throttling is genuinely absent. That is the trade-off. What is no
longer true is that it happens silently — `RateLimiterFailingOpen` pages within
a minute, and
[RUNBOOK.md#rate-limiter-failing-open](../RUNBOOK.md#rate-limiter-failing-open)
covers the response.

The wider lesson is recorded here because it generalises: **a fail-open path is
not proven by a test that mocks the failure.** The mock and the real client
disagreed about the one thing that mattered, and only an outage drill could
tell them apart.

## Alternatives considered

- **Make the limiter fail closed.** Rejected. A Redis blip would return 429 to
  every caller, including clinicians mid-consultation.
- **One global policy for all Redis calls.** Rejected. Caching and
  authentication have opposite correct answers; a single policy is wrong for
  one of them.
- **A circuit breaker in front of Redis.** Deferred. With a 250ms command
  timeout and a disabled offline queue, a failing call already costs little.
  Worth revisiting if timeout latency becomes material under load.
