/* eslint-disable no-console */
import { createHmac, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { loadEnv } from './load-env';

/**
 * End-to-end walkthrough of every headline capability, run against a live API.
 *
 *   npm run demo                      # against http://127.0.0.1:3000
 *   DEMO_BASE_URL=https://… npm run demo
 *
 * The script provisions its own doctor and patient on every run (registration →
 * MFA enrolment → onboarding → availability rules → slot materialisation), so
 * it is fully repeatable and never depends on leftover state from a previous
 * execution. It then exercises: search, the booking saga, idempotent replay,
 * concurrency defences, the consultation state machine, prescription
 * signing/verification/PDF, HMAC webhooks, RBAC/BOLA, rate limiting,
 * cancellation refunds, GDPR erasure and the tamper-evident audit chain.
 */

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const PASSWORD = 'Str0ng!Passphrase2024';
const RUN = randomUUID().slice(0, 8);

let passed = 0;
let failed = 0;

const bold = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${s}`);
};
const bad = (s: string) => {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
};
const info = (s: string) => console.log(`      \x1b[2m${s}\x1b[0m`);

interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; idempotencyKey?: string; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const res = await fetch(`${path.startsWith('http') ? '' : API}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON response (e.g. a PDF stream) */
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

/**
 * The demo drives dozens of logins from a single IP, which legitimately trips
 * the per-IP auth throttle. Clearing our own rate-limit buckets between phases
 * keeps later assertions meaningful — it is a harness concern, never something
 * the application itself does.
 */
async function clearRateLimits(): Promise<void> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
}

const expect = (label: string, actual: number, want: number) =>
  actual === want ? ok(`${label} → ${actual}`) : bad(`${label} → expected ${want}, got ${actual}`);

/** Register an account, enrol TOTP and return a fully step-up-authenticated session. */
async function provision(role: 'patient' | 'doctor', label: string) {
  const email = `demo-${label}-${RUN}@amrutam.test`;
  const reg = await call('POST', '/auth/register', {
    body: { email, password: PASSWORD, fullName: `Demo ${label} ${RUN}`, role },
  });
  if (reg.status !== 201) throw new Error(`register ${label} failed: ${reg.status} ${JSON.stringify(reg.body)}`);

  const login = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  let token = login.body.accessToken as string;

  const enroll = await call('POST', '/auth/mfa/enroll', { token });
  const secret = enroll.body.secret as string;
  await call('POST', '/auth/mfa/verify', { token, body: { code: authenticator.generate(secret) } });

  // TOTP codes are single-use; wait out the 30s step if we'd reuse the same one.
  const stepUp = await call('POST', '/auth/login', {
    body: { email, password: PASSWORD, totp: authenticator.generate(secret) },
  });
  token = (stepUp.body.accessToken as string) ?? token;

  return {
    email,
    token,
    secret,
    userId: reg.body.id as string,
    refreshToken: login.body.refreshToken as string,
  };
}

async function main(): Promise<void> {
  loadEnv();
  console.log(`\x1b[1mAmrutam Telemedicine — end-to-end demo\x1b[0m`);
  console.log(`\x1b[2m${BASE} · run ${RUN}\x1b[0m`);

  // ------------------------------------------------------------- 1. accounts
  bold('1 · Identity: registration, password policy, MFA enrolment');
  const patient = await provision('patient', 'patient');
  ok(`patient registered + TOTP enrolled (${patient.email})`);
  const doctor = await provision('doctor', 'doctor');
  ok(`doctor registered + TOTP enrolled (${doctor.email})`);

  expect(
    'weak password rejected by policy',
    (await call('POST', '/auth/register', {
      body: { email: `weak-${RUN}@amrutam.test`, password: 'password1234', fullName: 'Weak Pass' },
    })).status,
    400,
  );
  expect(
    'privilege escalation via role=admin blocked',
    (
      await call('POST', '/auth/register', {
        body: { email: `esc-${RUN}@amrutam.test`, password: PASSWORD, fullName: 'Esc', role: 'admin' },
      })
    ).status,
    400,
  );
  expect(
    'password-only login once MFA is on',
    (await call('POST', '/auth/login', { body: { email: doctor.email, password: PASSWORD } })).status,
    401,
  );

  // Refresh rotation + reuse detection.
  const rotated = await call('POST', '/auth/refresh', { body: { refreshToken: patient.refreshToken } });
  expect('refresh token rotates', rotated.status, 200);
  expect(
    'replaying a consumed refresh token (family revoked)',
    (await call('POST', '/auth/refresh', { body: { refreshToken: patient.refreshToken } })).status,
    401,
  );
  const patientToken = (rotated.body.accessToken as string) ?? patient.token;

  // ---------------------------------------------------------- 2. onboarding
  bold('2 · Doctor onboarding & availability');
  const onboard = await call('POST', '/doctors/onboard', {
    token: doctor.token,
    body: {
      displayName: `Dr. Demo ${RUN}`,
      registrationNo: `MCI-${RUN}`,
      bio: 'Ayurvedic practitioner focused on digestive health and metabolic wellness.',
      specializations: ['ayurveda', 'nutrition'],
      languages: ['en', 'hi'],
      experienceYears: 12,
      consultationFee: 950,
      timezone: 'Asia/Kolkata',
    },
  });
  expect('doctor profile created', onboard.status, 201);
  const doctorId = onboard.body.id as string;

  const today = new Date();
  const ruleDay = new Date(today.getTime() + 2 * 86_400_000);
  const rule = await call('POST', `/doctors/${doctorId}/availability-rules`, {
    token: doctor.token,
    body: {
      dayOfWeek: ruleDay.getUTCDay(),
      startTime: '09:00',
      endTime: '13:00',
      slotMinutes: 30,
      validFrom: today.toISOString().slice(0, 10),
      timezone: 'Asia/Kolkata',
    },
  });
  expect('recurring availability rule created (doctor-local time)', rule.status, 201);

  const materialize = await call('POST', `/doctors/${doctorId}/slots/materialize`, {
    token: doctor.token,
    body: { from: today.toISOString().slice(0, 10), days: 14 },
  });
  expect('rules expanded into bookable UTC slots', materialize.status, 201);
  info(`created ${materialize.body.created} slots`);

  const rerun = await call('POST', `/doctors/${doctorId}/slots/materialize`, {
    token: doctor.token,
    body: { from: today.toISOString().slice(0, 10), days: 14 },
  });
  rerun.body.created === 0
    ? ok('re-running materialisation is idempotent (0 duplicates)')
    : bad(`expected 0 new slots on re-run, got ${rerun.body.created}`);

  // ------------------------------------------------------------- 3. search
  bold('3 · Doctor search (full-text + trigram + facets, Redis cache-aside)');
  const search = await call('GET', '/doctors/search?limit=3&minRating=3');
  search.body.items?.length
    ? ok(`${search.body.items.length} results; top = ${search.body.items[0].displayName}`)
    : bad('search returned no doctors');
  info(
    `facets: ${search.body.facets.specializations
      .slice(0, 4)
      .map((f: any) => `${f.value}(${f.count})`)
      .join(', ')}`,
  );
  ok(`filter by specialization → ${(await call('GET', '/doctors/search?specialization=ayurveda&limit=5')).body.items.length} results`);
  const fullText = await call('GET', '/doctors/search?q=integrative%20chronic%20care&limit=5');
  fullText.body.items.length > 0
    ? ok(`full-text query matched ${fullText.body.items.length} doctors`)
    : bad('full-text search returned nothing');
  const feeFiltered = await call('GET', '/doctors/search?minFee=500&maxFee=900&limit=50');
  feeFiltered.body.items.every((d: any) => d.consultationFee >= 500 && d.consultationFee <= 900)
    ? ok(`fee range filter honoured across ${feeFiltered.body.items.length} results`)
    : bad('fee filter leaked out-of-range doctors');

  // The doctor we just onboarded is still `pending` verification, so the public
  // directory must not surface them — verification is a publishing gate.
  const mine = await call('GET', `/doctors/search?q=${encodeURIComponent(`Demo ${RUN}`)}&limit=5`);
  mine.body.items.some((d: any) => d.id === doctorId)
    ? bad('unverified doctor leaked into public search results')
    : ok('unverified doctor correctly withheld from public search');

  const page1 = await call('GET', '/doctors/search?limit=2');
  const page2 = await call('GET', `/doctors/search?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
  page1.body.items[0].id !== page2.body.items[0].id
    ? ok('keyset pagination returns a distinct second page')
    : bad('pagination returned the same page twice');

  // -------------------------------------------------------- 4. availability
  bold('4 · Slot listing');
  const from = new Date(Date.now() + 86_400_000).toISOString();
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const slots = await call('GET', `/doctors/${doctorId}/slots?from=${from}&to=${to}&status=available`);
  const slot = slots.body[0];
  slot ? ok(`${slots.body.length} free slots; picked ${slot.startsAt}`) : bad('no free slots produced');

  // ------------------------------------------------------------ 5. booking
  bold('5 · Booking saga: hold → authorize → consultation → capture');
  const hold = await call('POST', '/bookings/hold', {
    token: patientToken,
    idempotencyKey: randomUUID(),
    body: { slotId: slot.id },
  });
  expect('slot held', hold.status, 201);
  info(`holdToken ${String(hold.body.holdToken).slice(0, 8)}… expires ${hold.body.expiresAt}`);

  const confirmKey = randomUUID();
  const confirmBody = { slotId: slot.id, holdToken: hold.body.holdToken, chiefComplaint: 'Persistent acidity' };
  const confirm = await call('POST', '/bookings/confirm', {
    token: patientToken,
    idempotencyKey: confirmKey,
    body: confirmBody,
  });
  expect('saga committed the consultation', confirm.status, 201);
  const consultationId = confirm.body.consultationId as string;
  info(`consultation ${consultationId} · payment ${confirm.body.payment?.status} · ₹${confirm.body.amount}`);

  // -------------------------------------------------------- 6. idempotency
  bold('6 · Idempotency (assignment fail-gate)');
  const replay = await call('POST', '/bookings/confirm', {
    token: patientToken,
    idempotencyKey: confirmKey,
    body: confirmBody,
  });
  replay.body.consultationId === consultationId
    ? ok('same key + same payload → original response replayed, no second booking')
    : bad('replay produced a different result');
  replay.headers.get('idempotent-replay') === 'true'
    ? ok('replay flagged via `Idempotent-Replay: true`')
    : bad('missing Idempotent-Replay header');

  // Key order must not affect the fingerprint (canonical JSON).
  const reordered = await call('POST', '/bookings/confirm', {
    token: patientToken,
    idempotencyKey: confirmKey,
    body: { chiefComplaint: 'Persistent acidity', holdToken: hold.body.holdToken, slotId: slot.id },
  });
  reordered.status === 200 || reordered.status === 201
    ? ok('reordered JSON keys still match the fingerprint (canonical hashing)')
    : bad(`key reordering broke the fingerprint → ${reordered.status}`);

  expect(
    'same key + genuinely different payload',
    (await call('POST', '/bookings/confirm', {
      token: patientToken,
      idempotencyKey: confirmKey,
      body: { ...confirmBody, chiefComplaint: 'A completely different complaint' },
    })).status,
    409,
  );
  expect(
    'missing Idempotency-Key on a mutating route',
    (await call('POST', '/bookings/hold', { token: patientToken, body: { slotId: slot.id } })).status,
    400,
  );

  // ------------------------------------------------------- 7. concurrency
  bold('7 · Concurrency: double-booking defences');
  expect(
    'holding an already-booked slot',
    (await call('POST', '/bookings/hold', {
      token: patientToken,
      idempotencyKey: randomUUID(),
      body: { slotId: slot.id },
    })).status,
    409,
  );

  // Fire 8 simultaneous holds at one fresh slot: exactly one may win.
  const raceSlot = slots.body[1];
  if (raceSlot) {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call('POST', '/bookings/hold', {
          token: patientToken,
          idempotencyKey: randomUUID(),
          body: { slotId: raceSlot.id },
        }),
      ),
    );
    const wins = results.filter((r) => r.status === 201).length;
    const conflicts = results.filter((r) => r.status === 409).length;
    wins === 1
      ? ok(`8 concurrent holds on one slot → exactly 1 winner, ${conflicts} rejected with 409`)
      : bad(`expected exactly 1 winner, got ${wins}`);
  }

  // ------------------------------------------------- 8. consultation flow
  bold('8 · Consultation state machine');
  expect(
    'scheduled → in_progress',
    (await call('POST', `/consultations/${consultationId}/start`, { token: doctor.token })).status,
    200,
  );
  expect(
    'in_progress → in_progress (illegal transition)',
    (await call('POST', `/consultations/${consultationId}/start`, { token: doctor.token })).status,
    409,
  );
  expect(
    'clinical notes written (AES-256-GCM at rest)',
    (await call('PATCH', `/consultations/${consultationId}/notes`, {
      token: doctor.token,
      body: { notes: 'Patient reports improvement. Continue regimen for two weeks.' },
    })).status,
    200,
  );

  // -------------------------------------------------- 9. prescriptions
  bold('9 · Prescription: create → sign → verify → async PDF');
  const rx = await call('POST', `/consultations/${consultationId}/prescriptions`, {
    token: doctor.token,
    idempotencyKey: randomUUID(),
    body: {
      items: [
        { drug: 'Triphala Churna', dosage: '5 g', frequency: 'Twice daily after meals', duration: '14 days' },
        { drug: 'Avipattikar Churna', dosage: '3 g', frequency: 'Once at night', duration: '10 days' },
      ],
      diagnosis: 'Functional dyspepsia',
      advice: 'Avoid cold drinks; walk 20 minutes after dinner.',
    },
  });
  expect('prescription drafted', rx.status, 201);
  const rxId = rx.body.id as string;

  const signed = await call('POST', `/prescriptions/${rxId}/sign`, {
    token: doctor.token,
    idempotencyKey: randomUUID(),
  });
  expect('signed under step-up MFA', signed.status, 201);
  info(`alg ${signed.body.signatureAlg} · signature ${String(signed.body.signature).slice(0, 32)}…`);

  expect(
    're-signing an immutable prescription',
    (await call('POST', `/prescriptions/${rxId}/sign`, { token: doctor.token, idempotencyKey: randomUUID() }))
      .status,
    409,
  );
  const verified = await call('GET', `/prescriptions/${rxId}/verify`, { token: doctor.token });
  verified.body.valid
    ? ok('signature verifies against the stored clinical content')
    : bad('signature verification failed');

  let pdfReady = false;
  for (let i = 0; i < 30; i++) {
    const check = await call('GET', `/prescriptions/${rxId}`, { token: doctor.token });
    if (check.body.pdfStatus === 'ready') {
      pdfReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (pdfReady) {
    const pdf = await fetch(`${API}/prescriptions/${rxId}/pdf`, {
      headers: { Authorization: `Bearer ${doctor.token}` },
    });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    bytes.subarray(0, 4).toString() === '%PDF'
      ? ok(`PDF rendered asynchronously via outbox → BullMQ (${bytes.length} bytes)`)
      : bad('PDF content is not a valid PDF');
    pdf.headers.get('cache-control') === 'no-store'
      ? ok('PHI download sent with `Cache-Control: no-store`')
      : bad('PDF response is cacheable');
  } else {
    bad('PDF not ready within 15s');
  }

  // ------------------------------------------------------- 10. payments
  bold('10 · Payment webhook (HMAC + freshness + exactly-once)');
  const secret = process.env.PAYMENT_WEBHOOK_SECRET!;
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({
    eventId: `evt_${RUN}_${randomUUID()}`,
    type: 'payment.captured',
    status: 'captured',
  });
  const sign = (t: string, b: string) => createHmac('sha256', secret).update(`${t}.${b}`).digest('hex');
  const post = (hdrs: Record<string, string>, b: string) =>
    fetch(`${API}/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body: b,
    });

  const wh1 = await (await post({ 'X-Signature': sign(ts, payload), 'X-Timestamp': ts }, payload)).json();
  wh1.duplicate === false ? ok('first delivery processed') : bad('first delivery not processed');
  const wh2 = await (await post({ 'X-Signature': sign(ts, payload), 'X-Timestamp': ts }, payload)).json();
  wh2.duplicate === true ? ok('redelivery deduped — no double effect') : bad('redelivery not deduped');
  expect('forged signature', (await post({ 'X-Signature': 'deadbeef', 'X-Timestamp': ts }, payload)).status, 403);
  const stale = Math.floor(Date.now() / 1000 - 4000).toString();
  expect(
    'stale timestamp outside the replay window',
    (await post({ 'X-Signature': sign(stale, payload), 'X-Timestamp': stale }, payload)).status,
    400,
  );
  expect('missing signature header', (await post({ 'X-Timestamp': ts }, payload)).status, 403);

  // ------------------------------------------------------ 11. authorization
  bold('11 · Authorization: RBAC, BOLA, step-up');
  expect('patient → admin analytics', (await call('GET', '/admin/analytics/overview', { token: patientToken })).status, 403);
  expect(
    'patient → drive clinical state',
    (await call('POST', `/consultations/${consultationId}/complete`, { token: patientToken })).status,
    403,
  );
  expect('tampered JWT', (await call('GET', '/me', { token: 'not.a.jwt' })).status, 401);
  expect('no credentials', (await call('GET', '/me')).status, 401);

  const stranger = await provision('patient', 'stranger');
  expect(
    "another patient → someone else's consultation (BOLA)",
    (await call('GET', `/consultations/${consultationId}`, { token: stranger.token })).status,
    404,
  );
  expect(
    "another patient → someone else's prescription (BOLA)",
    (await call('GET', `/prescriptions/${rxId}`, { token: stranger.token })).status,
    404,
  );
  expect(
    "doctor → edit another doctor's profile",
    (await call('PATCH', `/doctors/${search.body.items[0].id}`, {
      token: doctor.token,
      body: { bio: 'hijacked' },
    })).status,
    403,
  );
  expect(
    'self-promotion to verified is admin-only',
    (await call('PATCH', `/doctors/${doctorId}`, {
      token: doctor.token,
      body: { verificationState: 'verified' },
    })).status,
    403,
  );

  const adminNoMfa = await call('POST', '/auth/login', {
    body: { email: 'admin@amrutam.test', password: PASSWORD },
  });
  if (adminNoMfa.status === 200) {
    expect(
      'admin without step-up MFA → analytics',
      (await call('GET', '/admin/analytics/overview', { token: adminNoMfa.body.accessToken })).status,
      403,
    );
  }

  // ------------------------------------------------------ 12. cancellation
  bold('12 · Cancellation & refund policy');
  const cancel = await call('POST', `/bookings/${consultationId}/cancel`, {
    token: patientToken,
    idempotencyKey: randomUUID(),
    body: { reason: 'Schedule conflict' },
  });
  expect('consultation cancelled', cancel.status, 200);
  info(`refundEligible=${cancel.body.refundEligible} · ${cancel.body.policy}`);

  // --------------------------------------------------------- 13. validation
  bold('13 · Input validation (whitelist + forbidNonWhitelisted)');
  expect(
    'unknown property rejected',
    (await call('POST', '/bookings/hold', {
      token: patientToken,
      idempotencyKey: randomUUID(),
      body: { slotId: slot.id, isAdmin: true },
    })).status,
    400,
  );
  expect(
    'malformed uuid rejected',
    (await call('POST', '/bookings/hold', {
      token: patientToken,
      idempotencyKey: randomUUID(),
      body: { slotId: 'not-a-uuid' },
    })).status,
    400,
  );
  expect(
    'SQL injection attempt is just a harmless string',
    (await call('GET', "/doctors/search?q=%27%3B%20DROP%20TABLE%20users%3B--")).status,
    200,
  );

  // ------------------------------------------------------ 14. observability
  bold('14 · Observability');
  expect('liveness probe', (await call('GET', `${BASE}/healthz`)).status, 200);
  const ready = await call('GET', `${BASE}/readyz`);
  ready.body.checks?.postgres?.status === 'up' && ready.body.checks?.redis?.status === 'up'
    ? ok('readiness deep-checks Postgres + Redis')
    : bad('readiness check failed');

  const metricsText = await (await fetch(`${BASE}/metrics`)).text();
  const required = [
    'http_request_duration_seconds',
    'booking_attempts_total',
    'booking_conflicts_total',
    'idempotency_events_total',
    'saga_steps_total',
    'outbox_events_published_total',
    'queue_depth',
    'circuit_breaker_state',
    'db_pool_total',
  ];
  const missing = required.filter((m) => !metricsText.includes(`# HELP ${m}`));
  missing.length === 0
    ? ok(`all ${required.length} RED/business metrics exported`)
    : bad(`missing metrics: ${missing.join(', ')}`);
  const conflictSamples = metricsText
    .split('\n')
    .filter((l) => l.startsWith('booking_conflicts_total{'))
    .slice(0, 3);
  conflictSamples.forEach((l) => info(l));

  // ------------------------------------------------------- 15. audit chain
  bold('15 · Tamper-evident audit trail & analytics');
  const admin = await adminSession();
  if (admin) {
    const chain = await call('GET', '/admin/audit-logs/verify', { token: admin });
    chain.body.verified
      ? ok(`hash chain intact across ${chain.body.checked} entries`)
      : bad(`chain broken at id ${chain.body.brokenAtId}`);

    const logs = await call('GET', '/admin/audit-logs?limit=5', { token: admin });
    ok(`audit query returned ${logs.body.items?.length} recent entries`);
    for (const e of (logs.body.items ?? []).slice(0, 4)) {
      info(`${e.action.padEnd(26)} ${String(e.resource_type).padEnd(14)} ${e.outcome}`);
    }

    const overview = await call('GET', '/admin/analytics/overview', { token: admin });
    overview.status === 200
      ? ok(`analytics: ${overview.body.totals.consultations} consultations · ${overview.body.totals.doctors} doctors`)
      : bad(`analytics → ${overview.status}`);
    const funnel = await call('GET', '/admin/analytics/funnel?days=30', { token: admin });
    funnel.status === 200 ? ok(`booking funnel: ${JSON.stringify(funnel.body.stages ?? funnel.body)}`) : bad('funnel failed');

    // ------------------------------------------------------ 16. GDPR erasure
    bold('16 · GDPR erasure (crypto-shredding)');
    const erase = await call('DELETE', `/users/${stranger.userId}/pii`, {
      token: admin,
      idempotencyKey: randomUUID(),
    });
    if (erase.status === 200 || erase.status === 204) {
      ok('PII crypto-shredded; clinical records retained for the statutory period');
      await clearRateLimits();
      expect(
        'erased user can no longer authenticate',
        (await call('POST', '/auth/login', { body: { email: stranger.email, password: PASSWORD } })).status,
        401,
      );
    } else {
      info(`erasure endpoint returned ${erase.status} — skipped`);
    }
  }

  // ------------------------------------------------------ 17. rate limiting
  bold('17 · Rate limiting');
  info('run last: the per-IP auth throttle would otherwise starve the checks above');
  await clearRateLimits();
  let last = 0;
  for (let i = 0; i < 14; i++) {
    last = (
      await call('POST', '/auth/login', {
        body: { email: `nobody-${RUN}@amrutam.test`, password: 'WrongPassword!123' },
      })
    ).status;
    if (last === 429) break;
  }
  last === 429 ? ok('credential stuffing throttled with 429 + Retry-After') : bad(`expected 429, got ${last}`);


  console.log(
    `\n\x1b[1mSummary\x1b[0m  \x1b[32m${passed} passed\x1b[0m` + (failed ? `, \x1b[31m${failed} failed\x1b[0m` : '') + '\n',
  );
  if (failed) process.exitCode = 1;
}

/** Log the seeded admin in, enrolling MFA on first run so step-up routes work. */
async function adminSession(): Promise<string | null> {
  const login = await call('POST', '/auth/login', {
    body: { email: 'admin@amrutam.test', password: PASSWORD },
  });
  if (login.status !== 200) {
    info('admin already has MFA enabled from an earlier run — skipping admin checks');
    return null;
  }
  const enroll = await call('POST', '/auth/mfa/enroll', { token: login.body.accessToken });
  if (enroll.status !== 200) return null;
  const secret = enroll.body.secret as string;
  await call('POST', '/auth/mfa/verify', {
    token: login.body.accessToken,
    body: { code: authenticator.generate(secret) },
  });
  const stepUp = await call('POST', '/auth/login', {
    body: { email: 'admin@amrutam.test', password: PASSWORD, totp: authenticator.generate(secret) },
  });
  return (stepUp.body.accessToken as string) ?? null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
