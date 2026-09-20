# Security checklist

Controls implemented in this codebase, with the file that implements each and
the test that proves it. Items not implemented are marked **Gap** rather than
omitted — an incomplete checklist that is honest is more useful than a
complete one that is not.

---

## 1. OWASP Top 10 (2021)

### A01 — Broken Access Control

| Control | Implementation | Verified by |
| --- | --- | --- |
| Guard chain on every route | `RateLimit → Jwt → Roles → Mfa` (`app.module.ts`) | `security.spec.ts` |
| Per-resource ownership checks | Service layer, not just role checks | `consultation.spec.ts` |
| Non-owner gets **404, not 403** | `consultations.service.ts`, `prescriptions.service.ts` | `consultation.spec.ts` |
| Role escalation blocked at registration | `role` forced to `patient` unless explicitly `doctor`; `admin` never self-assignable | `auth.spec.ts` |
| Step-up MFA for destructive actions | `@RequireMfa()` on PII erasure, MFA disable | `security.spec.ts` |
| Deny-by-default response caching | `CacheControlInterceptor`, first in the chain | `security.spec.ts` |

Returning **404 for a resource owned by someone else** is deliberate: a 403
confirms the id exists, which turns id enumeration into a patient-census
oracle.

### A02 — Cryptographic Failures

| Control | Implementation |
| --- | --- |
| PHI encrypted at field level | AES-256-GCM, `[2B keyVersion \| 12B IV \| ciphertext \| 16B tag]` |
| Key derivation | HKDF-SHA256 from master key, `info='amrutam-dek'`, `salt='v{version}'` |
| Searchable email without plaintext | HMAC-SHA256 blind index |
| Passwords | scrypt N=32768 r=8 p=1, `timingSafeEqual` ([ADR-0007](adr/0007-password-hashing.md)) |
| TLS | 1.2 minimum at the ALB (TLS13-1-2-Res policy); `rds.force_ssl=1`; Redis transit encryption |
| At rest | KMS CMKs for RDS, ElastiCache, S3, CloudWatch |
| No secrets in images or state | Secrets Manager injected at task start; Terraform holds placeholders only |

`FieldEncryptionService.decrypt` returns `null` for null/short input and
**throws on tampering** — a modified ciphertext or tag fails GCM
authentication rather than returning garbage.

### A03 — Injection

- Parameterised queries throughout (Drizzle + `pg`); no string-concatenated SQL.
- `class-validator` DTOs with `whitelist: true` and `forbidNonWhitelisted: true`
  — unknown properties are rejected, not silently ignored.
- Zod-validated environment configuration; the app refuses to boot on a bad value.
- Full-text search uses `plainto_tsquery`, never interpolated operators.

### A04 — Insecure Design

Documented in the ADRs: triple-defence concurrency, saga compensation,
hash-chained audit, canonical JSON. The 5-minute hold TTL, mandatory
idempotency keys, and fail-fast `NOWAIT` are all design-level choices, not
patches.

### A05 — Security Misconfiguration

