import { SetMetadata } from '@nestjs/common';

export const READ_ONLY_KEY = 'readOnly';

/**
 * Marks a handler as replica-safe. Repositories consult this to route the
 * query to DATABASE_REPLICA_URL when a read replica is configured.
 */
export const ReadOnly = () => SetMetadata(READ_ONLY_KEY, true);
