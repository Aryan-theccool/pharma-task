/* eslint-disable @typescript-eslint/no-var-requires */
import { context, trace, SpanStatusCode, Span } from '@opentelemetry/api';

/**
 * OpenTelemetry bootstrap. Must be imported *before* any instrumented library
 * so the auto-instrumentations can patch them (see src/main.ts).
 *
 * Disabled by default locally (OTEL_ENABLED=false) so the API boots without a
 * collector; docker-compose sets it to true and points at the OTel Collector,
 * which fans out to Tempo (traces), Prometheus (metrics) and Loki (logs).
 */
export function initTracing(): { shutdown: () => Promise<void> } {
  if (process.env.OTEL_ENABLED !== 'true') {
    return { shutdown: async () => undefined };
  }

  // Loaded lazily with require(): the OpenTelemetry auto-instrumentations must
  // patch core modules *before* anything else imports them, and pulling ~40
  // packages into the module graph when tracing is disabled would slow every
  // boot (and every test run) for no benefit.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'amrutam-api',
      'service.version': process.env.npm_package_version ?? '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true, enhancedDatabaseReporting: false },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    ],
  });

  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

const tracer = trace.getTracer('amrutam');

/** Run `fn` inside a named span, recording exceptions and setting status. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Current W3C trace/span ids, for log correlation and outbox propagation. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
