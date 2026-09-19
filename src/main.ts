import { initTracing } from './observability/tracing';
// Tracing must be initialised before any instrumented module is imported.
const tracing = initTracing();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: false });
  const config = app.get(ConfigService);
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Capture the raw body so webhook HMAC verification signs exactly the bytes
  // the provider sent (re-serialising JSON would change the signature).
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // Swagger UI
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const origins = config.get<string>('CORS_ORIGINS', '*');
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay', 'RateLimit-Remaining', 'Retry-After'],
    maxAge: 600,
  });

  // API version lives in the URL prefix (/api/v1). A future /api/v2 mounts a
  // second controller set; the prefix is the single source of truth, so no
  // per-route @Version() decorators are needed.
  app.setGlobalPrefix(config.get<string>('API_PREFIX', 'api/v1'), {
    exclude: ['healthz', 'readyz', 'metrics'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  if (config.get<boolean>('SWAGGER_ENABLED', true)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Amrutam Telemedicine API')
      .setDescription(
        'Production-grade telemedicine backend.\n\n' +
          '**Conventions**\n' +
          '- Errors follow RFC 7807 `application/problem+json`.\n' +
          '- Mutating money/slot endpoints require an `Idempotency-Key` header; replays return the ' +
          'original response with `Idempotent-Replay: true`.\n' +
          '- Lists use opaque cursor pagination (`?cursor=&limit=`).\n' +
          '- Every response echoes `X-Request-Id` for support correlation.\n' +
          '- Rate limits are advertised via `RateLimit-*` headers; 429s include `Retry-After`.',
      )
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Registration, login, token rotation and MFA')
      .addTag('users', 'Profiles and personal data')
      .addTag('doctors', 'Doctor profiles, availability and search')
      .addTag('booking', 'Hold → confirm → cancel → reschedule (saga)')
      .addTag('consultations', 'Consultation lifecycle and clinical notes')
      .addTag('prescriptions', 'Issue, sign, verify and download prescriptions')
      .addTag('payments', 'Payment intents, refunds and provider webhooks')
      .addTag('admin', 'Analytics and the audit trail')
      .addTag('ops', 'Health, readiness and metrics')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
      customSiteTitle: 'Amrutam Telemedicine API',
    });
  }

  // Finish in-flight requests before exiting (rolling deploys, spot drain).
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');

  const url = await app.getUrl();
  logger.log(`Amrutam API listening on ${url}`);
  logger.log(`Swagger UI: ${url}/docs`);
  logger.log(`Health: ${url}/healthz · Readiness: ${url}/readyz · Metrics: ${url}/metrics`);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — draining connections`);
    await app.close();
    await tracing.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
