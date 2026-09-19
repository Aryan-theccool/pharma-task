export interface RetryOptions {
  attempts: number;
  /** Base delay in ms. */
  baseMs: number;
  /** Upper bound on any single delay in ms. */
  capMs: number;
  /** Decide whether an error is worth retrying (default: everything). */
  retryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Exponential backoff with **full jitter**: delay = random(0, min(cap, base*2^n)).
 *
 * Full jitter (rather than equal jitter or plain exponential) is chosen
 * deliberately — it minimises client synchronisation after a shared outage,
 * which is the failure mode that turns a brief blip into a thundering herd.
 */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseMs, capMs, retryable = () => true, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (isLast || !retryable(error)) throw error;
      const delay = backoffDelay(attempt, baseMs, capMs);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject if `promise` has not settled within `ms` (bulkhead against hangs). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Only 5xx / network / timeout failures are safe to retry automatically. */
export function isTransientError(error: unknown): boolean {
  const e = error as { code?: string; status?: number; statusCode?: number };
  if (e?.code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(e.code)) {
    return true;
  }
  const status = e?.status ?? e?.statusCode;
  return typeof status === 'number' && status >= 500;
}
