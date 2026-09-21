import { loadEnv } from '../../scripts/load-env';

/**
 * Integration tests talk to a real Postgres and a real Redis — no mocks, no
 * in-memory doubles. `docker compose -f docker-compose.test.yml up -d` (or the
 * services block in CI) provides them; this hook only fails fast with a useful
 * message when they are missing, rather than letting 40 specs time out.
 */
export default async function globalSetup(): Promise<void> {
  loadEnv('.env.test');
  loadEnv('.env');

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL ??= 'fatal';
  process.env.OTEL_ENABLED = 'false';
  process.env.SWAGGER_ENABLED = 'false';
  // Workers run inside the test process only where a spec explicitly needs them.
  process.env.RUN_WORKERS_IN_API ??= 'false';

  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users','doctors','availability_slots','consultations')`,
    );
    if (Number(rows[0].count) < 4) {
      throw new Error('schema is missing — run `npm run db:migrate` before the integration suite');
    }
  } catch (error) {
    throw new Error(
      `integration tests need Postgres at ${process.env.DATABASE_URL}\n` +
        `  start it with: docker compose up -d postgres redis && npm run db:migrate\n` +
        `  cause: ${(error as Error).message}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3_000,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    throw new Error(
      `integration tests need Redis at ${process.env.REDIS_URL}\n  cause: ${(error as Error).message}`,
    );
  } finally {
    redis.disconnect();
  }
}
