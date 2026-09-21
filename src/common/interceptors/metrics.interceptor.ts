import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { metrics } from '../../observability/metrics';

/**
 * RED metrics for every HTTP request. The route *template* (not the raw URL)
 * is used as a label so cardinality stays bounded — `/doctors/:id`, never
 * `/doctors/<uuid>`.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const start = process.hrtime.bigint();
    metrics.httpRequestsInFlight.inc();

    const record = (statusOverride?: number) => {
      metrics.httpRequestsInFlight.dec();
      const route = (req.route as { path?: string })?.path ?? this.normalise(req.path);
      const status = String(statusOverride ?? res.statusCode);
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method: req.method, route, status };
      metrics.httpRequestDuration.observe(labels, seconds);
      metrics.httpRequestsTotal.inc(labels);
    };

    return next.handle().pipe(
      tap({
        next: () => record(),
        error: (err) => record((err as { status?: number }).status ?? 500),
      }),
    );
  }

  /** Collapse ids in unmatched paths to keep label cardinality bounded. */
  private normalise(path: string): string {
    return path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:n');
  }
}
