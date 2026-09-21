/* eslint-disable no-console */
import { Client } from 'pg';
import Redis from 'ioredis';
import { createHmac, hkdfSync, randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import { DateTime } from 'luxon';
import { loadEnv } from './load-env';
import { mintProof, proofConnectionOptions } from '../src/common/crypto/integrity-proof';

/**
 * Deterministic demo dataset:
 *   50 doctors, 500 patients, 1 admin, 14 days of 30-minute slots,
 *   plus a handful of completed consultations so analytics are not empty.
 *
 * Crypto here mirrors FieldEncryptionService exactly so the API can decrypt
 * everything this script writes.
 */

const ALGO = 'aes-256-gcm';

function master(material: string): Buffer {
  const hex = /^[0-9a-f]+$/i.test(material) && material.length % 2 === 0;
  const buf = hex ? Buffer.from(material, 'hex') : Buffer.from(material, 'utf8');
  return Buffer.from(hkdfSync('sha256', buf, Buffer.alloc(0), Buffer.from('amrutam-master'), 32));
}

function dek(masterKey: Buffer, version = 1): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.from(`v${version}`), Buffer.from('amrutam-dek'), 32),
  );
}

function encrypt(key: Buffer, plaintext: string, version = 1): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(version, 0);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

function hashPassword(password: string): string {
  const N = 32_768;
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

const SPECIALIZATIONS = [
  'ayurveda',
  'dermatology',
  'general-medicine',
  'gynaecology',
  'pediatrics',
  'cardiology',
  'nutrition',
  'psychiatry',
  'orthopaedics',
  'endocrinology',
];
const LANGUAGES = ['en', 'hi', 'ta', 'te', 'mr', 'bn', 'gu', 'kn'];
const FIRST = [
  'Meera',
  'Arjun',
  'Kavya',
  'Rohan',
  'Ananya',
  'Vikram',
  'Divya',
  'Nikhil',
  'Priya',
  'Sanjay',
  'Ishita',
  'Rahul',
  'Neha',
  'Aditya',
  'Sneha',
  'Karthik',
  'Pooja',
  'Manish',
  'Riya',
  'Amit',
];
const LAST = [
  'Iyer',
  'Sharma',
  'Reddy',
  'Patel',
  'Nair',
  'Gupta',
  'Desai',
  'Rao',
  'Joshi',
  'Menon',
  'Kulkarni',
  'Verma',
  'Bose',
  'Chopra',
  'Pillai',
];

// Deterministic PRNG so repeated seeds produce the same demo data.
let seedState = 42;
function rnd(): number {
  seedState = (seedState * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seedState / 2_147_483_648;
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const pickMany = <T>(arr: T[], n: number): T[] => {
  const out = new Set<T>();
  while (out.size < n) out.add(pick(arr));
  return [...out];
};

/**
 * Clear the Redis state that is keyed to rows the seed has just deleted.
 *
 * Scoped deliberately: BullMQ queues, rate-limit counters, the audit chain head
 * and cached search results. Anything else in the database is left alone.
 */
async function resetRedisState(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;

  const redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  try {
    await redis.connect();
    const patterns = ['bull:*', 'rl:*', 'audit:chain:*', 'cache:*', 'idem:*'];
    let removed = 0;
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys.length) removed += await redis.del(...keys);
      } while (cursor !== '0');
    }
    console.log(`· redis reset: ${removed} keys cleared (queues, rate limits, caches)`);
  } catch (error) {
    // A seed that cannot reach Redis is still useful; say so rather than dying.
    console.warn(`· redis reset skipped: ${(error as Error).message}`);
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  loadEnv();
  const masterKey = master(process.env.ENCRYPTION_MASTER_KEY!);
  const key = dek(masterKey);
  const emailKey = master(process.env.EMAIL_HMAC_KEY!);
  const emailHash = (email: string) =>
    createHmac('sha256', emailKey).update(email.trim().toLowerCase()).digest();

  // Seed writes are attributed, exactly like the API's. The capture triggers
  // copy this token into every journal entry, so the demo dataset does not
  // masquerade as an unattributed (i.e. suspicious) write. Derivation matches
  // integrityKeyFrom() in src/infra/database.service.ts.
  const integrityKey = Buffer.from(
    hkdfSync(
      'sha256',
      (() => {
        const m = process.env.INTEGRITY_PROOF_KEY ?? (process.env.ENCRYPTION_MASTER_KEY as string);
        const isHex = /^[0-9a-f]+$/i.test(m) && m.length % 2 === 0;
        return isHex ? Buffer.from(m, 'hex') : Buffer.from(m, 'utf8');
      })(),
      Buffer.alloc(0),
      Buffer.from('amrutam-integrity'),
      32,
    ),
  );

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'amrutam-seed',
    options: proofConnectionOptions(mintProof(integrityKey)),
  });
  await client.connect();

  console.log('seeding…');

  // The journal is append-only and survives the TRUNCATE below. Entries that
  // referred to the previous dataset would otherwise be reported for ever as
  // `vanished_row` — a permanent false positive that makes the whole control
  // untrustworthy. Re-seeding is a destructive development action, so the
  // honest thing is to reset the journal with it, under an explicit guard.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed (and reset the integrity journal) in production');
  }
  await client.query('TRUNCATE clinical_integrity_journal, integrity_checkpoints RESTART IDENTITY');

  await client.query(`TRUNCATE
    notifications, processed_events, outbox, saga_instances, payment_webhook_events, payments,
    prescriptions, consultations, availability_slots, availability_rules, reviews, doctors,
    mfa_recovery_codes, refresh_tokens, idempotency_keys, audit_logs, profiles, users
    RESTART IDENTITY CASCADE`);

  // Postgres and Redis have to be reset together.
  //
  // `RESTART IDENTITY` rewinds the outbox id sequence, but the drainer enqueues
  // jobs with `jobId: outbox-{id}` for producer-side dedupe, and BullMQ keeps
  // those keys in Redis. After a re-seed the new event id 2 collides with a
  // completed `outbox-2` from the previous dataset, so BullMQ discards it as a
  // duplicate and the job never runs — prescriptions sit at `pdf_status =
  // 'pending'` for ever, with an empty queue and no failures to explain it.
  // Rate-limit counters are cleared for the same reason: a fresh dataset should
  // not inherit the previous run's throttle.
  await resetRedisState();

  const demoPassword = 'Str0ng!Passphrase2024';
  const passwordHash = hashPassword(demoPassword);

  // ---------------------------------------------------------------- admin
  const admin = await client.query<{ id: string }>(
    `INSERT INTO users (email_hash, email_enc, password_hash, role, status)
     VALUES ($1,$2,$3,'admin','active') RETURNING id`,
    [emailHash('admin@amrutam.test'), encrypt(key, 'admin@amrutam.test'), passwordHash],
  );
  await client.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1,'Platform Admin')`, [
    admin.rows[0].id,
  ]);

  // -------------------------------------------------------------- doctors
  const doctorIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const name = `Dr. ${pick(FIRST)} ${pick(LAST)}`;
    const email = `doctor${i + 1}@amrutam.test`;
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email_hash, email_enc, phone_enc, password_hash, role)
       VALUES ($1,$2,$3,$4,'doctor') RETURNING id`,
      [
        emailHash(email),
        encrypt(key, email),
        encrypt(key, `+9198${String(70000000 + i).padStart(8, '0')}`),
        passwordHash,
      ],
    );
    await client.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1,$2)`, [user.rows[0].id, name]);

    const doctor = await client.query<{ id: string }>(
      `INSERT INTO doctors
         (user_id, display_name, registration_no, bio, specializations, languages,
          experience_years, consultation_fee, rating_avg, rating_count, verification_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified')
       RETURNING id`,
      [
        user.rows[0].id,
        name,
        `MCI-2024-${String(100000 + i)}`,
        `${name} focuses on ${pick(SPECIALIZATIONS).replace('-', ' ')} with an integrative approach to chronic care.`,
        pickMany(SPECIALIZATIONS, 1 + Math.floor(rnd() * 2)),
        pickMany(LANGUAGES, 1 + Math.floor(rnd() * 3)),
        1 + Math.floor(rnd() * 25),
        (300 + Math.floor(rnd() * 18) * 100).toFixed(2),
        (3 + rnd() * 2).toFixed(2),
        Math.floor(rnd() * 400),
      ],
    );
    doctorIds.push(doctor.rows[0].id);
  }
  console.log(`· ${doctorIds.length} doctors`);

  // ------------------------------------------------------------- patients
  const patientIds: string[] = [];
  for (let i = 0; i < 500; i++) {
    const email = `patient${i + 1}@amrutam.test`;
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email_hash, email_enc, phone_enc, password_hash, role)
       VALUES ($1,$2,$3,$4,'patient') RETURNING id`,
      [
        emailHash(email),
        encrypt(key, email),
        encrypt(key, `+9199${String(10000000 + i).padStart(8, '0')}`),
        passwordHash,
      ],
    );
    await client.query(`INSERT INTO profiles (user_id, full_name, dob_enc, gender) VALUES ($1,$2,$3,$4)`, [
      user.rows[0].id,
      `${pick(FIRST)} ${pick(LAST)}`,
      encrypt(
        key,
        `19${60 + Math.floor(rnd() * 40)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
      ),
      pick(['female', 'male', 'other']),
    ]);
    patientIds.push(user.rows[0].id);
  }
  console.log(`· ${patientIds.length} patients`);

  // ------------------------------------------------- availability + slots
  let slotCount = 0;
  const createdSlots: Array<{ id: string; doctorId: string; startsAt: string }> = [];

  for (const doctorId of doctorIds) {
    const startHour = 9 + Math.floor(rnd() * 3);
    const endHour = startHour + 4 + Math.floor(rnd() * 3);

    for (let dow = 1; dow <= 5; dow++) {
      await client.query(
        `INSERT INTO availability_rules
           (doctor_id, day_of_week, start_time, end_time, slot_minutes, valid_from, timezone)
         VALUES ($1,$2,$3,$4,30,CURRENT_DATE,'Asia/Kolkata')`,
        [doctorId, dow, `${String(startHour).padStart(2, '0')}:00`, `${String(endHour).padStart(2, '0')}:00`],
      );
    }

    // Materialise 14 days of slots in UTC.
    const base = DateTime.utc().plus({ days: 1 }).startOf('day');
    for (let day = 0; day < 14; day++) {
      const dayStart = base.plus({ days: day });
      if (dayStart.weekday > 5) continue; // weekdays only
      for (let h = startHour; h < endHour; h++) {
        for (const minute of [0, 30]) {
          const from = dayStart.set({ hour: h, minute });
          const to = from.plus({ minutes: 30 });
          const res = await client.query<{ id: string }>(
            `INSERT INTO availability_slots (doctor_id, slot_range)
             VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'))
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [doctorId, from.toISO(), to.toISO()],
          );
          if (res.rowCount) {
            slotCount++;
            if (createdSlots.length < 4000) {
              createdSlots.push({ id: res.rows[0].id, doctorId, startsAt: from.toISO()! });
            }
          }
        }
      }
    }
  }
  console.log(`· ${slotCount} bookable slots over the next 14 days`);

  // ------------------------------- historical consultations for analytics
  let historical = 0;
  for (let i = 0; i < 300; i++) {
    const doctorId = pick(doctorIds);
    const patientId = pick(patientIds);
    const daysAgo = 1 + Math.floor(rnd() * 25);
    const when = DateTime.utc()
      .minus({ days: daysAgo })
      .set({ hour: 10 + Math.floor(rnd() * 6), minute: 0 });

    const slot = await client.query<{ id: string }>(
      `INSERT INTO availability_slots (doctor_id, slot_range, status)
       VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), 'booked')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [doctorId, when.toISO(), when.plus({ minutes: 30 }).toISO()],
    );
    if (!slot.rowCount) continue;

    const status = rnd() < 0.82 ? 'completed' : rnd() < 0.6 ? 'cancelled' : 'no_show';
    const amount = 300 + Math.floor(rnd() * 15) * 100;

    const consultation = await client.query<{ id: string }>(
      `INSERT INTO consultations
         (patient_id, doctor_id, slot_id, status, scheduled_at, ends_at, started_at, ended_at, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$7)
       RETURNING id`,
      [
        patientId,
        doctorId,
        slot.rows[0].id,
        status,
        when.toISO(),
        when.plus({ minutes: 30 }).toISO(),
        amount,
      ],
    );

    if (status === 'completed') {
      await client.query(
        `INSERT INTO payments (consultation_id, patient_id, amount, status, provider, provider_ref)
         VALUES ($1,$2,$3,'captured','mock',$4)`,
        [consultation.rows[0].id, patientId, amount, `mock_seed_${i}`],
      );
      if (rnd() < 0.5) {
        await client.query(
          `INSERT INTO reviews (consultation_id, doctor_id, patient_id, rating, comment)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            consultation.rows[0].id,
            doctorId,
            patientId,
            3 + Math.floor(rnd() * 3),
            'Helpful consultation, clear guidance.',
          ],
        );
      }
    }
    historical++;
  }
  console.log(`· ${historical} historical consultations`);

  await client.query('REFRESH MATERIALIZED VIEW mv_daily_kpis');
  await client.query('REFRESH MATERIALIZED VIEW mv_doctor_utilization');

  // Attest the seeded rows against the clinical integrity journal.
  //
  // The journal triggers record every write, but seed rows are inserted
  // without a proof token, so they land as `unattributed_write`. Without this
  // step a freshly seeded environment boots straight into a red
  // "CLINICAL INTEGRITY VIOLATION" — which is exactly how you teach an
  // operator to ignore that alert. Marking the seed as the known-good
  // starting point means any finding afterwards is a real one.
  const baseline = await client.query<{ table_name: string; rows_baselined: string }>(
    'SELECT * FROM integrity_baseline()',
  );
  const attested = baseline.rows.reduce((sum, r) => sum + Number(r.rows_baselined), 0);
  console.log(
    attested === 0
      ? `· integrity journal clean (${baseline.rowCount} protected tables, all writes attributed)`
      : `· integrity baseline: ${attested} pre-existing rows attested`,
  );

  await client.end();

  console.log('\nseed complete. Demo credentials (all share one password):');
  console.log(`  password : ${demoPassword}`);
  console.log('  admin    : admin@amrutam.test');
  console.log('  doctor   : doctor1@amrutam.test … doctor50@amrutam.test');
  console.log('  patient  : patient1@amrutam.test … patient500@amrutam.test');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
