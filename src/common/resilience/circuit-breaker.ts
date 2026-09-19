import { Logger } from '@nestjs/common';
import { metrics } from '../../observability/metrics';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  /** Error ratio (0..1) that trips the breaker. */
  errorThreshold: number;
  /** Minimum sample size before the ratio is considered meaningful. */
  volumeThreshold: number;
  /** How long to stay open before probing again, in ms. */
  resetTimeoutMs: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

export class CircuitOpenError extends Error {
  readonly code = 'ECIRCUITOPEN';
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Rolling-window circuit breaker for outbound dependencies (payment gateway).
 *
 * closed --(error ratio > threshold over >= volume calls)--> open
 * open   --(after resetTimeout)-------------------------->  half-open
 * half-open --(probe succeeds)--> closed | --(probe fails)--> open
 *
 * Prevents a slow dependency from consuming the API's connection pool and
 * turning a partner outage into our own outage.
 */
export class CircuitBreaker {
  private readonly logger: Logger;
  private state: BreakerState = 'closed';
  private results: Array<{ at: number; ok: boolean }> = [];
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.logger = new Logger(`CircuitBreaker:${options.name}`);
    this.report();
  }

  get currentState(): BreakerState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.refresh();

    if (this.state === 'open') throw new CircuitOpenError(this.options.name);

    if (this.state === 'half-open') {
      if (this.halfOpenInFlight) throw new CircuitOpenError(this.options.name);
      this.halfOpenInFlight = true;
      try {
        const result = await fn();
        this.close();
        return result;
      } catch (error) {
        this.open();
        throw error;
      } finally {
        this.halfOpenInFlight = false;
      }
    }

    try {
      const result = await fn();
      this.record(true);
      return result;
    } catch (error) {
      this.record(false);
      return Promise.reject(error);
    }
  }

  private record(ok: boolean): void {
    const now = Date.now();
    this.results.push({ at: now, ok });
    this.results = this.results.filter((r) => now - r.at <= this.options.windowMs);

    if (this.results.length >= this.options.volumeThreshold) {
      const failures = this.results.filter((r) => !r.ok).length;
      if (failures / this.results.length >= this.options.errorThreshold) this.open();
    }
  }

  private refresh(): void {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.state = 'half-open';
      this.report();
      this.logger.warn('transitioning to half-open (probing dependency)');
    }
  }

  private open(): void {
    if (this.state !== 'open') this.logger.error('circuit OPEN — shedding calls to dependency');
    this.state = 'open';
    this.openedAt = Date.now();
    this.results = [];
    this.report();
  }

  private close(): void {
    if (this.state !== 'closed') this.logger.log('circuit CLOSED — dependency recovered');
    this.state = 'closed';
    this.results = [];
    this.report();
  }

  private report(): void {
    const value = this.state === 'closed' ? 0 : this.state === 'half-open' ? 1 : 2;
    metrics.circuitBreakerState.set({ breaker: this.options.name }, value);
  }

  /** Test seam. */
  reset(): void {
    this.close();
  }
}
