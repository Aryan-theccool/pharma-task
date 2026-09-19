# 5-minute demo video script

Shot list and narration for the required submission video. Total 5:00.

**Before recording**

```bash
docker compose up -d && docker compose --profile obs up -d
npm run db:reset && npm run seed
```

Have four things open: a terminal, Swagger at `/docs`, Grafana at `localhost:3001`,
and the repo in an editor.

---

## 0:00–0:30 — What this is, and the one hard problem

> "This is a telemedicine backend — booking, consultations, prescriptions,
> payments — built for 100,000 consultations a day with a 200-millisecond read
> budget.
>
> I want to spend most of the five minutes on the part that is actually hard.
> Not CRUD. This: two patients tap *book* on the same 9 AM slot in the same
> millisecond. Exactly one must win, and neither may be charged for an
> appointment that doesn't exist."

*Screen: README's headline table.*

---

## 0:30–1:30 — Booking concurrency, proven live

> "Three independent defences, ordered cheapest first."

*Screen: the three-layer diagram in ARCHITECTURE.md §3.*

> "A Redis lock, then `SELECT FOR UPDATE NOWAIT`, then a GiST exclusion
> constraint in Postgres. Three, because each fails differently — Redis can
> lose a lock to a failover, a row lock only lives inside its transaction, and
> the constraint is absolute but the most expensive to reach."

*Run:*

```bash
npm run test:integration -- booking
```

> "These fire genuinely parallel requests. Nineteen pass, and one of them is
> the case that found a real bug: the *losing* racer's compensation was
> releasing the *winner's* hold, because all the racers shared one hold token.
> A mocked database would have passed."

*Then, the load result:*

```bash
cat load/results/latest.json | jq '.scenarios[3].statusCounts'
# { "201": 1, "409": 19911 }
```

> "Under load: 19,912 concurrent attempts on one slot. One booking. Nineteen
> thousand nine hundred and eleven clean 409s. And 93% of those conflicts were
> caught by the Redis lock before Postgres was ever touched."

---

## 1:30–2:15 — Idempotency

> "The other way to double-book is a retry. Every mutating endpoint requires
> an `Idempotency-Key`."

*Terminal — same key twice:*

```bash
KEY=$(uuidgen)
curl -si -X POST localhost:3000/api/v1/bookings/hold \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' -d "{\"slotId\":\"$SLOT\"}" | head -1
# HTTP/1.1 201 Created

curl -si ... same key, same body | grep -i "idempotent-replay"
# Idempotent-Replay: true
```

> "Replayed — same response, no second booking. Now the same key with a
> *different* payload:"

```bash
# HTTP/1.1 409 Conflict
```

> "409. Either the client has a bug or someone is replaying a captured key.
> Neither should execute silently.
>
> The fingerprint is SHA-256 over *canonical* JSON, not `JSON.stringify` —
> because Postgres `jsonb` doesn't preserve key order, so a round-trip would
> change the hash and break idempotency for entirely innocent reasons. That
> bug actually happened here; it's ADR-0008 now."

---

## 2:15–3:00 — Security and compliance

> "PHI is encrypted at the *field* level, not just at rest. Storage encryption
> does nothing against a leaked database credential."

*Screen: a `SELECT` showing `\x0001...` ciphertext in `profiles`.*

> "AES-256-GCM, with a two-byte key version on every ciphertext — which is what
> makes rotation possible without re-encrypting history.
>
> The audit log is append-only *and* hash-chained."

```bash
curl -H "Authorization: Bearer $ADMIN" localhost:3000/api/v1/admin/audit-logs/verify
# {"verified":true,"checked":1247}
```

> "Each row's hash covers the previous one, so editing any entry breaks
> verification from that point on.
>
> And I'll be straight about the limit: that chain protects the audit table.
> It does *not* detect direct SQL tampering with a prescription row — there's a
> test that proves it doesn't. That needs least-privilege grants and WORM
> backups, which is in the threat model as a known gap rather than something I
> quietly left out."

---

## 3:00–3:45 — Observability

*Screen: Grafana, the Amrutam dashboard.*

> "RED metrics, but the interesting panels are the domain ones."

*Point at each:*

> "Conflicts by defence layer — if `db_constraint` starts firing, the layers
> above it have a bug. Saga compensations — every one of those means money was
> authorised and then reversed, which is a business problem no CPU graph would
> show. Idempotency outcomes — `replay` proves clients are retrying safely.
>
> Thirteen alert rules, all on symptoms rather than causes, each linking to a
> runbook section. Traces and logs share a request id, so an alert leads to a
> trace leads to the exact log lines."

---

## 3:45–4:15 — Testing and CI

> "123 tests. The integration suites run against real Postgres and Redis, not
> mocks — which is why they found three actual bugs."

*Screen: the "Three bugs the tests found" section of the README.*

> "The hold-release race. The canonical JSON break. And a missing
> `Cache-Control: no-store` on authenticated PHI responses — only the PDF route
> had it, so every other endpoint returning medical data could have been cached
> by a shared proxy. Found because the security suite asserts that property
> across *every* endpoint rather than route by route."

*Screen: the CI workflow.*

> "CI runs lint, types, unit, integration against service containers, a
> coverage floor, an OpenAPI drift check so the spec can't diverge from the
> code, npm audit, gitleaks, CodeQL, Trivy, and a container boot-and-SIGTERM
> smoke test."

---

## 4:15–4:45 — Infrastructure

*Screen: `infra/terraform/` tree.*

> "Six Terraform modules, dev and prod from the same root. Three subnet tiers —
> and the isolated tier holding the database has no NAT route at all, so a
> compromised container has no network path to exfiltrate anything.
>
> Terraform never holds a secret value: placeholders plus `ignore_changes`, and
> RDS generates its own master password. State isn't a credential dump.
>
> The API autoscales on request count rather than CPU, because an I/O-bound
> Node service is idle on CPU exactly when it's falling behind."

---

## 4:45–5:00 — Close

> "Everything is documented: a four-page architecture doc, an OWASP-mapped
> security checklist, a STRIDE threat model, and nine ADRs explaining why each
> decision was made — including the two forced by the build environment and
> the gaps I haven't closed.
>
> One command to try it: `docker compose up`, then `npm run demo` runs the
> whole platform end to end and asserts 64 invariants. Thanks for watching."

*Screen: `npm run demo` finishing — `64 passed`.*

---

## Recording notes

- **Have the terminal output pre-warmed.** Do not let a 75-second test suite
  play in real time — start it, cut, show the result.
- **Do not read the script verbatim.** The numbers are the point; the phrasing
  is not.
- **If a demo command fails on camera, say so and move on.** A visible recovery
  reads better than an edit.
- Keep Grafana on a 6-hour window so the panels have data.
- 1080p minimum, and make the terminal font large enough to read on a phone.
