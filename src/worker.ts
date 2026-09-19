import { initTracing } from './observability/tracing';
const tracing = initTracing();

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Standalone worker process.
 *
 * Runs the same DI container without the HTTP server, so queue consumers and
 * scheduled jobs scale independently of API traffic (separate ECS service,
 * autoscaled on queue depth rather than CPU).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  logger.log('Amrutam worker started — consuming notifications, prescription-pdf and analytics queues');

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — finishing in-flight jobs`);
    await app.close();
    await tracing.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
