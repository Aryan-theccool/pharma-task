# ADR-0006 — Hash-chained append-only audit log

**Status:** Accepted · **Date:** 2026-09-16

## Context

Clinical systems must prove who did what and when. An audit log that can be
edited by whoever compromises the system proves nothing — the first thing an
attacker does after acting is delete the evidence.

## Decision

`audit_logs` is append-only (enforced by PostgreSQL rules that reject `UPDATE`
and `DELETE`) and **hash-chained**:

```
row_hash = SHA256(prev_hash || canonicalJson([
  occurredAt, actorId, actorRole, action, resourceType, resourceId,
  outcome, ip, requestId, traceId, before, after
]))
```

The head is tracked in Redis (`audit:chain:head`) under a lock
(`audit:chain:lock`) so concurrent writers serialise. `GET /admin/audit-logs/verify`
walks the chain in `occurred_at ASC, id ASC` order and returns
`{verified, checked, brokenAtId?}`.

## Rationale

**Append-only alone is insufficient.** Rules stop the *application* from
issuing an `UPDATE`, but a superuser connection bypasses them. The chain
changes the threat: an attacker who alters row *N* must recompute every hash
from *N* to the head, and any copy of a later hash — an offsite backup, a
monitoring snapshot, an exported report — makes the forgery detectable.

**Canonical JSON is mandatory here.** The hash covers a `jsonb` payload, and
`jsonb` does not preserve key order. Hashing `JSON.stringify(row)` produces a
different digest after a database round-trip, which breaks verification for
entirely innocent reasons. This is not hypothetical: it is exactly the bug that
occurred during development, and the fix (`canonicalJson` everywhere) is now a
system-wide invariant — see [ADR-0008](0008-canonical-json.md).

**Synchronous writes.** The audit entry is written in the same transaction as
the action it records. This costs latency on every mutation and it is worth it:
an audit log that can be lost in a crash is not an audit log. The alternative —
queueing audit events — creates a window where an action succeeded and its
record vanished.

## Consequences

**Accepted:** writes serialise on the chain head, so audit throughput is
bounded by that lock. At ~12 mutations/second peak this is nowhere near the
limit; at 100× it would need per-partition chains. Verification is O(n) over
the range checked, so full-history verification is a batch job, not a request.

**Honest limitation.** The chain protects `audit_logs`. It does **not** protect
clinical tables — `test/integration/consultation.spec.ts` confirms that direct
SQL modification of `prescriptions.diagnosis_enc` is not blocked. Detecting
that requires either chaining clinical rows too (expensive) or controls outside
the application: least-privilege database credentials (`0004_grants.sql`),
CloudTrail on RDS, and WORM backups. The application-layer control is
deliberately scoped, and stating the boundary is more useful than implying
coverage it does not have.

**Verified:** the `verify` endpoint is exercised in
`test/integration/security.spec.ts`, including a deliberately tampered row to
confirm the break is detected and `brokenAtId` points at the right entry.
