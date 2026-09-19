import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * Redis facade: cache-aside helpers, distributed locks, sliding-window rate
 * limiting and single-flight stampede protection.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 3_000),
    });
    this.client.on('error', (err) => this.logger.warn(`redis error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    if (this.client.status === 'wait') await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async healthCheck(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  // ---------------------------------------------------------------- cache

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Set with a jittered TTL (±10%) to avoid synchronised mass expiry. */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const jittered = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
    await this.client.set(key, JSON.stringify(value), 'EX', jittered);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /** Delete every key matching a pattern using SCAN (never KEYS in prod). */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) {
        removed += await this.client.del(...keys);
      }
    } while (cursor !== '0');
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
