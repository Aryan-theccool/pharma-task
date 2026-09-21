/* eslint-disable no-console */
import { NestFactory } from '@nestjs/core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './load-env';

/**
 * Emit `docs/openapi.json` from the live decorator metadata.
 *
 * The spec is generated, never hand-written, so it cannot drift from the
 * implementation — CI regenerates it and fails if the committed copy differs.
 * The application is created but never listens: building the document only
 * needs the module graph, not an open socket.
 */
async function main(): Promise<void> {
  loadEnv();

  // Nothing here should touch the network or the database.
  process.env.OTEL_ENABLED = 'false';
  process.env.RUN_WORKERS_IN_API = 'false';
  process.env.LOG_LEVEL = 'fatal';

  const { AppModule } = await import('../src/app.module');
  const { buildOpenApiDocument } = await import('../src/app.setup');

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix(process.env.API_PREFIX ?? 'api/v1', {
    exclude: ['healthz', 'readyz', 'metrics'],
  });

  const document = buildOpenApiDocument(app);

  // Document the cross-cutting conventions the decorators cannot express.
  document.components ??= {};
  document.components.headers = {
    'Idempotency-Key': {
      description:
        'Client-generated unique key (UUID recommended). Required on all mutating money or ' +
        'slot endpoints. Replaying the same key with the same payload returns the original ' +
        'response; a different payload under the same key returns 409.',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    },
    'Idempotent-Replay': {
      description: 'Present and set to `true` when the response was served from the idempotency store.',
      schema: { type: 'string', enum: ['true'] },
    },
    'X-Request-Id': {
      description: 'Correlation id echoed on every response; quote it in support requests.',
      schema: { type: 'string', format: 'uuid' },
    },
    'RateLimit-Remaining': {
      description: 'Requests left in the current window.',
      schema: { type: 'integer' },
    },
    'Retry-After': {
      description: 'Seconds to wait before retrying, sent with every 429.',
      schema: { type: 'integer' },
    },
  };

  document.components.schemas ??= {};
  document.components.schemas.ProblemDetails = {
    type: 'object',
    description: 'RFC 7807 problem document — the error shape for every non-2xx response.',
    properties: {
      type: { type: 'string', format: 'uri', example: 'https://httpstatuses.io/409' },
      title: { type: 'string', example: 'Slot has already been booked' },
      status: { type: 'integer', example: 409 },
      detail: { type: 'string' },
      instance: { type: 'string', example: '/api/v1/bookings/confirm' },
      requestId: { type: 'string', format: 'uuid' },
      errors: { type: 'array', items: { type: 'string' } },
      timestamp: { type: 'string', format: 'date-time' },
    },
    required: ['type', 'title', 'status', 'instance'],
  };

  document.servers = [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: 'https://api.amrutam.example.com', description: 'Production' },
  ];

  const outDir = join(process.cwd(), 'docs');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'openapi.json');
  writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {});
  const operations = paths.reduce(
    (sum, p) => sum + Object.keys(document.paths[p] as Record<string, unknown>).length,
    0,
  );

  console.log(`✓ ${outFile}`);
  console.log(
    `  ${paths.length} paths, ${operations} operations, ${Object.keys(document.components.schemas).length} schemas`,
  );

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
