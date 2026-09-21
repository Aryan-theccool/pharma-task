import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY, AuditMetadata } from '../decorators/audit.decorator';
import { AuditService } from '../../modules/audit/audit.service';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Writes an audit record for every @Audit()-annotated route, capturing both
 * successful and denied/failed attempts (a denied PHI access is exactly what a
 * compliance reviewer wants to see logged).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const resourceId = this.resolveResourceId(req, meta);

    return next.handle().pipe(
      tap({
        next: (body) => {
          void this.audit.record({
            actorId: req.user?.sub ?? null,
            actorRole: req.user?.role ?? null,
            action: meta.action,
            resourceType: meta.resourceType,
            resourceId: resourceId ?? this.idFromBody(body),
            outcome: 'success',
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            requestId: req.requestId ?? null,
          });
        },
        error: (err) => {
          const status = (err as { status?: number }).status ?? 500;
          void this.audit.record({
            actorId: req.user?.sub ?? null,
            actorRole: req.user?.role ?? null,
            action: meta.action,
            resourceType: meta.resourceType,
            resourceId,
            outcome: status === 403 || status === 401 ? 'denied' : 'failure',
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            requestId: req.requestId ?? null,
            after: { status, title: (err as { message?: string }).message },
          });
        },
      }),
    );
  }

  private resolveResourceId(req: AuthenticatedRequest, meta: AuditMetadata): string | null {
    if (!meta.resourceIdFrom) return null;
    const params = req.params as Record<string, string> | undefined;
    const body = req.body as Record<string, unknown> | undefined;
    return params?.[meta.resourceIdFrom] ?? (body?.[meta.resourceIdFrom] as string) ?? null;
  }

  private idFromBody(body: unknown): string | null {
    if (body && typeof body === 'object' && 'id' in body) {
      const id = (body as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  }
}
