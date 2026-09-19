# Idempotency

How to call this API safely from an unreliable network. The brief lists
idempotency as a **critical** requirement — a submission missing it fails
regardless of everything else — so this is the client-facing contract in full.

---

## The problem

A patient on a train taps "confirm booking". The request reaches the server,
the consultation is created, the card is charged — and then the connection
drops before the response arrives. The app retries. Without idempotency, that
is **two consultations and two charges**.

This is not an edge case. Mobile clients retry constantly, and payment flows
are exactly where a double-submit costs real money.

---

## The contract

Every mutating endpoint (`POST`, `PATCH`, `DELETE`) requires an
`Idempotency-Key` header.

```http
POST /api/v1/bookings/confirm
Authorization: Bearer <token>
Idempotency-Key: 8f14e45f-ea69-4b3c-9d1e-7a2b5c8d0f31
Content-Type: application/json

{"holdToken": "...", "slotId": "..."}
```

| Situation | Status | Behaviour |
| --- | --- | --- |
| No header | `400` | Rejected before any work happens |
| First use | `2xx` | Executes normally; response recorded |
| Retry, **identical** payload | Original status | Original response replayed, `Idempotent-Replay: true` |
| Same key, **different** payload | `409` | Refused — see below |
| Still in flight | `409` | The first attempt has not finished |
| First attempt **failed** | — | Claim released; the retry executes normally |

### Why a different payload is a 409, not a new execution

If the same key arrives with different content, one of two things is true:
the client has a bug (mutating its payload between retries), or someone is
replaying a captured key against different data. Neither should silently
execute. Returning 409 surfaces the bug instead of processing an unintended
operation.

### Why a failed attempt releases the claim

If the first attempt returned a 500, the operation did not happen. Caching that
failure would make the endpoint permanently broken for that key. The claim is
deleted so a retry genuinely retries.

**Note:** 4xx client errors *are* recorded — they are deterministic. A
malformed request will be malformed on retry too.

---

## Implementation

`src/common/idempotency/idempotency.interceptor.ts`, backed by Redis for the
in-flight claim and the `idempotency_keys` table for durable results.

**Key namespacing:** `{userId}:{METHOD} {route}:{key}`

Scoping by user means one client cannot collide with — or probe — another's
keys. Scoping by route means the same key on a different endpoint is a
different operation.

**Payload fingerprint:** SHA-256 over `canonicalJson(body)`.

Not `JSON.stringify`. PostgreSQL `jsonb` does not preserve key order, so a
payload round-tripping through the database serialises differently and would
produce a spurious 409 for a byte-identical retry. This is a system-wide
invariant — see [ADR-0008](adr/0008-canonical-json.md).

**TTL:** 24 hours. Long enough to cover any realistic client retry (including
a user reopening the app the next morning), short enough to bound storage.

**Flow:**

```
1. Read Idempotency-Key      → missing? 400
2. Fingerprint the payload   → SHA-256 over canonical JSON
3. Claim in Redis (SET NX)   → already claimed?
                                 ├─ completed + same fingerprint → replay
                                 ├─ completed + different        → 409
                                 └─ in flight                    → 409
4. Execute the handler
5. Success → persist status + body, mark complete
   5xx     → delete the claim so a retry can proceed
```

---

## Client guidance

**Generate the key once, per logical operation** — when the user taps the
button, not when the HTTP request is built. A key regenerated on retry defeats
the entire mechanism.

```ts
// correct
const idempotencyKey = crypto.randomUUID();
async function confirmBooking() {
  return retry(() =>
    fetch('/api/v1/bookings/confirm', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },   // stable across retries
      body: JSON.stringify(payload),                     // must not change
    }),
  );
}

// wrong — a new key every attempt is the same as having none
headers: { 'Idempotency-Key': crypto.randomUUID() }
```

**Persist the key with any pending operation.** If the app is killed
mid-request, the key must survive so the retry after restart is recognised.

**Do not retry a 409.** It means either the original is still running (wait and
poll) or the payload changed (a bug to fix). Retrying will not help.

**Check `Idempotent-Replay: true`** to distinguish "we just did this" from
"this had already been done" — useful for analytics, and for not showing a
success animation twice.

---

## Interaction with the booking saga

Idempotency and the saga solve adjacent problems and are both needed:

- **Idempotency** prevents the *same* request from executing twice.
- **The saga** ensures that when a request executes *once*, a mid-flight
  failure does not leave the system half-committed
  ([ADR-0004](adr/0004-saga-vs-2pc.md)).

A confirm that fails at `capture_payment` compensates (voids the
authorisation, cancels the consultation) and returns an error. The claim is
released, so the client's retry runs the saga again from a clean state rather
than resuming a partial one.

---

## Observability

`idempotency_events_total{outcome}` where outcome is
`new` · `replay` · `conflict` · `in_flight`.

- A healthy `replay` rate proves clients are retrying and the mechanism is
  working.
- A rising `conflict` rate is almost always a client bug and is alerted on at
  `> 1/s` for 10 minutes.

---

## Verified by

`test/integration/booking.spec.ts` and `test/integration/security.spec.ts`
cover: missing key → 400; replay returns the original status, body and the
`Idempotent-Replay` header; reordered-but-equivalent JSON still replays;
changed payload → 409; concurrent duplicates → one executes and the other
gets 409; a failed first attempt allows a genuine retry.
