import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentTraceIds } from '../../observability/tracing';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId?: string;
  traceId?: string;
  errors?: unknown;
  timestamp: string;
}

/**
 * RFC 7807 `application/problem+json` error responses.
 *
 * Internal errors never leak a stack trace or driver message to the client in
 * production — the full error goes to the structured log, correlated by
 * requestId/traceId so support can find it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const { traceId } = currentTraceIds();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        title = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        title = (p.title as string) ?? (p.error as string) ?? defaultTitle(status);
        detail = (p.detail as string) ?? messageToDetail(p.message);
        if (Array.isArray(p.message)) errors = p.message;
        if (p.errors) errors = p.errors;
      }
    } else if (isPgError(exception)) {
      const mapped = mapPostgresError(exception);
      status = mapped.status;
      title = mapped.title;
      detail = mapped.detail;
    } else if (exception instanceof Error) {
      detail = this.isProduction ? undefined : exception.message;
    }

    const problem: ProblemDetails = {
      type: problemType(status),
      title,
      status,
      detail,
      instance: req.originalUrl ?? req.url,
      requestId: req.requestId,
      traceId,
      errors,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId: req.requestId, traceId, path: problem.instance },
        `Unhandled ${status} on ${req.method} ${problem.instance}`,
      );
    } else if (status === 429 || status === 403 || status === 401) {
      this.logger.warn(
        { requestId: req.requestId, traceId, status, path: problem.instance },
        `${status} ${title}`,
      );
    }

    res.status(status).type('application/problem+json').json(problem);
  }
}

function messageToDetail(message: unknown): string | undefined {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return undefined;
}

function defaultTitle(status: number): string {
  return HttpStatus[status] ? String(HttpStatus[status]).replace(/_/g, ' ') : 'Error';
}

function problemType(status: number): string {
  return `https://httpstatuses.io/${status}`;
}

function isPgError(e: unknown): e is { code: string; constraint?: string; detail?: string } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

/** Translate Postgres integrity errors into meaningful HTTP semantics. */
function mapPostgresError(e: { code: string; constraint?: string }): {
  status: number;
  title: string;
  detail?: string;
} {
  switch (e.code) {
    case '23505': // unique_violation
      return {
        status: HttpStatus.CONFLICT,
        title: 'Resource already exists',
        detail: e.constraint ? `Conflicting constraint: ${e.constraint}` : undefined,
      };
    case '23P01': // exclusion_violation — overlapping slot
      return {
        status: HttpStatus.CONFLICT,
        title: 'Time range conflicts with an existing slot',
        detail: 'Another slot already overlaps this time range for this doctor.',
      };
    case '23503':
      return { status: HttpStatus.BAD_REQUEST, title: 'Referenced resource does not exist' };
    case '23514':
      return { status: HttpStatus.BAD_REQUEST, title: 'Value violates a domain constraint' };
    case '55P03': // lock_not_available (FOR UPDATE NOWAIT)
      return {
        status: HttpStatus.CONFLICT,
        title: 'Resource is locked by a concurrent request',
        detail: 'Another booking is in progress for this slot. Retry shortly.',
      };
    case '57014':
      return { status: HttpStatus.GATEWAY_TIMEOUT, title: 'Database statement timeout' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, title: 'Internal Server Error' };
  }
}
