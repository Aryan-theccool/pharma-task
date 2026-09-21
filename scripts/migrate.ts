/* eslint-disable no-console */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadEnv } from './load-env';

/**
 * Minimal forward-only migration runner.
 *
 * Each file in db/migrations runs once inside a transaction and is recorded in
 * `schema_migrations`, so `npm run db:migrate` is safe to re-run and safe to
 * put in a container entrypoint.
 */
async function main(): Promise<void> {
  loadEnv();
  const reset = process.argv.includes('--reset');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (reset) {
    console.log('⚠  dropping and recreating the public schema');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const dir = join(__dirname, '..', 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rowCount) {
      console.log(`· ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`✗ ${file}:`, (error as Error).message);
      throw error;
    }
  }

  await client.end();
  console.log('migrations complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
