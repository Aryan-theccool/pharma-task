import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/app.setup';
import { DatabaseService } from '../../../src/infra/database.service';
import { RedisService } from '../../../src/infra/redis.service';

export const PASSWORD = 'Str0ng!Passphrase2024';

export interface TestContext {
  app: INestApplication;
  server: Server;
  db: DatabaseService;
  redis: RedisService;
  close: () => Promise<void>;
}

/**
 * Boot the real application — same modules, same guards, same pipes as
 * production — against the real Postgres and Redis. Only the HTTP listener is
 * different: Supertest drives the underlying server directly.
 */
export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();

  return {
    app,
    server: app.getHttpServer(),
    db: app.get(DatabaseService),
    redis: app.get(RedisService),
    close: async () => {
      await app.close();
    },
  };
}

/** Clear rate-limit buckets so a noisy spec cannot throttle the next one. */
export async function resetRateLimits(redis: RedisService): Promise<void> {
  const keys = await redis.client.keys('rl:*');
  if (keys.length) await redis.client.del(...keys);
}

/**
 * The fixtures below register far more accounts per minute than any real client
 * would, which legitimately trips the per-IP auth throttle. Clearing the
 * buckets keeps fixture setup from failing for reasons unrelated to the
 * behaviour under test — rate limiting itself is asserted directly in
 * security.spec.ts.
 */
async function clearAuthThrottle(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
}

export const api = (server: Server) => request(server);

export interface TestUser {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
  totpSecret?: string;
  /** The TOTP code consumed during fixture setup — never reusable. */
  spentTotp?: string;
}

/** Register a user and return an authenticated session. */
export async function createUser(
  server: Server,
  role: 'patient' | 'doctor' = 'patient',
  options: { mfa?: boolean } = {},
): Promise<TestUser> {
  const email = `it-${role}-${randomUUID()}@amrutam.test`;
  await clearAuthThrottle();

  const registered = await request(server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: `IT ${role}`, role })
    .expect(201);

  const loggedIn = await request(server)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  const user: TestUser = {
    id: registered.body.id,
    email,
    token: loggedIn.body.accessToken,
    refreshToken: loggedIn.body.refreshToken,
  };

  if (options.mfa) {
    await clearAuthThrottle();
    const enrolled = await request(server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    user.totpSecret = enrolled.body.secret;

    await request(server)
      .post('/api/v1/auth/mfa/verify')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ code: authenticator.generate(user.totpSecret!) })
      .expect(200);

    const stepUpCode = authenticator.generate(user.totpSecret!);
    user.spentTotp = stepUpCode;

    const steppedUp = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD, totp: stepUpCode })
      .expect(200);

    user.token = steppedUp.body.accessToken;
    user.refreshToken = steppedUp.body.refreshToken;
  }

  return user;
}

/** A doctor with a profile, an availability rule and materialised slots. */
export async function createDoctorWithSlots(
  server: Server,
  options: { fee?: number; mfa?: boolean } = {},
): Promise<{ user: TestUser; doctorId: string; slots: Array<{ id: string; startsAt: string }> }> {
  const user = await createUser(server, 'doctor', { mfa: options.mfa ?? true });
  const suffix = randomUUID().slice(0, 8);

  const profile = await request(server)
    .post('/api/v1/doctors/onboard')
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      displayName: `Dr. IT ${suffix}`,
      registrationNo: `IT-${suffix}`,
      bio: 'Integration test practitioner specialising in digestive health.',
      specializations: ['ayurveda'],
      languages: ['en'],
      experienceYears: 10,
      consultationFee: options.fee ?? 800,
      timezone: 'Asia/Kolkata',
    })
    .expect(201);

  const doctorId = profile.body.id as string;
  const today = new Date();
  const target = new Date(today.getTime() + 2 * 86_400_000);

  await request(server)
    .post(`/api/v1/doctors/${doctorId}/availability-rules`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      dayOfWeek: target.getUTCDay(),
      startTime: '09:00',
      // A full clinic day, not a morning: the consultation spec consumes one
      // slot per test and a half-day pool made adding a test a fixture change.
      endTime: '17:00',
      slotMinutes: 30,
      validFrom: today.toISOString().slice(0, 10),
      timezone: 'Asia/Kolkata',
    })
    .expect(201);

  await request(server)
    .post(`/api/v1/doctors/${doctorId}/slots/materialize`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({ from: today.toISOString().slice(0, 10), days: 14 })
    .expect(201);

  const from = new Date(Date.now() + 86_400_000).toISOString();
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const slots = await request(server)
    .get(`/api/v1/doctors/${doctorId}/slots`)
    .query({ from, to, status: 'available' })
    .expect(200);

  return { user, doctorId, slots: slots.body };
}

/** Book a slot end-to-end and return the resulting consultation id. */
export async function bookSlot(
  server: Server,
  patient: TestUser,
  slotId: string,
): Promise<{ consultationId: string; holdToken: string }> {
  const hold = await request(server)
    .post('/api/v1/bookings/hold')
    .set('Authorization', `Bearer ${patient.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ slotId })
    .expect(201);

  const confirmed = await request(server)
    .post('/api/v1/bookings/confirm')
    .set('Authorization', `Bearer ${patient.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ slotId, holdToken: hold.body.holdToken, chiefComplaint: 'Integration test complaint' })
    .expect(201);

  return { consultationId: confirmed.body.consultationId, holdToken: hold.body.holdToken };
}

export const totp = (secret: string) => authenticator.generate(secret);

/**
 * Wait until the current 30-second TOTP step rolls over, then return a code.
 *
 * The application deliberately refuses to accept the same TOTP code twice
 * (replay protection), so a test that has already spent a code inside the
 * current window must wait for a genuinely new one rather than regenerating
 * the identical digits.
 */
export async function freshTotp(secret: string, previous?: string): Promise<string> {
  const spent = previous ?? authenticator.generate(secret);
  const deadline = Date.now() + 35_000;
  for (;;) {
    const candidate = authenticator.generate(secret);
    if (candidate !== spent) return candidate;
    if (Date.now() > deadline) throw new Error('TOTP step did not advance within 35s');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
