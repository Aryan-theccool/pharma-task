# ADR-0001 — Modular monolith over microservices

**Status:** Accepted · **Date:** 2026-09-15

## Context

The brief asks for a system handling 100k consultations/day with 99.95%
availability. "Microservices" is the reflexive answer to that sentence, so the
choice deserves an explicit justification rather than a default.

The domain has a hard constraint: **booking, payment and consultation state
change together**. A confirmed booking creates a consultation, captures a
payment and marks a slot taken. Either all three happen or none do.

## Decision

A **modular monolith**: one deployable, 11 feature modules with explicit
boundaries, one PostgreSQL database. Two process roles (API, worker) from the
same image.

## Rationale

**The transaction argument.** Across services, the booking flow needs a
distributed transaction. Inside one database it is `BEGIN … COMMIT`. We still
implement a saga for the *payment provider* (a genuinely external party, see
[ADR-0004](0004-saga-vs-2pc.md)), but that is one boundary rather than four.
Splitting would mean adopting eventual consistency in a system that charges
money for appointments.

**The volume argument.** 100k consultations/day is ~1.2/second averaged, ~12/s
at peak. Measured throughput on a single 2-vCPU task is ~1,900 rps for reads.
There is no throughput case for splitting — the numbers are two orders of
magnitude apart.

**The team argument.** Microservices solve an *organisational* problem: teams
deploying without coordinating. With one team, they add network partitions,
distributed tracing complexity and schema-coordination overhead while solving
nothing.

**Keeping the option open.** Modules communicate through service interfaces,
never by reaching into each other's tables. Each owns its schema area. The
transactional outbox already publishes domain events. Extracting a module
means pointing it at its own database and turning an in-process call into an
HTTP one — mechanical, if it is ever justified.

## Consequences

**Accepted:** the whole application scales as a unit; a memory leak anywhere
affects everything; the repository grows large enough that module boundaries
must be actively defended in review.

**Gained:** ACID across the core flow; one deploy artefact; local development
with `docker compose up`; a trace that does not span four services.

**Mitigated:** the API/worker split already separates the two workloads with
genuinely different scaling characteristics — which is where the real
contention was.

## Revisit when

Any of: a second team needs an independent deploy cadence; one module's
resource profile diverges sharply (video transcoding, ML inference); a single
module's write volume outgrows one Postgres primary.
