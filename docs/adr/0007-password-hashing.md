# ADR-0007 — scrypt over bcrypt and argon2

**Status:** Accepted · **Date:** 2026-09-15

## Context

Passwords need a slow, salted, memory-hard hash. The realistic candidates are
bcrypt, argon2id and scrypt.

## Decision

**scrypt** via Node's built-in `crypto`, with N=32768, r=8, p=1, keyLen=32.
Encoded as `scrypt$N$r$p$saltB64$hashB64`; verification uses
`crypto.timingSafeEqual`.

## Rationale

**Argon2id is the better algorithm** — it is the Password Hashing Competition
winner and the current OWASP first recommendation. It is not chosen here for a
deployment reason: `argon2` and `node-argon2` are native modules requiring a
compile toolchain at install. That means either shipping build tools in the
runtime image (larger attack surface, contradicting the read-only,
capability-dropped container) or maintaining prebuilt binaries per
architecture — and this image is built for both ARM64 and x86_64.

**scrypt is memory-hard; bcrypt is not.** bcrypt's 4 KB working set fits
trivially in GPU and ASIC memory. scrypt at N=32768, r=8 requires ~32 MB per
hash, which is what makes parallel cracking expensive. Between the two
toolchain-free options, scrypt is the stronger one.

**scrypt is in the Node standard library.** No native dependency, no supply
chain risk from a transitive package on the authentication path, nothing to
rebuild when Node updates. For the single most security-critical function in
the system, "no third-party code" has real value.

**The parameters are deliberate.** N=32768 (2^15) with r=8 gives ~32 MB and
~100 ms per hash on the target hardware — slow enough to make offline cracking
costly, fast enough that login stays responsive and a login flood does not
become a self-inflicted CPU exhaustion. Node's default `maxmem` must be raised
to accommodate N=32768; forgetting that produces a runtime error rather than a
silent weakening, which is the correct failure mode.

The encoded format carries its own parameters, so raising N later does not
invalidate existing hashes — old passwords verify with their stored parameters
and can be transparently upgraded on next login.

## Consequences

**Accepted:** argon2id would resist side-channel and TMTO attacks slightly
better. The gap between argon2id and correctly-parameterised scrypt is much
smaller than the gap between either and bcrypt, and both are far beyond the
point where password cracking is the cheapest attack path — phishing and
credential stuffing are, which is why TOTP MFA and the 5-attempts-per-15-minutes
lockout matter more here.

**Revisit if** a maintained pure-JS or WASM argon2id implementation becomes
viable, or if the container base image gains a toolchain for other reasons.

**Also enforced:** `PasswordService.validateStrength` requires ≥12 characters
with lower, upper, digit and symbol, and rejects a denylist
(`password`, `qwerty`, `123456`, `letmein`, `admin`, `welcome`, `amrutam`).
Hash strength does not help against `Password123!`.
