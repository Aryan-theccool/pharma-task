import { loadEnv } from '../../scripts/load-env';

/**
 * Runs inside every integration test environment (globalSetup runs in the Jest
 * parent process, so its env mutations do not reliably reach workers).
 */
loadEnv('.env.test');
loadEnv('.env');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.OTEL_ENABLED = 'false';
process.env.SWAGGER_ENABLED = 'false';
process.env.RUN_WORKERS_IN_API ??= 'false';

// Tests legitimately hammer auth and booking endpoints far harder than a real
// client would. Raise the budgets so throttling never masks a genuine failure;
// rate limiting itself is asserted explicitly in security.spec.ts, which sets
// its own low limits.
process.env.RATE_LIMIT_GLOBAL_PER_MIN ??= '100000';
process.env.RATE_LIMIT_AUTH_PER_MIN ??= '100000';
