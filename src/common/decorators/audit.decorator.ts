import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditMetadata {
  action: string;
  resourceType: string;
  /** Name of the route/body param holding the resource id. */
  resourceIdFrom?: string;
}

/** Record this route's invocation in the append-only audit log. */
export const Audit = (meta: AuditMetadata) => SetMetadata(AUDIT_KEY, meta);
