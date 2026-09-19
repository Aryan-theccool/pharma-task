/* eslint-disable no-console */
import { Client } from 'pg';
import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { loadEnv } from './load-env';

/**
 * Key rotation.
 *
 * Re-encrypts every PII/PHI column from the old key version to the new one.
 * Because each ciphertext carries its own version header, the application
 * keeps serving reads throughout — rotation is an online, resumable batch job,
 * not a maintenance window.
 *
 *   ENCRYPTION_KEY_VERSION=2 npm run keys:rotate
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION_LEN = 2;

function masterKey(): Buffer {
  const raw = process.env.ENCRYPTION_MASTER_KEY!;
  const hex = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0;
  const buf = hex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
  return Buffer.from(hkdfSync('sha256', buf, Buffer.alloc(0), Buffer.from('amrutam-master'), 32));
}

function dek(version: number): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey(), Buffer.from(`v${version}`), Buffer.from('amrutam-dek'), 32),
  );
}

function decrypt(payload: Buffer): string {
  const version = payload.readUInt16BE(0);
  const iv = payload.subarray(VERSION_LEN, VERSION_LEN + IV_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);
  const body = payload.subarray(VERSION_LEN + IV_LEN, payload.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, dek(version), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function encrypt(plaintext: string, version: number): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, dek(version), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const header = Buffer.alloc(VERSION_LEN);
  header.writeUInt16BE(version, 0);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

const TARGETS: Array<{ table: string; idColumn: string; columns: string[] }> = [
  { table: 'users', idColumn: 'id', columns: ['email_enc', 'phone_enc', 'mfa_secret_enc'] },
  { table: 'profiles', idColumn: 'user_id', columns: ['dob_enc', 'address_enc'] },
  { table: 'consultations', idColumn: 'id', columns: ['notes_enc'] },
  { table: 'prescriptions', idColumn: 'id', columns: ['items_enc', 'diagnosis_enc', 'advice_enc'] },
];

async function main(): Promise<void> {
  loadEnv();
  const newVersion = Number(process.env.ENCRYPTION_KEY_VERSION ?? 2);
  console.log(`rotating encrypted fields to key version ${newVersion}`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(
    `INSERT INTO encryption_keys (version, wrapped_dek, state)
     VALUES ($1, $2, 'active')
     ON CONFLICT (version) DO NOTHING`,
    [newVersion, `kms://alias/amrutam-dek/v${newVersion}`],
  );

  let rotated = 0;
  for (const target of TARGETS) {
    const rows = await client.query(
      `SELECT ${target.idColumn} AS id, ${target.columns.join(', ')} FROM ${target.table}`,
    );
    for (const row of rows.rows) {
      const updates: string[] = [];
      const params: unknown[] = [row.id];
      for (const column of target.columns) {
        const value: Buffer | null = row[column];
        if (!value) continue;
        if (value.readUInt16BE(0) === newVersion) continue;
        params.push(encrypt(decrypt(value), newVersion));
        updates.push(`${column} = $${params.length}`);
      }
      if (!updates.length) continue;
      await client.query(
        `UPDATE ${target.table} SET ${updates.join(', ')} WHERE ${target.idColumn} = $1`,
        params,
      );
      rotated++;
    }
    console.log(`· ${target.table}: processed ${rows.rowCount} rows`);
  }

  await client.query(
    `UPDATE encryption_keys SET state = 'retiring', retired_at = now() WHERE version < $1 AND state = 'active'`,
    [newVersion],
  );

  await client.end();
  console.log(`rotation complete — ${rotated} rows re-encrypted to version ${newVersion}`);
  console.log(`Set ENCRYPTION_KEY_VERSION=${newVersion} in the app environment and redeploy.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
