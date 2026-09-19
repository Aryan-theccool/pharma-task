import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { validateEnv } from './config/configuration';
import { InfraModule } from './infra/infra.module';
import { QueueModule } from './queue/queue.module';

import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { UsersModule } from './modules/users/users.module';
import { DoctorsModule } from './modules/doctors/doctors.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { BookingModule } from './modules/booking/booking.module';
import { ConsultationsModule } from './modules/consultations/consultations.module';
import { PrescriptionsModule } from './modules/prescriptions/prescriptions.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';

import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MfaGuard } from './common/guards/mfa.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { currentTraceIds } from './observability/tracing';

/**
 * Composition root.
 *
 * Feature modules own their controllers/services; InfraModule and AuditModule
 * are global singletons (pools, key material, hash chain). Cross-cutting
 * concerns are registered once here in a deliberate order:
 *
 *   guards       RateLimit → JwtAuth → Roles → Mfa
 *   interceptors Metrics → Audit → Idempotency
 *
 * so an unauthenticated flood is shed before it reaches the database, and an
 * idempotency claim is only written for an authorised caller.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    ScheduleModule.forRoot(),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),
          genReqId: (req, res) => {
            const existing = (req.headers['x-request-id'] as string) ?? randomUUID();
            res.setHeader('X-Request-Id', existing);
            return existing;
          },
          customProps: () => {
            const { traceId, spanId } = currentTraceIds();
            return { trace_id: traceId, span_id: spanId, service: 'amrutam-api' };
          },
          // Credentials and PHI must never reach the log sink.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-signature"]',
              'req.body.password',
              'req.body.totp',
              'req.body.refreshToken',
              'req.body.notes',
              'req.body.items',
              'req.body.diagnosis',
              'req.body.advice',
              'req.body.email',
              'req.body.phone',
              'req.body.address',
              'req.body.dob',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: {
            ignore: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url ?? ''),
          },
          transport:
            config.get<string>('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
              : undefined,
        },
      }),
    }),

    InfraModule,
    AuditModule,
    AuthModule,
    UsersModule,
    DoctorsModule,
    AvailabilityModule,
    BookingModule,
    ConsultationsModule,
    PrescriptionsModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
    QueueModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: MfaGuard },

    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
