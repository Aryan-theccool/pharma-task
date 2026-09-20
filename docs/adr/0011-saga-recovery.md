# ADR-0011 — Stuck-saga reconciler

**Status:** Accepted · **Date:** 2026-09-20

## Context

The booking saga ([ADR-0004](0004-saga-vs-2pc.md)) compensates correctly when a
step *throws*: the catch block runs the registered compensations in reverse
order, the hold is released and the payment is voided.

It does nothing when the *process* dies.

Between "payment authorized" and "consultation created" there is a window of a
few hundred milliseconds. If the pod is OOM-killed, evicted, or loses its node
in that window, no catch block runs. What remains is:

- a row in `saga_instances` stuck in `running` forever,
- an authorization held against the patient's card,
- a slot marked `held` that no sweeper will release, because hold expiry only
  handles holds that were never confirmed.

At 100k consultations/day, even a 0.01% crash rate during the confirm window is
around ten stranded bookings a day — ten patients with money held and no
appointment. `SagaService.findStuck()` existed to *list* these; nothing acted on
them.

## Decision

A reconciler runs every minute on every replica. It claims stale sagas, runs
their recorded compensations, and dead-letters anything it cannot fix.

```
claim (FOR UPDATE SKIP LOCKED, state -> compensating, attempts += 1)
  -> replay recorded compensations in reverse
  -> release the slot if still held and uncommitted
  -> state = compensated
on failure -> retry next pass, up to N, then state = dead_letter
```

## Rationale

**Roll back, never roll forward.** A stuck booking is compensated, not
completed. Completing it would mean charging a patient for a consultation they
were never told they had, and placing a doctor in front of someone who does not
know they have an appointment. Refunding a patient who did want the booking is
an annoyance they can recover from; silently charging one is a breach of trust
and, in healthcare, a regulatory problem.

**Recovery must be idempotent, because it will run concurrently.** Every
compensation is either a conditional UPDATE (`WHERE status = 'captured'`,
`WHERE status = 'scheduled'`) or a provider call carrying a deterministic
idempotency key (`void:{bookingRef}`). Two replicas reconciling the same saga
cannot double-refund. Tested explicitly: a second pass reports zero recovered.

**Claim before acting.** `FOR UPDATE SKIP LOCKED` plus a state transition
inside the same transaction means a second replica skips a saga already being
handled rather than racing it — the same pattern the outbox drainer uses.

**Never undo something a human completed.** The `cancel_consultation`
compensation is conditional on `status = 'scheduled'`. If the patient actually
attended and the consultation is `completed`, the reconciler leaves it alone.
A stale saga row is not licence to rewrite clinical history. Tested.

**Give up loudly, with a bound.** After `SAGA_RECOVERY_MAX_ATTEMPTS` the saga
moves to `dead_letter`, a gauge rises and a critical alert fires. An unbounded
retry loop would hide a systematic failure behind an ever-growing backlog; a
dead letter queue turns it into a finite, named list with a runbook entry.

**Five minutes before a saga is considered stuck.** Long enough to exceed the
slowest legitimate confirm (payment authorize + capture, with five retries and
full jitter — observed p99 well under 5 s), short enough that a patient's money
is not held for long. Configurable via `SAGA_STUCK_AFTER_SECONDS`.

## Consequences

**Good**

- A crash mid-booking self-heals within ~1 minute instead of requiring a human.
- Slots stop leaking out of inventory when pods restart.
- `saga_stuck_instances` and `saga_dead_lettered_instances` make the failure
  mode visible before a patient complains.

**Costs**

- One extra query per minute per replica even when idle (a partial-index scan
  over non-terminal sagas — negligible, but not zero).
- A saga type with no registered strategy is dead-lettered immediately rather
  than attempted. Deliberate: guessing at recovery for an unknown workflow is
  more dangerous than escalating.
- Recovery is only as good as the compensation list the saga recorded. If a
  step completes but the process dies *before* `completeStep` persists its
  compensation, that step is invisible to the reconciler. The window is one
  statement wide, and the residual is caught by the payment reconciliation
  report — but it is a real gap, not a solved one.

## Alternatives considered

**A durable workflow engine (Temporal, AWS Step Functions).** The right answer
at larger scale and genuinely better at this problem. Rejected here for the same
reason as in ADR-0004: it adds an operational dependency on the booking path for
one workflow, when the saga log already contains everything needed to recover.
Revisit when a second or third multi-step workflow appears.

**Recovery on startup only.** Cheap, but a replica that stays up while another
dies never notices — and in a rolling deploy the dying pod's work can sit
unclaimed for hours. A periodic sweep on every replica has no such blind spot.

**Longer hold TTLs to let expiry clean up.** Does not address the payment, which
is the part that actually harms the patient.
