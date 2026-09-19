import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { RATE_LIMIT_KEY, RateLimitOptions } from '../decorators/rate-limit.decorator';
import { RedisService } from '../../infra/redis.service';
import { metrics } from '../../observability/metrics';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Redis-backed sliding-window rate limiter.
 *
 * Two layers apply to every request:
 *   1. a global per-identity budget (RATE_LIMIT_GLOBAL_PER_MIN)
 *   2. an optional stricter per-route budget from @RateLimit()
 *
 * Identity is the authenticated user id when present, else the client IP, so
 * one abusive tenant behind a shared NAT cannot exhaust everyone's budget.
 * Responses carry RateLimit-* headers and 429s carry Retry-After.
 *
 * Fail-open on Redis outage: availability of the platform outranks perfect
 * throttling, and the WAF/ALB provides a coarse backstop (documented in
 * docs/THREAT_MODEL.md).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly globalLimit: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.globalLimit = config.get<number>('RATE_LIMIT_GLOBAL_PER_MIN', 300);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();

    const routeOptions = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const identity = req.user?.sub ?? req.ip ?? 'unknown';
    const routePath = (req.route as { path?: string })?.path ?? req.path;

    try {
      // Layer 1 — global budget per identity.
      const global = await this.redis.incrementWindow(`rl:global:${identity}`, 60);
      if (global.count > this.globalLimit) {
        this.reject(res, global.ttl, 'global');
      }

      // Layer 2 — per-route budget.
      if (routeOptions) {
        const scopeId = routeOptions.scope === 'ip' ? (req.ip ?? 'unknown') : identity;
        const bucket = `rl:route:${routePath}:${scopeId}`;
        const routeWindow = await this.redis.incrementWindow(bucket, routeOptions.windowSeconds);

        res.setHeader('RateLimit-Limit', routeOptions.limit);
        res.setHeader('RateLimit-Remaining', Math.max(0, routeOptions.limit - routeWindow.count));
        res.setHeader('RateLimit-Reset', routeWindow.ttl);

        if (routeWindow.count > routeOptions.limit) {
          this.reject(res, routeWindow.ttl, routePath);
        }
      } else {
        res.setHeader('RateLimit-Limit', this.globalLimit);
        res.setHeader('RateLimit-Remaining', Math.max(0, this.globalLimit - global.count));
        res.setHeader('RateLimit-Reset', global.ttl);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return true; // Redis unavailable -> fail open.
    }

    return true;
  }

  private reject(res: Response, retryAfter: number, scope: string): never {
    metrics.rateLimitRejections.inc({ scope });
    res.setHeader('Retry-After', Math.max(1, retryAfter));
    throw new HttpException(
      {
        title: 'Too Many Requests',
        detail: `Rate limit exceeded. Retry after ${Math.max(1, retryAfter)} seconds.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
