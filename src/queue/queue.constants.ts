export const QUEUE_NOTIFICATIONS = 'notifications';
export const QUEUE_PDF = 'prescription-pdf';
export const QUEUE_ANALYTICS = 'analytics';

/**
 * Shared BullMQ job policy: 5 attempts with exponential backoff, failures kept
 * for inspection (a dead-letter queue by another name), successes trimmed to
 * bound Redis memory.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};
