import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';
import { OutboxService } from '../common/outbox/outbox.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { FieldEncryptionService } from '../common/crypto/field-encryption.service';
import { PasswordService } from '../common/crypto/password.service';
import { QueueService } from '../queue/queue.service';

/**
 * Infrastructure adapters and cross-cutting primitives.
 *
 * Marked @Global because these are true singletons (connection pools, key
 * material, queue producers) that every feature module needs; re-importing
 * them per module would add ceremony without adding isolation. Feature
 * modules stay narrow and depend only on these interfaces.
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    RedisService,
    OutboxService,
    IdempotencyService,
    FieldEncryptionService,
    PasswordService,
    QueueService,
  ],
  exports: [
    DatabaseService,
    RedisService,
    OutboxService,
    IdempotencyService,
    FieldEncryptionService,
    PasswordService,
    QueueService,
  ],
})
export class InfraModule {}
