import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /** Bucket dimension: per authenticated user, or per client IP. */
  scope?: 'user' | 'ip';
}

/** Per-route rate limit, layered on top of the global limiter. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
