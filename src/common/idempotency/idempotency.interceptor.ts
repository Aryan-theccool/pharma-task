import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of, switchMap } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';
import { metrics } from '../../observability/metrics';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Enforces RFC-style `Idempotency-Key` semantics on annotated mutating routes.
 *
 * Contract (documented in docs/IDEMPOTENCY.md and the README):
 *   - Missing header                       -> 400
 *   - First use                            -> executes, stores status + body
 *   - Replay, same payload, completed      -> 200/original status + `Idempotent-Replay: true`
 *   - Replay, different payload            -> 409 (key reuse)
 *   - Replay while first is still running  -> 409 (retry with backoff)
 *   - Keys are scoped to user + endpoint, TTL 24h
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();

    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next.handle();

    const headerKey = req.headers['idempotency-key'];
    const key = Array.isArray(headerKey) ? headerKey[0] : headerKey;

    if (!key || key.trim().length === 0) {
      throw new BadRequestException({
        title: 'Idempotency-Key header required',
        detail: `${req.method} ${req.path} mutates state and requires an Idempotency-Key header.`,
      });
    }
    if (key.length > 255) {
      throw new BadRequestException({ title: 'Idempotency-Key too long (max 255 characters)' });
    }

    const endpoint = `${req.method} ${(req.route as { path?: string })?.path ?? req.path}`;
    const userId = req.user?.sub ?? null;
    const fingerprint = IdempotencyService.fingerprint({
      endpoint,
      body: req.body ?? {},
      params: req.params ?? {},
    });
    const scopedKey = IdempotencyService.scope(userId, endpoint, key);

    return from(this.idempotency.claim(scopedKey, userId, endpoint, fingerprint)).pipe(
      switchMap((claim) => {
        if (!claim.claimed) {
          const existing = claim.existing;

          if (existing.request_hash !== fingerprint) {
            metrics.idempotencyEvents.inc({ outcome: 'conflict' });
            throw new ConflictException({
              title: 'Idempotency-Key reuse with a different payload',
              detail: 'This Idempotency-Key was already used for a different request body. Use a new key.',
            });
          }

          if (existing.status === 'in_progress') {
            metrics.idempotencyEvents.inc({ outcome: 'in_progress' });
            throw new HttpException(
              {
                title: 'Request already in progress',
                detail: 'An identical request is currently being processed. Retry with backoff.',
              },
              409,
            );
          }

          metrics.idempotencyEvents.inc({ outcome: 'replay' });
          res.setHeader('Idempotent-Replay', 'true');
          res.status(existing.response_status ?? 200);
          return of(existing.response_body);
        }

        metrics.idempotencyEvents.inc({ outcome: 'miss' });
        return next.handle().pipe(
          tap({
            next: (body) => {
              const status = res.statusCode ?? 200;
              void this.idempotency
                .complete(scopedKey, status, body)
                .catch((err) => this.logger.error({ err }, 'failed to persist idempotent response'));
            },
          }),
          catchError((err) =>
            from(this.idempotency.release(scopedKey)).pipe(
              switchMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }
}
