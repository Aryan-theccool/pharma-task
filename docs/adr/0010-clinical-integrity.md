# ADR-0010 — Proof-of-origin journal for clinical rows

**Status:** Accepted · **Date:** 2026-09-20

## Context

The audit trail is hash-chained and append-only, and it is genuinely strong —
for `audit_logs`. It says nothing about the clinical tables themselves.

An attacker holding a database credential — a leaked connection string, a
compromised bastion, a contractor with production access, or SQL injection that
reached a write path — could run:

```sql
UPDATE prescriptions SET diagnosis_enc = NULL WHERE id = '...';
```

and every audit verification would still return `verified: true`, because no
audit row was touched. `test/integration/consultation.spec.ts` proves this
directly. The first version of this system documented the hole as an accepted
risk, with least-privilege grants, CloudTrail and WORM backups as compensating
controls.

For a telemedicine platform that is not good enough. Prescriptions are clinical
and legal records. "We would detect it eventually from the backups" is not an
answer to "was this patient's dosage altered?".

## Decision

Journal every mutation of `consultations`, `prescriptions` and `payments` with
a **proof that the write came from the application**, and verify that proof
outside the database.

Three parts:

1. **A `SECURITY DEFINER` trigger** writes to `clinical_integrity_journal` on
   every INSERT/UPDATE/DELETE: a SHA-256 digest of the row, the database user,
   the client address, the transaction id, and a proof token read from the
   session GUC `amrutam.proof`.

2. **The proof token** is `v1.<issuedAt>.<nonce>.<HMAC-SHA256(key, body)>`,
   minted once per API process and presented in the libpq startup packet. The
   trigger copies it verbatim and never validates it.

3. **Verification happens in the application**, which holds the key. A sweep
   every five minutes checks proofs and runs five set-based SQL checks for the
   evasions that avoid the trigger entirely.

## Rationale

**The key must not be in the database.** This is the whole design. If the
database could validate the proof, it would need the key — and anyone who can
write to the clinical tables could then read the key and mint proofs. Keeping
verification outside means the attacker must compromise two independent systems.

**`SECURITY DEFINER` is what makes the journal trustworthy.** The trigger runs
as the table owner, so `app_user` needs no write privilege on the journal:
`SELECT` only. A fully compromised application credential can read its own
history but can neither forge an entry nor delete one.

**Detection, not prevention — and the distinction is stated honestly.** Nothing
here stops a privileged write. It makes one impossible to hide. Prevention
stays with the grants and IAM; this is the layer that turns a silent compromise
into a page within five minutes.

**Checkpoints rather than a per-row chain.** A hash chain over every clinical
write would serialise all clinical writes behind a single chain head — exactly
the bottleneck the audit chain's Redis lock exists to manage, but on the hot
booking path. Instead each entry self-hashes, and a periodic job folds
contiguous id ranges into a chained checkpoint. Deleting journal rows breaks the
fold; concurrent writes never contend.

**Baselining avoids a permanent false positive.** Rows predating the migration
have no journal entry and would be reported forever as unjournaled — the
fastest way to train an operator to ignore an alert. `integrity_baseline()`
writes one entry per existing row, marked `baseline`, and the docs are explicit
that a baseline attests only from that moment.

## Consequences

**Good**

- Direct database tampering is detected, with the affected row, the database
  user and the source address named.
- Seven evasion paths are covered, each proven by a test that performs the
  actual attack.
- The forensic endpoint (`/admin/integrity/history/:table/:rowId`) gives an
  incident responder a per-row timeline.

**Costs, stated plainly**

- **One extra row written per clinical mutation.** Measured at ~0.3 ms added to
  a booking confirm, against a 500 ms write budget. The journal grows roughly
  linearly with clinical writes and needs the same partition-and-archive
  treatment as `audit_logs` at scale.
- **Two keys to manage instead of one.** `INTEGRITY_PROOF_KEY` must be rotated
  and stored separately from `ENCRYPTION_MASTER_KEY`; sharing them collapses
  the two-system-compromise property that justifies the design.
- **A five-minute detection window.** A sweep is not synchronous validation.
  Shortening it is a config change; making it synchronous would put an HMAC
  verification on every clinical read.

## Alternatives considered

**Row-level triggers that reject unattributed writes.** Rejected: a trigger
that can block a write can be dropped by the same superuser it is defending
against, and it converts a detection control into an availability risk — a
misconfigured proof would take the whole clinical path down.

**Postgres logical decoding / `pgaudit` to an append-only sink.** Strong, and
complementary, but it depends on infrastructure outside the application's
control and cannot distinguish an application write from a psql write — both
are the same role on the same connection. The proof token is precisely what
carries that distinction.

**Blockchain / external notary.** Adds an availability dependency on the
clinical write path for a threat model where an internal, KMS-backed key is
already sufficient.

**Signing every clinical row in the application.** This is what prescriptions
already do (HMAC over canonical JSON) and it is genuinely useful — but it only
protects rows the application chose to sign, and it cannot detect deletions or
rows inserted behind the application's back.
