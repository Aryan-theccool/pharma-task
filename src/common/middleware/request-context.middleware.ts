import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Assigns/propagates a request id and echoes it back as `X-Request-Id`, so a
 * client-reported failure can be found in the logs, the audit trail and the
 * trace backend with one identifier.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
