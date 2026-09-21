# ADR-0002 — Drizzle ORM over Prisma

**Status:** Accepted · **Date:** 2026-09-15

## Context

The original plan named Prisma. Prisma downloads a platform-specific query
engine binary from `binaries.prisma.sh` at install time. That host is
unreachable from this build environment (TLS blocked), so `prisma generate`
cannot complete and no Prisma-based build is possible here.

That forced a re-evaluation, and the requirements turned out to argue against
Prisma anyway.

## Decision

**Drizzle ORM** over **node-postgres** (`pg`), with hand-written SQL migrations
in `db/migrations/`.

## Rationale

The environment made Prisma impossible, but three requirements made Drizzle
the better fit regardless:

**1. Exact SQL control.** The booking concurrency design
([ADR-0003](0003-booking-concurrency.md)) depends on `SELECT … FOR UPDATE
NOWAIT` and on catching `23P01`/`55P03` SQLSTATEs from a GiST exclusion
constraint. Prisma's `$queryRaw` escape hatch would have carried most of the
critical path anyway — at which point the abstraction is paying costs without
providing benefits.

**2. PostgreSQL-specific DDL.** RANGE partitioning, `EXCLUDE USING GIST`,
generated columns with pinned `regconfig`, and append-only rules are not
expressible in Prisma's schema language. Migrations are hand-written SQL
because the schema uses features the tooling does not model.

**3. No runtime engine.** Drizzle compiles to SQL strings and uses `pg`
directly. No sidecar binary, no separate engine process, a smaller container,
and one less thing to fail at startup.

## Consequences

**Accepted:** a smaller ecosystem; no Prisma Studio; migrations are written by
hand, so a careless `ALTER` is not caught by a schema differ. Mitigated by
migrations running in CI against a real Postgres on every pull request.

**Gained:** the generated SQL is visible and predictable; typed queries without
the type layer obscuring what executes; startup is fast enough that `/readyz`
passes in a couple of seconds.

**Note:** hand-written SQL migrations are arguably the *correct* choice for a
clinical system independent of tooling — a reviewer can read exactly what will
run against production data.