| Control | Detail |
| --- | --- |
| Security headers | `helmet`: HSTS, `X-Content-Type-Options: nosniff`, CSP with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` |
| `X-Powered-By` removed | Verified by test |
| Swagger disabled in production | `SWAGGER_ENABLED=false` in the prod stack |
| CORS explicit | Never `*` in production; origins enumerated per environment |
| Read-only root filesystem | ECS task definition; only `/tmp` and `/app/storage` writable |
| All Linux capabilities dropped | `linuxParameters.capabilities.drop = ["ALL"]` |
| Non-root container user | `Dockerfile` runs as `node` |
| Error responses | RFC 7807, no stack traces or internals leaked |

### A06 — Vulnerable and Outdated Components

- `npm audit --audit-level=high` in CI, fails the build.
- **Trivy** scans the built image for OS and library CVEs.
- **CodeQL** static analysis on every push.
- **Gitleaks** blocks committed secrets.
- ECR scan-on-push as a second opinion.
- **Gap:** no automated dependency-update bot. Renovate or Dependabot should be
  enabled — scanning finds vulnerabilities but nothing currently opens the PR.

### A07 — Identification and Authentication Failures

| Control | Detail |
| --- | --- |
| Short access tokens | 10 minutes (`exp - iat === 600`, asserted) |
| Refresh rotation | Every use issues a new token; the old one is dead |
| **Reuse detection** | A replayed refresh token revokes the whole family (`revoked_reason='reuse_detected'`) |
| Tokens stored hashed | SHA-256; a database leak does not yield usable tokens |
| MFA | TOTP, mandatory for doctor and admin |
| TOTP replay blocked | `mfa:used:{uid}:{code}` for the step window |
| Lockout | 5 failed attempts per 15 minutes |
| Generic failure messages | Duplicate registration returns 409 without the word "already" or the address |
| Password strength | ≥12 chars, mixed classes, denylist |

Refresh-token family revocation is the notable one: it converts a stolen
refresh token from silent persistent access into a detected, contained event.

### A08 — Software and Data Integrity Failures

- Prescriptions are HMAC-signed and **immutable after signing** (re-sign → 409).
- Audit log hash-chained ([ADR-0006](adr/0006-audit-hash-chain.md)).
- Webhook signatures verified over the raw body with a ±300 s timestamp window.
- ECR `IMMUTABLE` tags — an image tag cannot be repointed at different bytes.
- `package-lock.json` committed; CI uses `npm ci`.

### A09 — Security Logging and Monitoring Failures

- Every mutation writes an audit row **in the same transaction**.
- Structured Pino logs with PHI redaction; `x-request-id` and trace id on every line.
- `auth_events_total{event,result}` with an alert on failed-login spikes.
- VPC flow logs, ALB access logs, CloudTrail, RDS `log_connections`.
- 13 Prometheus alert rules, each linking to a runbook section.

### A10 — Server-Side Request Forgery

- No user-supplied URL is fetched by the application.
- Tasks run in private subnets; egress limited to 443.
- Data-tier subnets have **no NAT route at all**.

---

## 2. Data classification

| Class | Data | Controls |
| --- | --- | --- |
| **PHI** | Diagnoses, prescriptions, consultation notes, medical history | Field-level AES-256-GCM, `no-store`, audit on every access, 7-year retention |
| **PII** | Name, email, phone, DOB, address | Field encryption, blind index for email, erasable via crypto-shredding |
| **Credentials** | Passwords, TOTP secrets, refresh tokens, API keys | scrypt / encrypted / hashed; never logged, never in state |
| **Financial** | Payment amounts, provider references | Encrypted; no card data ever touches this system (PSP-hosted) |
| **Operational** | Metrics, traces, access logs | Not encrypted at field level; PHI-redacted |
| **Public** | Doctor profiles, specialisations, fees | No restriction; the only data served uncached |

No cardholder data enters the system — payment collection is delegated to the
provider, which keeps this out of PCI-DSS scope beyond SAQ-A.

---

## 3. Encryption and key management

**Key hierarchy**

```
AWS KMS CMK (amrutam-{env}-app)      ← rotated annually by AWS
   └── wraps ENCRYPTION_MASTER_KEY   ← in Secrets Manager
          └── HKDF-SHA256 → per-version DEK
                 └── AES-256-GCM per field
