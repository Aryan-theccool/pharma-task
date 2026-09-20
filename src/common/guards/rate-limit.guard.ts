import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
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
 *
 * Failing open is only defensible if it is *visible*. This previously returned
 * `true` from a bare catch: throttling silently stopped being enforced and
 * nothing — no log, no metric, no alert — said so, which is the difference
 * between an accepted risk and an unknown one. Every fail-open now increments
 * `rate_limit_fail_open_total`, drops `rate_limit_enforcing` to 0 and logs at
 * error level (rate-limited to one line per 10s so a Redis outage cannot turn
 * into a log flood). `RateLimiterFailingOpen` pages on it.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static readonly LOG_INTERVAL_MS = 10_000;

  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly globalLimit: number;
  private readonly routeMultiplier: number;
  private lastFailureLoggedAt = 0;
  private degraded = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.globalLimit = config.get<number>('RATE_LIMIT_GLOBAL_PER_MIN', 300);
    this.routeMultiplier = config.get<number>('RATE_LIMIT_ROUTE_MULTIPLIER', 1);

    // Seed the gauge. A gauge only written on failure reads 0 until the first
    // failure — and 0 is the alerting state, so every deploy would page.
    metrics.rateLimitEnforcing.set(1);
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
        const limit = Math.ceil(routeOptions.limit * this.routeMultiplier);

        res.setHeader('RateLimit-Limit', limit);
        res.setHeader('RateLimit-Remaining', Math.max(0, limit - routeWindow.count));
        res.setHeader('RateLimit-Reset', routeWindow.ttl);

        if (routeWindow.count > limit) {
          this.reject(res, routeWindow.ttl, routePath);
        }
      } else {
        res.setHeader('RateLimit-Limit', this.globalLimit);
        res.setHeader('RateLimit-Remaining', Math.max(0, this.globalLimit - global.count));
        res.setHeader('RateLimit-Reset', global.ttl);
      }
      // Reached Redis: if we were degraded, we have recovered.
      this.markEnforcing();
    } catch (error) {
      // A 429 is the limiter working, not failing — rethrow before the
      // fail-open path, or every rejection would look like an outage.
      if (error instanceof HttpException) throw error;
      this.failOpen(error, routePath);
      return true;
    }

    return true;
  }

  /** Record that the limiter is unenforced, and say so out loud. */
  private failOpen(error: unknown, routePath: string): void {
    const reason = error instanceof Error ? error.constructor.name : 'unknown';
    metrics.rateLimitFailOpen.inc({ reason });
    metrics.rateLimitEnforcing.set(0);

    const now = Date.now();
    if (!this.degraded || now - this.lastFailureLoggedAt > RateLimitGuard.LOG_INTERVAL_MS) {
      this.lastFailureLoggedAt = now;
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          route: routePath,
          reason,
        },
        'rate limiter FAILING OPEN — Redis unreachable, requests are not being throttled',
      );
    }
    this.degraded = true;
  }

  private markEnforcing(): void {
    if (!this.degraded) return;
    this.degraded = false;
    metrics.rateLimitEnforcing.set(1);
    this.logger.warn('rate limiter recovered — throttling is being enforced again');
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
