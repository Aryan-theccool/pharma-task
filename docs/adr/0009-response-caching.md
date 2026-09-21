# ADR-0009 — Deny-by-default response caching

**Status:** Accepted · **Date:** 2026-09-18

## Context

While writing `test/integration/security.spec.ts`, an assertion that every
authenticated response carries `Cache-Control: no-store` failed. Only
`GET /prescriptions/:id/pdf` set it — because someone had thought about it
specifically for that route.

Every other authenticated endpoint — consultation notes, prescriptions,
profile data, the patient's consultation list — returned PHI with no cache
directive at all.

## Why that matters

With no `Cache-Control`, an intermediary may apply heuristic caching (RFC 9111
§4.2.2) for responses that look cacheable. Concretely:

- a corporate or ISP proxy could store one patient's consultation history and
  serve it to the next requester of the same URL
- a CDN placed in front of the API later would cache authenticated responses by
  default
- browser back/forward navigation can re-display PHI after logout

The failure is silent — nothing in the application errors, and it would only
be discovered by finding the wrong patient's data on someone's screen.

## Decision

A global `CacheControlInterceptor`, registered as the **first**
`APP_INTERCEPTOR`, which sets on every authenticated response:

```
Cache-Control: no-store, no-cache, must-revalidate, private
Pragma: no-cache
Expires: 0
```

Deliberately **deny-by-default**: a route is uncached unless it opts out.
Public, non-PHI routes (doctor search, health checks) may set their own policy;
they must do so explicitly.

## Rationale

**Per-route opt-in was already tried and it already failed.** One route had the
header. The pattern of "remember to add this" does not survive contact with a
growing API — the next PHI endpoint would have had the same hole.

**Ordering is load-bearing.** The interceptor runs first so its header is set
before any handler or later interceptor can write a response. Registered after
the metrics or audit interceptors, a short-circuiting response could escape it.

**`no-store` rather than `no-cache`.** `no-cache` permits storage with
revalidation; `no-store` forbids writing the response to disk at all. For PHI
the distinction matters — a revalidating proxy still has the body on disk.
All four directives are sent because intermediaries in the wild disagree about
which they honour, and `Pragma`/`Expires` cover HTTP/1.0 caches.

## Consequences

**Accepted:** genuinely cacheable authenticated responses cannot be cached by
intermediaries without an explicit exemption. That is the correct default for
a clinical API — the performance work belongs in the server-side Redis cache
(99.87% hit rate under load), not in shared proxies holding PHI.

**Verified:** `test/integration/security.spec.ts` asserts `no-store` on every
authenticated response across all role types, so a new endpoint cannot
regress this without failing CI.

**Wider point:** this was found because the security suite asserted a property
across *every* endpoint rather than testing routes one at a time. Property-style
assertions over a whole surface are how this class of omission gets caught —
the same pattern covers the security headers, RFC 7807 error shape, and the
`x-request-id` on every response.
