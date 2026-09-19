# ADR-0004 — Saga with compensations over two-phase commit

**Status:** Accepted · **Date:** 2026-09-16

## Context

Confirming a booking spans four operations, one of which is at a third party:

1. validate the hold is still valid and owned by this user
2. **authorize payment** (external provider)
3. create the consultation row
4. **capture payment** (external provider)

A failure at step 3 after a successful step 2 means the patient is authorised
for a consultation that does not exist.

## Decision

An **orchestrated saga** with explicit compensating actions, executed in
reverse order on failure, with state persisted in `saga_instances`.

```
validate_hold → authorize_payment → create_consultation → capture_payment
                      │                      │                   │
                 void_payment        cancel_consultation    refund_payment
                      └──────── compensated in reverse ───────────┘
```

## Rationale

**2PC is not available.** It requires every participant to support a prepare
phase and hold locks until the coordinator decides. Stripe and Razorpay expose
`authorize`/`capture`/`refund` — not `prepare`/`commit`. The choice is
therefore not "saga vs 2PC" but "saga vs pretending the external call is
transactional".

**2PC would be wrong even if available.** It is a blocking protocol: a
coordinator crash between prepare and commit leaves participants holding locks
indefinitely. On a booking path where a held lock means an unsellable
appointment slot, that is an availability failure.

**Authorize-then-capture maps naturally to compensation.** An authorisation is
already a reversible reservation of funds — the payment domain's own model is
saga-shaped. Voiding an uncaptured authorisation is clean and, unlike a refund,
invisible on the patient's statement.

**Orchestration over choreography.** A central orchestrator makes the flow
readable in one file and the state inspectable in one table. Choreographed
events would scatter this across four handlers with the ordering implicit.

## Consequences

**Accepted:** compensations must be idempotent — a retried `void_payment` must
not error if the authorisation is already void. There is a window where a
payment is authorised but the consultation does not yet exist; it is bounded by
the saga's execution and resolved by compensation. Reasoning about partial
states requires the state table, which is why `saga_instances` persists every
step transition.

**Instrumented:** `saga_steps_total{saga,step,result}` and
`saga_compensations_total{saga,step}`. A non-zero compensation rate means money
is being authorised and reversed — alerted on at `> 0.1/15min`, because this
is a business-visible failure that no CPU graph would reveal.

**Not implemented:** a periodic reconciler that sweeps sagas stuck in a
non-terminal state past a deadline. The compensation path handles synchronous
failures; a process killed mid-saga would currently need manual intervention.
This is the first thing to add before production.
