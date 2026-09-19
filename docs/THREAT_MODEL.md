# Threat model

STRIDE analysis of the Amrutam telemedicine backend, plus attack-surface
enumeration and the abuse cases specific to a clinical booking platform.

---

## 1. System decomposition and trust boundaries

```
  ┌───────────── UNTRUSTED ─────────────┐
  │  Patients · Doctors · Attackers     │
  └──────────────┬──────────────────────┘
                 │  TB-1: internet → edge
  ┌──────────────▼──────────────────────┐
  │  WAF + ALB   (TLS termination)      │
  └──────────────┬──────────────────────┘
                 │  TB-2: edge → application
  ┌──────────────▼──────────────────────┐
  │  API tasks (private subnets)        │
  │  guards → interceptors → services   │
  └───┬───────────────┬─────────────┬───┘
      │ TB-3          │ TB-4        │ TB-5
  ┌───▼────┐    ┌─────▼────┐  ┌─────▼──────┐
  │Postgres│    │  Redis   │  │  Payment   │
  │isolated│    │ isolated │  │  provider  │
  └────────┘    └──────────┘  └────────────┘
                                 UNTRUSTED
```

| Boundary | Crossing | Primary control |
| --- | --- | --- |
| TB-1 | Any internet request | WAF rate limiting + managed rule sets, TLS 1.2+ |
| TB-2 | Authenticated request | JWT verification, RBAC, ownership checks, idempotency |
| TB-3 | Database access | Security-group isolation, TLS, least-privilege grants |
| TB-4 | Cache/lock access | Security-group isolation, TLS, AUTH token |
| TB-5 | Payment API + inbound webhook | HMAC signature over raw body, timestamp window, circuit breaker |

**Assets, in priority order:** PHI (diagnoses, prescriptions, notes) → patient
PII → credentials and tokens → the audit trail's integrity → payment records →
availability of the booking flow.

---

## 2. STRIDE

### Spoofing

| Threat | Likelihood / Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| Credential stuffing against patient accounts | High / High | scrypt, 5-per-15-min lockout, rate limits, `auth_events_total` alert | Med — no breached-password check |
| Stolen refresh token replayed | Med / High | Rotation + **family revocation on reuse**; tokens stored hashed | Low |
| Forged JWT | Low / Critical | HS256 with a 256-bit secret in Secrets Manager; `alg` pinned | Low |
| TOTP code interception | Low / High | 30 s window, replay blocked per code | Low |
| Doctor impersonation to issue prescriptions | Low / Critical | MFA mandatory for doctors; prescriptions HMAC-signed and bound to the consultation's doctor | Low |
| Forged payment webhook | Med / High | HMAC over raw body, ±300 s window, dedupe; **missing and invalid signatures both 403 with identical bodies** | Low |

Identical responses for missing versus invalid signatures is deliberate — a
different message tells an attacker their probe reached the verification step.

### Tampering

| Threat | Likelihood / Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| Modify a signed prescription | Low / Critical | Immutable after signing (re-sign → 409); HMAC over canonical JSON | Low |
| Alter or delete audit entries | Low / Critical | Append-only rules + hash chain; `verify` endpoint | Low |
| **Direct SQL tampering with clinical rows** | Low / Critical | Least-privilege grants, CloudTrail, WORM backups | **Med — not detected in-app** |
| Idempotency-key replay with a mutated payload | Med / Med | SHA-256 fingerprint over canonical JSON → 409 | Low |
| SQL injection | Med / Critical | Parameterised queries throughout; DTO whitelisting | Low |
| Mass assignment | Med / High | `forbidNonWhitelisted: true`; role never bindable from a request body | Low |

The clinical-row row is the honest weak point. The hash chain covers
`audit_logs`, not `prescriptions` — confirmed by
`test/integration/consultation.spec.ts`, which successfully tampers with
`prescriptions.diagnosis_enc` via direct SQL. Defence lives outside the
application.

