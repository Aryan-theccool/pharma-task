import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Deny-by-default caching for anything behind authentication.
 *
 * Every authenticated response in this system is potentially PHI — a
 * consultation, a prescription, a profile, an analytics roll-up. Storing any of
 * it in a shared cache, a corporate proxy or the browser's disk cache is a
 * disclosure risk, and HIPAA-style guidance is explicit that PHI must not be
 * retained by intermediaries.
 *
 * Rather than decorate each controller (and inevitably forget one), the policy
 * is inverted: authenticated responses are `no-store` unless a handler has
 * deliberately set its own Cache-Control. Public, non-sensitive endpoints — the
 * doctor directory, health probes, metrics, Swagger — are left alone so they
 * stay cacheable at the edge.
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<Response>();

    // `req.user` is populated by JwtAuthGuard, which runs before interceptors.
    const isAuthenticated = Boolean(req.user);
    const handlerSetItsOwn = Boolean(res.getHeader('Cache-Control'));

    if (isAuthenticated && !handlerSetItsOwn) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache'); // HTTP/1.0 proxies
      res.setHeader('Expires', '0');
    }

    return next.handle();
  }
}
