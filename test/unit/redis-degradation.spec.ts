import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../src/infra/redis.service';
import { metrics } from '../../src/observability/metrics';

/**
 * Regression tests for a real outage, not a hypothetical one.
 *
 * The rate limiter had a carefully written fail-open path that production could
 * never reach. `RedisService` was constructed with `maxRetriesPerRequest: null`
 * — correct for BullMQ, which needs blocking commands to wait indefinitely, and
 * copied to the request-path client where it is actively harmful. ioredis then
 * queued commands forever instead of rejecting them, so during a Redis outage
 * no Redis call ever settled: the fail-open `catch` never fired, requests hung
 * until the client gave up, and `/healthz` wedged along with everything else.
 * A cache being down took the entire API with it.
 *
 * Unit tests did not catch it because they mocked Redis with a promptly
 * rejecting stub — the mock asserted the behaviour the real client lacked. So
 * these tests assert the *configuration* that makes rejection possible, plus
 * the degradation semantics layered on top of it.
 */
describe('RedisService — behaviour during a Redis outage', () => {
  const build = (overrides: Record<string, unknown> = {}) =>
    new RedisService(
      new ConfigService({
        REDIS_URL: 'redis://127.0.0.1:6399', // deliberately closed port
        ...overrides,
      }),
    );

  let service: RedisService;

  afterEach(async () => {
    await service?.onModuleDestroy?.().catch(() => undefined);
  });

  describe('client configuration', () => {
    it('bounds retries so a command can actually fail', () => {
      service = build();
      // `null` means "retry forever" — the exact setting that made the
      // fail-open path unreachable. Anything finite lets the promise reject.
      expect(service.client.options.maxRetriesPerRequest).not.toBeNull();
      expect(service.client.options.maxRetriesPerRequest).toBeLessThanOrEqual(3);
    });

    it('sets a command timeout so a hung server cannot hold a request open', () => {
      service = build();
      expect(service.client.options.commandTimeout).toBeGreaterThan(0);
      // Tight enough to stay inside the read-path p95 budget of 200ms plus
      // headroom; a slower cache lookup is worse than no lookup.
      expect(service.client.options.commandTimeout).toBeLessThanOrEqual(1_000);
    });

    it('disables the offline queue so commands do not buffer while disconnected', () => {
      service = build();
      // With the offline queue enabled, a command issued during an outage is
      // buffered and resolves long after the HTTP request has been abandoned.
      expect(service.client.options.enableOfflineQueue).toBe(false);
    });

    it('honours configured timeout overrides', () => {
      service = build({ REDIS_COMMAND_TIMEOUT_MS: 75, REDIS_CONNECT_TIMEOUT_MS: 500 });
      expect(service.client.options.commandTimeout).toBe(75);
      expect(service.client.options.connectTimeout).toBe(500);
    });
  });

  describe('graceful degradation', () => {
    beforeEach(() => {
      service = build();
    });

    const errorCount = async (op: string): Promise<number> => {
      const metric = await metrics.cacheEvents.get();
      return metric.values
        .filter((v) => v.labels.cache === op && v.labels.result === 'error')
        .reduce((sum, v) => sum + v.value, 0);
    };

    it('reports a cache read as a miss rather than throwing', async () => {
      const before = await errorCount('get');

      // The database is the source of truth; the cache is an optimisation.
      // If an unreachable cache throws, the optimisation has silently become a
      // hard dependency and every read path 500s.
      await expect(service.get('doctor:123')).resolves.toBeNull();
      expect(await errorCount('get')).toBe(before + 1);
    });

    it('swallows a failed cache write so the answer still reaches the caller', async () => {
      const before = await errorCount('set');
      await expect(service.set('doctor:123', { id: '123' }, 60)).resolves.toBeUndefined();
      expect(await errorCount('set')).toBe(before + 1);
    });

    it('swallows failed invalidation, which runs after the write has committed', async () => {
      // Throwing here would fail a request whose work is already durable, and
      // leave the caller unable to tell whether it succeeded. TTLs are the
      // backstop for a stale entry.
      await expect(service.del('doctor:123')).resolves.toBeUndefined();
      await expect(service.delByPattern('search:*')).resolves.toBe(0);
      await expect(service.sAddBestEffort('search:keys', 'search:abc')).resolves.toBeUndefined();
      await expect(service.sMembersBestEffort('search:keys')).resolves.toEqual([]);
    });

    it('counts cache errors separately from cache misses', async () => {
      await service.get('doctor:456');
      const metric = await metrics.cacheEvents.get();
      // A miss is routine; an error means the cache is gone and Postgres is
      // absorbing the full read load. Conflating them hides an outage.
      expect(metric.values.some((v) => v.labels.result === 'error')).toBe(true);
    });

    it('starts degraded instead of refusing to boot when Redis is down', async () => {
      // Crash-looping the API because a cache was briefly unavailable turns a
      // partial outage into a total one. /readyz keeps traffic away until the
      // dependency returns.
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('surfaces lock acquisition failures instead of hiding them', async () => {
      // Booking correctness depends on this lock, so unlike the cache it must
      // fail CLOSED — the caller needs the error to abort the booking rather
      // than proceed as though it holds a lock it does not.
      await expect(service.acquireLock('lock:slot:1', 5_000)).rejects.toThrow();
    });
  });
});