### Repudiation

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Doctor denies issuing a prescription | HMAC signature + audit entry + immutability | Low |
| Patient denies booking | Audit trail with IP, request id, trace id; payment record | Low |
| Admin denies a PII erasure | Step-up MFA + audit entry; the action itself is logged before execution | Low |
| Insider edits logs to hide activity | Hash chain detects; offsite hash copies make forgery infeasible | Low–Med |

### Information Disclosure

| Threat | Likelihood / Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| Database credential leak → bulk PHI read | Med / Critical | **Field-level encryption** — ciphertext without the KMS key is useless | Low |
| PHI cached by an intermediary proxy | Med / High | Global `no-store` ([ADR-0009](adr/0009-response-caching.md)) | Low |
| IDOR across patients | Med / Critical | Ownership checks returning **404** | Low |
| Patient enumeration via login responses | High / Low | Generic messages; duplicate registration reveals nothing | Low |
| PHI in logs | Med / High | Pino redaction; `log_statement='ddl'` so Postgres never logs parameters | Low–Med |
| PHI in error responses | Med / Med | RFC 7807 with no internals; stack traces suppressed | Low |
| Timing oracle on email existence | Low / Low | Constant-time password comparison; blind-index lookup | Low |
| Exfiltration after container compromise | Low / Critical | Data subnets have **no NAT route**; egress limited to 443 | Low |

### Denial of Service

| Threat | Likelihood / Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| Volumetric flood | Med / High | WAF per-IP rate limit, ALB, autoscaling to 30 tasks | Low |
| Application-layer flood on expensive routes | Med / High | Per-route limits; search is Redis-cached (99.87% hit rate) | Low |
| **Login flood exhausting CPU via scrypt** | Med / High | 10/min per IP on login; scrypt tuned to ~100 ms | Med |
| Slot-lock exhaustion (hold and abandon) | Med / Med | 5-min hold TTL; per-user booking limits | Med |
| Connection-pool exhaustion via a slow PSP | Med / High | Circuit breaker + `statement_timeout` | Low |
| Redis outage | Low / Med | Rate limiter fails open; booking still has 2 DB defences | Low |
| Unbounded table growth | High / Med | Monthly partitioning; retention by `DETACH PARTITION` | Low |

scrypt is intentionally expensive, which makes the login endpoint the natural
CPU-exhaustion target. The per-IP limit bounds it, but a distributed attack
from many IPs remains the most plausible DoS vector.

### Elevation of Privilege

| Threat | Likelihood / Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| Self-registering as admin | Med / Critical | Role forced to `patient` unless `doctor`; admin never self-assignable | Low |
| Patient accessing doctor endpoints | Med / High | `RolesGuard` + ownership checks | Low |
| Unverified doctor taking bookings | Med / High | Public search filters `verification_state='verified'` | Low |
| Container escape → host | Low / Critical | Fargate isolation, read-only rootfs, all capabilities dropped, non-root | Low |
| Over-broad IAM | Med / High | Task role scoped to specific bucket, specific secrets, namespaced metrics | Low |
| Lateral movement from a compromised task | Low / High | SGs reference SGs not CIDRs; database SG has **no egress rule** | Low |

---

## 3. Attack surface

| Surface | Exposure | Hardening |
| --- | --- | --- |
| 46 REST paths / 50 operations | Public via ALB | **10 unauthenticated**, the other 40 behind the guard chain |
| `POST /auth/login` | Unauthenticated | Lockout, rate limit, generic errors, constant-time compare |
| `POST /auth/register` | Unauthenticated | 5/min per IP, strength rules, role forced |
| `POST /payments/webhook` | Unauthenticated by design | HMAC over raw body, timestamp window, dedupe |
| `POST /auth/refresh` | Unauthenticated (bearer-free by design) | Rotation, family revocation on reuse, 30/min per IP |
| `GET /doctors/search` | Unauthenticated | Cached, verified-only, `plainto_tsquery`, 120/min per IP |
| `GET /doctors/:id`, `GET /doctors/:id/slots` | Unauthenticated | Verified-only; slot data is non-PHI availability |
| `/docs` (Swagger) | Dev only | `SWAGGER_ENABLED=false` in prod |
| `/healthz`, `/readyz`, `/metrics` | Unauthenticated | No PHI; `/metrics` is not routed through the ALB |
| SSH / shell access | None | No SSH; ECS exec disabled in prod |
| Database port | Isolated subnet | Reachable only from the tasks' SG |

