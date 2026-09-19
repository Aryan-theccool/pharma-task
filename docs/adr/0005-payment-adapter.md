# ADR-0005 — Payment provider behind an adapter with a circuit breaker

**Status:** Accepted · **Date:** 2026-09-16

## Context

Payments are the only synchronous third-party dependency on the booking path.
Indian telemedicine typically means Razorpay or Stripe, and the platform may
need both (Razorpay for UPI, Stripe for international cards). Whichever is
chosen, it will be slow sometimes and down occasionally.

## Decision

A `PaymentProvider` interface — `authorize`, `capture`, `void`, `refund` — with
a stub implementation for development and tests. Every call goes through a
**circuit breaker**, and inbound webhooks are verified and deduplicated.

## Rationale

**The interface is not speculative generality.** The saga
([ADR-0004](0004-saga-vs-2pc.md)) is defined in terms of authorize/capture/void/
refund, which is the common denominator of every card processor. The interface
is the vocabulary the saga already needs.

**The circuit breaker prevents a slow dependency from becoming an outage.**
Without it, a provider taking 30 s to respond ties up a connection per
in-flight booking until the pool is exhausted — at which point *reads* start
failing too. The breaker trips after a failure threshold, fails fast, and the
saga compensates cleanly: the hold is released and the patient sees an honest
error instead of a spinner. `circuit_breaker_state{breaker}` is exported and
alerted on.

**Webhooks are the source of truth for asynchronous state**, so they are
treated as hostile input:

- `X-Signature` = hex HMAC-SHA256 over `${timestamp}.${rawBody}`, compared in
  constant time. Missing **and** invalid signatures both return 403 with an
  identical body — distinguishing them would confirm to an attacker that a
  signature was being checked.
- `X-Timestamp` must be within ±300 s, which bounds replay of a captured
  valid request. A stale timestamp is 400, not 403: the signature was fine,
  the request was late.
- Exactly-once via `INSERT … ON CONFLICT (provider, event_id) DO NOTHING`.
  Providers retry aggressively and at-least-once delivery is their contract;
  a duplicate returns `{received: true, duplicate: true}` so they stop retrying.

The signature must be computed over the **raw body**, before JSON parsing —
parse-then-reserialise changes bytes and breaks verification. This constrains
the body-parser configuration and is the kind of detail that is easy to get
wrong once and never notice until a provider rotates a key.

## Consequences

**Accepted:** the stub provider means the payment integration is not proven
against a live PSP; real providers have quirks (partial captures, currency
minor units, async authorisation) that only surface in integration. The
interface is the right seam for that work, not a substitute for it.

**Gained:** the entire booking saga is testable without network access; swapping
providers is one class; a provider outage degrades bookings while leaving the
rest of the platform fully functional.
