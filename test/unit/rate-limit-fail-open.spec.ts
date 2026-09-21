import { ConfigService } from '@nestjs/config';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from '../../src/common/guards/rate-limit.guard';
import { metrics } from '../../src/observability/metrics';

/**
 * The rate limiter fails open when Redis is unreachable: the platform staying
 * up is worth more than perfect throttling. That trade-off is defensible right
 * up until it happens silently — an unenforced security control that emits no
 * signal is indistinguishable from one that is working.
 *
 * These tests are about the signal, not the throttling.
 */
describe('RateLimitGuard — fail-open observability', () => {
  const config = new ConfigService({
    RATE_LIMIT_GLOBAL_PER_MIN: 300,
    RATE_LIMIT_ROUTE_MULTIPLIER: 1,
  });

  const makeCtx = (path = '/api/v1/auth/login'): ExecutionContext => {
    const res = { setHeader: jest.fn() };
    const req = { ip: '203.0.113.9', path, route: { path }, user: undefined };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  };

  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;

  const gaugeValue = async (): Promise<number | undefined> => {
    const metric = await metrics.rateLimitEnforcing.get();
    return metric.values[0]?.value;
  };

  const failOpenTotal = async (): Promise<number> => {
    const metric = await metrics.rateLimitFailOpen.get();
    return metric.values.reduce((sum, v) => sum + v.value, 0);
  };

  beforeEach(() => {
    metrics.rateLimitFailOpen.reset();
    metrics.rateLimitEnforcing.reset();
  });

  it('reports that it is enforcing as soon as it is constructed', async () => {
    // A gauge only written on failure reads 0 until the first failure — and 0
    // is the alerting state, so an unseeded gauge pages on every deploy.
    new RateLimitGuard(reflector, { incrementWindow: jest.fn() } as never, config);
    expect(await gaugeValue()).toBe(1);
  });

  it('lets the request through, but records it, when Redis is unreachable', async () => {
    const redis = {
      incrementWindow: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
    };
    const guard = new RateLimitGuard(reflector, redis as never, config);

    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);

    // Availability preserved — and the fact that it cost us enforcement is now
    // visible to Prometheus rather than lost in a bare `return true`.
    expect(await gaugeValue()).toBe(0);
    expect(await failOpenTotal()).toBe(1);
  });

  it('labels the failure so an operator can tell a timeout from a refusal', async () => {
    class TimeoutError extends Error {}
    const redis = { incrementWindow: jest.fn().mockRejectedValue(new TimeoutError('timed out')) };
    const guard = new RateLimitGuard(reflector, redis as never, config);

    await guard.canActivate(makeCtx());

    const metric = await metrics.rateLimitFailOpen.get();
    expect(metric.values[0]?.labels).toMatchObject({ reason: 'TimeoutError' });
  });

  it('does NOT treat a 429 as an outage', async () => {
    // The limiter rejecting a caller is the control working. If that counted as
    // a fail-open, every burst of legitimate throttling would page the on-call.
    const redis = {
      incrementWindow: jest.fn().mockResolvedValue({ count: 100_000, ttl: 42 }),
    };
    const guard = new RateLimitGuard(reflector, redis as never, config);

    await expect(guard.canActivate(makeCtx())).rejects.toBeInstanceOf(HttpException);

    expect(await failOpenTotal()).toBe(0);
    expect(await gaugeValue()).toBe(1);
  });

  it('flips back to enforcing once Redis recovers', async () => {
    const redis = {
      incrementWindow: jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({ count: 1, ttl: 60 }),
    };
    const guard = new RateLimitGuard(reflector, redis as never, config);

    await guard.canActivate(makeCtx());
    expect(await gaugeValue()).toBe(0);

    await guard.canActivate(makeCtx());
    // Recovery must clear the alert by itself; requiring a restart to silence a
    // page is how alerts get routed to /dev/null.
    expect(await gaugeValue()).toBe(1);
    expect(await failOpenTotal()).toBe(1);
  });

  it('counts every bypassed request, not just the first of an outage', async () => {
    const redis = { incrementWindow: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const guard = new RateLimitGuard(reflector, redis as never, config);

    for (let i = 0; i < 25; i++) await guard.canActivate(makeCtx());

    // The log is throttled to avoid a flood; the counter must not be, or the
    // blast radius of an outage is unknowable after the fact.
    expect(await failOpenTotal()).toBe(25);
  });
});
