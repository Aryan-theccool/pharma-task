# ADR-0003 — Triple-defence booking concurrency

**Status:** Accepted · **Date:** 2026-09-16

## Context

Two patients tap "book" on the same 09:00 slot in the same millisecond. Exactly
one must succeed. A double-booking means two patients arrive for one
appointment — a clinical and reputational failure, not merely a data bug.

Availability slots also must not overlap for one doctor: a 09:00–09:30 slot and
a 09:15–09:45 slot cannot both exist.

## Decision

Three independent layers, ordered cheapest-first:

```
1. Redis lock      SET lock:slot:{id} <token> NX PX 5000   → 409 defence="redis_lock"
2. Row lock        SELECT … FOR UPDATE NOWAIT              → 55P03 → 409 "row_lock"
3. DB constraint   EXCLUDE USING GIST + partial UNIQUE     → 23P01/23505 → 409 "db_constraint"
```

Plus a 5-minute **hold** before confirmation, so payment never happens against
a slot someone else can take mid-flow.

## Rationale

The obvious question is why not just the database constraint, which is
absolute. The answer is that each layer fails differently, and the combination
covers gaps none covers alone:

| Layer | Strength | How it fails alone |
| --- | --- | --- |
| Redis lock | Sub-millisecond, no DB round-trip | Lock lost on failover; TTL can expire mid-transaction |
| Row lock | Authoritative within a transaction | Only lives for that transaction; needs the row to exist |
| Constraint | Cannot be bypassed by any code path | Most expensive; conflict surfaces only at write time |

Ordering matters for cost. Under contention the Redis lock rejects the loser
before Postgres is touched at all. **Measured: 93% of 19,911 conflicts were
absorbed at layer 1.** Without it, every one of those attempts would have
opened a transaction and taken a row lock.

`NOWAIT` rather than a plain `FOR UPDATE` is deliberate: a queued lock turns
contention into latency, and under a thundering herd the queue *is* the outage.
Failing in microseconds with a clean 409 is better than making 200 clients wait.

`booking_conflicts_total{defence}` labels which layer caught each conflict. If
`db_constraint` starts firing, the upper layers have a bug — the metric is a
correctness signal, not just a counter.

## Consequences

**Accepted:** three places to keep consistent; conflicts are user-visible as
409s (correct, but the client must handle them); the Redis dependency is on
the hot path — though when Redis is down, layers 2 and 3 still guarantee
correctness, only more expensively.

**Verified:** `test/integration/booking.spec.ts` fires genuinely parallel
requests. Under load, 19,912 concurrent attempts on one slot produced exactly
**1 booking and 19,911 clean 409s**.

**A real bug this design surfaced:** the losing racer's compensation released
the *winner's* hold, because it scoped the release by `hold_token` and all
racers shared one token. An `ownsHold` flag, set only by the transaction that
actually claimed the hold, fixed it. Mocked tests would have passed.