```

**Rotation.** The 2-byte `key_version` prefix on every ciphertext is what makes
rotation operationally possible: new writes use the new version, existing rows
decrypt with theirs, and no migration is required. `scripts/rotate-keys.ts`
adds a version; `encryption_keys` tracks status.

| Key | Rotation | Method |
| --- | --- | --- |
| KMS CMKs | Annual | Automatic (AWS) |
| Field-encryption master | Annual or on suspicion | `npm run keys:rotate`, version bump |
| JWT access/refresh secrets | Quarterly | Secrets Manager + rolling restart |
| Prescription signing key | Annual | Versioned; old signatures stay verifiable |
| Redis AUTH token | Annual | Terraform var + replication-group update |
| RDS master password | 30 days | `manage_master_user_password` (automatic) |

**Crypto-shredding for erasure.** `DELETE /users/:id/pii` (admin + step-up MFA)
destroys the subject's field keys rather than the rows. PII becomes
undecryptable while clinical records — which must be retained for 7 years —
remain intact and countable. This is how the GDPR/DPDP erasure right and
clinical retention obligations are satisfied simultaneously.

---

## 4. Audit trail

- Append-only, enforced by PostgreSQL rules.
- Hash-chained; `GET /admin/audit-logs/verify` returns `{verified, checked, brokenAtId?}`.
- Monthly RANGE partitioning for 7-year retention without table bloat.
- Records actor, role, action, resource, outcome, IP, request id, trace id,
  before/after.

**Scope limit (see [ADR-0006](adr/0006-audit-hash-chain.md)):** the chain
protects `audit_logs` only. Direct SQL modification of a clinical row is *not*
detected by it — confirmed by test. Compensating controls: least-privilege
grants (`db/migrations/0004_grants.sql`), CloudTrail on RDS, WORM backups.

---

## 5. Dependency and supply chain

| Control | Status |
| --- | --- |
| `npm audit --audit-level=high` in CI | Implemented |
| Trivy image scan | Implemented |
| CodeQL | Implemented |
| Gitleaks | Implemented |
| Lockfile committed, `npm ci` | Implemented |
| Multi-stage build, no toolchain in runtime | Implemented |
| Automated dependency PRs | **Gap** — enable Renovate |
| SBOM generation | **Gap** — add `syft` to the docker job |
| Image signing (cosign) | **Gap** |

---

## 6. Pre-production checklist

- [ ] Replace every Secrets Manager placeholder with a generated value
- [ ] `SWAGGER_ENABLED=false`, `CORS_ORIGINS` set to real origins
- [ ] `RATE_LIMIT_ROUTE_MULTIPLIER=1` (load-test only)
- [ ] `enable_exec = false` on the prod stack
- [ ] ACM certificate issued; HTTP→HTTPS redirect confirmed
- [ ] Alarm SNS topic subscribed to a real pager
- [ ] Restore a backup into a scratch environment and verify the audit chain
- [ ] Penetration test
- [ ] Sign a BAA with AWS before real PHI is stored
- [ ] Enable Renovate, SBOM, image signing
- [ ] Set `INTEGRITY_PROOF_KEY` to a dedicated KMS key, **separate from
      `ENCRYPTION_MASTER_KEY`** — sharing them means one leak defeats both
      confidentiality and tamper detection
- [ ] Confirm the runtime role is `app_user`, not the table owner: the journal
      grants (SELECT only) are what stop the application forging its own history
- [ ] Verify `clinical_integrity_last_run_timestamp_seconds` is being scraped —
      a silent detector is an unmonitored window
- [ ] `PAYMENT_PROVIDER=razorpay` with live keys; the app refuses to boot with
      the mock gateway when `NODE_ENV=production`
- [ ] Run the PSP go-live checklist in [RUNBOOK.md](RUNBOOK.md)

---

## 7. Known gaps

Stated plainly, because a security document that claims completeness is a
security document nobody should trust:

1. **Rate limiter fails open** on a Redis outage — a deliberate
   availability trade-off; the WAF is the fail-closed backstop.
2. **Payment adapter is contract-tested, not sandbox-tested.** The Razorpay
   adapter (`src/modules/payments/razorpay.gateway.ts`) implements the
   documented HTTP contract and is asserted by
   `test/unit/razorpay-gateway.spec.ts` — request shape, auth header,
   idempotency propagation, 4xx-vs-5xx retry behaviour, signature verification
   and paise conversion. It has **not** been run against Razorpay's live
   sandbox, because this build environment has no outbound access to their
   API. The go-live checklist in [RUNBOOK.md](RUNBOOK.md) covers that step.
3. **No automated dependency updates** — scanning detects, nothing remediates.
4. **No penetration test** — no third party has attacked this.
5. **Integrity detection is detective, not preventive.** An attacker with a
   database credential can still *make* a clinical write; what changed is that
   they can no longer make one unnoticed. Prevention remains the job of the
   least-privilege grants in `0004_grants.sql` and IAM.
6. **Baseline rows attest only from the moment protection was enabled.** Rows
   that predate `0005_clinical_integrity.sql` are journaled with a `baseline`
   marker; the control cannot speak to what happened to them before that point.

### Closed since the first draft

Recorded here rather than deleted, because how a gap was closed is part of the
security argument:

- **Clinical-row tampering is now detected.** Previously the hash chain covered
  `audit_logs` only, so a direct `UPDATE prescriptions ...` was invisible. A
  SECURITY DEFINER trigger now journals every clinical mutation with a
  per-process HMAC **proof of application origin**; the key lives outside the
  database, so a party with database access cannot mint one. Six checks catch
  the corresponding evasions — unattributed writes, rows changed with the
  trigger disabled, unjournaled inserts, vanished rows, edited journal entries
  and deleted journal ranges. Proven by nine tests in
  `test/integration/integrity.spec.ts`, each of which performs the actual
  attack. See [ADR-0010](adr/0010-clinical-integrity.md).
- **Stuck sagas now self-heal.** A process killed mid-saga used to leave the
  slot held and the payment authorized indefinitely. A reconciler claims stale
  sagas with `FOR UPDATE SKIP LOCKED`, compensates in reverse order, and
  dead-letters anything it cannot fix instead of retrying forever. See
  [ADR-0011](adr/0011-saga-recovery.md).
