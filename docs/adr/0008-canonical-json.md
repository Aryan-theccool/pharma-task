# ADR-0008 — Canonical JSON as a system-wide hashing invariant

**Status:** Accepted · **Date:** 2026-09-16

## Context

Three separate mechanisms hash structured data:

1. **Idempotency** — SHA-256 fingerprint of the request payload, to detect a
   key reused with different content
2. **Audit chain** — each row's hash covers `before`/`after` `jsonb` documents
3. **Prescription signatures** — HMAC-SHA256 over the prescription content

All three were originally implemented with `JSON.stringify`. The audit chain
then started failing verification on data nobody had touched.

## The bug

PostgreSQL `jsonb` **does not preserve key order**. It stores an optimised
binary form and returns keys in its own order (by length, then bytewise). So:

```js
// written
JSON.stringify({ name: 'Asha', id: 7 })   // → {"name":"Asha","id":7}
// read back from jsonb
JSON.stringify(rowFromDb)                  // → {"id":7,"name":"Asha"}
```

Same data, different bytes, different hash. The audit chain broke on any entry
whose payload made a round trip through the database. Idempotency had the same
latent flaw: a client retrying with a semantically identical payload whose keys
serialised in a different order would get a spurious 409.

## Decision

A single `canonicalJson()` in `src/common/utils/canonical-json.ts`, used for
**everything hashed, signed or fingerprinted**. It recursively sorts object
keys, preserves array order (arrays are ordered data, not a set), and handles
`null`/`undefined` deterministically.

**`JSON.stringify` must never be used for a value that will be hashed, signed
or compared as a fingerprint.**

## Rationale

The alternative — being careful at each call site — is exactly what failed.
The bug was invisible in unit tests (no database round trip), appeared only in
integration, and produced a symptom (audit verification failure) far from its
cause (key ordering). A shared function with a stated invariant removes the
opportunity to get it wrong.

Array order is preserved deliberately. Prescription items are an ordered list;
sorting them would make two different prescriptions hash identically.

## Consequences

**Accepted:** a marginal cost per hash (sorting keys), irrelevant against the
SHA-256 itself. Every new hashing site must remember the rule — mitigated by
`test/unit/canonical-json.spec.ts`, which asserts key-order independence,
array-order dependence, and stability across a round trip.

**Adopted by:** `audit.service.ts`, `idempotency.interceptor.ts`,
`prescriptions.service.ts`.

**Wider lesson:** any value crossing a serialisation boundary and then being
compared byte-for-byte needs a canonical form. The same reasoning applies to
the webhook signature in [ADR-0005](0005-payment-adapter.md), which is computed
over the **raw request body** before parsing, for exactly this reason.
