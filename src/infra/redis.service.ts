import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { metrics } from '../observability/metrics';

/**
 * Redis facade: cache-aside helpers, distributed locks, sliding-window rate
 * limiting and single-flight stampede protection.
 *
 * **This client is on the request path and must fail fast.** It previously used
 * `maxRetriesPerRequest: null` — BullMQ requires that, and the setting was
 * copied here — which makes ioredis queue commands indefinitely while the
 * server is unreachable. Commands then never reject, so callers that carefully
 * handle a Redis failure (the rate limiter's fail-open, cache-aside's fallback
 * to Postgres) never get the chance: the request simply hangs. A Redis outage
 * took the whole API down with it, `/healthz` included, because every worker
 * was parked on a promise that would never settle.
 *
 * Now: commands reject after `commandTimeout`, the offline queue is disabled so
 * a command issued while disconnected fails immediately instead of buffering,
 * and retries are bounded. Callers see a prompt error and can degrade.
 *
 * BullMQ keeps its own connection with its own settings — blocking commands
 * like BRPOPLPUSH are supposed to wait, so those must not have a timeout.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private static readonly ERROR_LOG_INTERVAL_MS = 10_000;

  private readonly logger = new Logger(RedisService.name);
  private lastErrorLoggedAt = 0;
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const commandTimeout = this.config.get<number>('REDIS_COMMAND_TIMEOUT_MS', 250);

    this.client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      // Bounded, not infinite: a request-path command must fail fast enough
      // that the caller can fall back within its own latency budget.
      maxRetriesPerRequest: 1,
      commandTimeout,
      connectTimeout: this.config.get<number>('REDIS_CONNECT_TIMEOUT_MS', 2_000),
      // Without this, commands issued while disconnected are buffered and
      // resolve minutes later — long after the HTTP request has gone.
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 3_000),
    });
    // 'error' fires on every reconnect attempt; log sparsely or an outage
    // becomes a log flood that hides the reason for the outage.
    this.client.on('error', (err) => this.logError(err));
  }

  async onModuleInit(): Promise<void> {
    if (this.client.status !== 'wait') return;
    try {
      await this.client.connect();
    } catch (err) {
      // Start degraded rather than refusing to boot. Redis is not required for
      // liveness: the limiter fails open, caches fall through to Postgres, and
      // ioredis keeps reconnecting in the background. Crash-looping the whole
      // API because a cache was briefly unavailable turns a partial outage into
      // a total one — and /readyz already keeps traffic away until it is back.
      this.logger.error(
        `redis unavailable at startup (${(err as Error).message}) — starting degraded, reconnecting in background`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async healthCheck(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  /**
   * Add to a set, best-effort. Used to index cache keys for bulk invalidation,
   * which is itself an optimisation over waiting for TTLs.
   */
  async sAddBestEffort(key: string, ...members: string[]): Promise<void> {
    if (!members.length) return;
    try {
      await this.client.sadd(key, ...members);
    } catch (err) {
      this.degrade('sadd', err);
    }
  }

  /** Read a set, best-effort. An unreachable cache yields nothing to invalidate. */
  async sMembersBestEffort(key: string): Promise<string[]> {
    try {
      return await this.client.smembers(key);
    } catch (err) {
      this.degrade('smembers', err);
      return [];
    }
  }

  /**
   * Record a cache operation that could not reach Redis.
   *
   * Counted as a cache 'error' rather than a miss so the two are
   * distinguishable on the dashboard: a miss is normal, an error means the
   * cache is down and the database is taking the full load.
   */
  private degrade(op: string, err: unknown): void {
    metrics.cacheEvents.inc({ cache: op, result: 'error' });
    this.logError(err instanceof Error ? err : new Error(String(err)));
  }

  /** Collapse repeated connection errors into one line per interval. */
  private logError(err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < RedisService.ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLoggedAt = now;
    this.logger.warn(`redis error: ${err.message}`);
  }

  // ---------------------------------------------------------------- cache

  /**
   * Cache read. A Redis failure is reported as a miss, never as an error.
   *
   * Cache-aside exists so the database is the source of truth and the cache is
   * an optimisation. If an unreachable cache throws, every read path fails and
   * the "optimisation" has become a hard dependency — which is how a Redis
   * blip turned `/doctors/search` into a 500 rather than a slightly slower 200.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.degrade('get', err);
      return null;
    }
  }

  /**
   * Set with a jittered TTL (±10%) to avoid synchronised mass expiry.
   *
   * Best-effort: failing to populate a cache must not fail the request that
   * already has the answer.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const jittered = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', jittered);
    } catch (err) {
      this.degrade('set', err);
    }
  }

  /**
   * Best-effort invalidation. The write it follows has already committed, so
   * throwing here would fail a request whose work is done — and leave the
   * caller unsure whether it succeeded. A stale cache entry expires on its TTL;
   * a spurious 500 does not.
   */
  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.client.del(...keys);
    } catch (err) {
      this.degrade('del', err);
    }
  }

  /** Delete every key matching a pattern using SCAN (never KEYS in prod). */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length) {
          removed += await this.client.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      // Same reasoning as del(): invalidation is best-effort, TTLs are the
      // backstop. Report what was removed before the failure.
      this.degrade('delByPattern', err);
    }
    return removed;
  }

  /**
   * Cache-aside with single-flight: on a miss only one caller computes the
   * value, the rest briefly wait and then read the filled cache.
   */
  async cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;

    const lockKey = `lock:sf:${key}`;
    const token = randomUUID();
    const acquired = await this.client.set(lockKey, token, 'PX', 5_000, 'NX');

    if (!acquired) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const retry = await this.get<T>(key);
        if (retry !== null) return retry;
      }
      return loader();
    }

    try {
      const value = await loader();
      await this.set(key, value, ttlSeconds);
      return value;
    } finally {
      await this.releaseLock(lockKey, token);
    }
  }

  // ----------------------------------------------------------------- lock

  /** Acquire a distributed lock. Returns the fencing token or null. */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return ok ? token : null;
  }

  /** Release only if we still own it (compare-and-delete via Lua). */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    const res = (await this.client.eval(script, 1, key, token)) as number;
    return res === 1;
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    const token = await this.acquireLock(key, ttlMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.releaseLock(key, token);
    }
  }

  // ----------------------------------------------------------- rate limit

  /**
   * Sliding-window counter. Returns the current count and the window reset.
   * Atomic INCR + conditional EXPIRE via Lua so concurrent requests can't
   * reset the window.
   */
  async incrementWindow(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    const script = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      local ttl = redis.call("TTL", KEYS[1])
      return {current, ttl}`;
    const [count, ttl] = (await this.client.eval(script, 1, key, windowSeconds)) as [number, number];
    return { count, ttl };
  }
}
