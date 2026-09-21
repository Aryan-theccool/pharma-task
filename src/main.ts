import { initTracing } from './observability/tracing';
// Tracing must be initialised before any instrumented module is imported.
const tracing = initTracing();

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp, mountSwagger } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: false });
  const config = app.get(ConfigService);
  const logger = app.get(Logger);
  app.useLogger(logger);

  configureApp(app);

  if (config.get<boolean>('SWAGGER_ENABLED', true)) {
    mountSwagger(app);
  }

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
