import { z } from 'zod';

/**
 * Environment contract. Parsed once at boot — the process refuses to start on
 * a malformed config instead of failing later at request time.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_REPLICA_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('10m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Envelope encryption: master key (in prod: AWS KMS / Secrets Manager).
  ENCRYPTION_MASTER_KEY: z.string().min(32),
  EMAIL_HMAC_KEY: z.string().min(32),
  PRESCRIPTION_SIGNING_KEY: z.string().min(32),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  /**
   * Signs the proof-of-origin token stamped on every clinical write. Must NOT
   * be known to the database: the whole point is that a party with database
   * access cannot mint one. Defaults to a key derived from
   * ENCRYPTION_MASTER_KEY so existing deployments keep working, but production
   * should set it explicitly and store it in a separate KMS key.
   */
  INTEGRITY_PROOF_KEY: z.string().min(32).optional(),
  /** How long a minted proof stays acceptable (default 30 days). */
  INTEGRITY_PROOF_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  /** Rows scanned per integrity sweep. */
  INTEGRITY_SCAN_LIMIT: z.coerce.number().int().positive().default(500),

  /**
   * A saga untouched for this long is presumed abandoned by a dead process.
   * Must exceed the slowest legitimate confirm (payment authorize + capture
   * with retries); 5 minutes is ~60x the observed p99.
   */
  SAGA_STUCK_AFTER_SECONDS: z.coerce.number().int().positive().default(300),
  /** Recovery attempts before a saga is dead-lettered for a human. */
  SAGA_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Sagas processed per reconciliation pass. */
  SAGA_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().default(20),

  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  BOOKING_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  REFUND_WINDOW_HOURS: z.coerce.number().int().nonnegative().default(24),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  /**
   * Multiplier applied to every per-route @RateLimit budget. Exists so load
   * tests can measure the application rather than the throttle without editing
   * decorators, and so a single env var can loosen limits during an incident.
   * Must stay at 1 in production; CI asserts the default.
   */
  RATE_LIMIT_ROUTE_MULTIPLIER: z.coerce.number().positive().default(1),

  CORS_ORIGINS: z.string().default('*'),
  SWAGGER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  OTEL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().default('amrutam-api'),

  STORAGE_DIR: z.string().default('./storage'),
  RUN_WORKERS_IN_API: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  /**
   * Which payment adapter to bind. `mock` is rejected at boot when
   * NODE_ENV=production — see PaymentsModule.
   */
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  RAZORPAY_BASE_URL: z.string().default('https://api.razorpay.com'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