**Unauthenticated surface is ten routes**, and only seven are reachable
through the ALB with a body worth attacking: three auth endpoints, three
read-only doctor-directory endpoints and the payment webhook. That count is
the number worth minimising, and each entry above has a control specific to
how it gets abused. Everything else — all PHI, all mutations beyond auth —
sits behind `RateLimit → Jwt → Roles → Mfa`.

---

## 4. Domain-specific abuse cases

Beyond STRIDE — these are the ways a *telemedicine booking platform*
specifically gets abused:

| Abuse | Impact | Mitigation | Residual |
| --- | --- | --- | --- |
| **Slot squatting** — bulk-hold a competitor's slots and never confirm | Doctor's calendar appears full; revenue lost | 5-min TTL, idempotency, per-user hold limits, `booking_attempts_total` | **Med** — a distributed, patient attacker could sustain it |
| **Prescription farming** — book trivial consultations to obtain controlled-substance prescriptions | Regulatory catastrophe | Prescriptions bound to a completed consultation by the assigned doctor; every issuance audited | Med — requires clinical policy, not only code |
| **Review manipulation** — fake consultations to inflate ratings | Trust erosion | Reviews require a completed, paid consultation | Low |
| **Data scraping** of the doctor directory | Competitive loss | Rate limits, pagination caps, WAF bot rules | Med |
| **Refund abuse** — book, attend, cancel within the refund window | Revenue loss | Full refund only if cancelled ≥24 h before `scheduled_at`; state machine blocks refunds after `in_progress` | Low |
| **Insider browsing** of celebrity patient records | Privacy breach, legal exposure | Every PHI access audited with actor and trace id | **Med** — detection, not prevention; needs anomaly alerting |
| **Doctor account takeover** → mass prescription issuance | Critical | Mandatory MFA, refresh-token family revocation, audit | Low |

The two `Med` residuals worth flagging to a reviewer are **slot squatting**
(economically motivated, hard to distinguish from indecisive users) and
**insider browsing** (audited but not alerted on — the next control here is
anomaly detection on access volume per actor).

---

## 5. Prioritised remediation

| # | Item | Severity | Effort |
| --- | --- | --- | --- |
| 1 | Stuck-saga reconciler ([ADR-0004](adr/0004-saga-vs-2pc.md)) | High | Low |
| 2 | Anomaly alerting on per-actor PHI access volume | High | Med |
| 3 | WORM/object-locked backups of `audit_logs` | High | Low |
| 4 | Breached-password check (k-anonymity HIBP API) at registration | Med | Low |
| 5 | Renovate + SBOM + image signing | Med | Low |
| 6 | Per-user concurrent-hold cap to blunt slot squatting | Med | Low |
| 7 | Chaos test: kill Redis mid-booking, assert DB defences hold | Med | Med |
| 8 | Third-party penetration test | Med | High |

---

## 6. Assumptions

This model assumes: AWS account-level security (root MFA, CloudTrail,
GuardDuty) is handled outside this repository; a BAA is signed with AWS before
real PHI is stored; the payment provider is PCI-DSS compliant and no card data
touches this system; administrators are vetted; and TLS certificates are
managed by ACM.

Reviewed against OWASP Top 10 (2021), OWASP API Security Top 10 (2023), and
the HIPAA Security Rule's technical safeguards.
