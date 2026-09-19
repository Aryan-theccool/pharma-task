import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global: the audit interceptor and virtually every domain service records to
 * the append-only trail, so a single shared instance owns the hash chain.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
