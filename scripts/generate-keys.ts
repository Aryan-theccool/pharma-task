/* eslint-disable no-console */
import { randomBytes } from 'node:crypto';

/**
 * Generate cryptographically strong values for the secrets in .env.
 * In production these live in AWS Secrets Manager / KMS, never in a file.
 */
const keys = {
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_MASTER_KEY: randomBytes(32).toString('hex'),
  EMAIL_HMAC_KEY: randomBytes(32).toString('hex'),
  PRESCRIPTION_SIGNING_KEY: randomBytes(32).toString('hex'),
  PAYMENT_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
};

console.log('# Generated secrets — copy into .env (never commit real values)');
for (const [key, value] of Object.entries(keys)) {
  console.log(`${key}=${value}`);
}
