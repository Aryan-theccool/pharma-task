import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RedisService } from '../../infra/redis.service';
import { metrics } from '../../observability/metrics';
import type { AuthenticatedRequest, JwtPayload } from '../types/authenticated-request';

/**
 * Validates the bearer access token and checks the Redis session denylist so
 * that logout / refresh-reuse revocation takes effect immediately rather than
 * waiting for the 10-minute token TTL to elapse.
 *
 * **This check fails CLOSED.** If the denylist cannot be read we cannot know
 * whether the presented session was revoked, and a revoked session is exactly
 * the one an attacker would be replaying. Rejecting costs a legitimate user a
 * retry; accepting silently reinstates every logged-out and refresh-reuse-
 * revoked session for as long as the outage lasts. Contrast the rate limiter,
 * which fails open — availability outranks throttling, but never
 * authentication.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ title: 'Missing bearer token' });
    }

    const token = header.slice(7);
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({ title: 'Invalid or expired access token' });
    }

    if (payload.sid) {
      let revoked: number;
      try {
        revoked = await this.redis.client.exists(`denylist:session:${payload.sid}`);
      } catch (err) {
        // Deliberate fail-closed, made observable: a 503 tells the client to
        // retry, and the counter makes the blast radius visible instead of
        // hiding it inside a generic 500.
        metrics.authDenylistUnavailable.inc({ reason: (err as Error).constructor.name });
        throw new ServiceUnavailableException({
          title: 'Session verification temporarily unavailable',
          detail: 'Unable to verify session revocation status. Please retry.',
        });
      }
      if (revoked) throw new UnauthorizedException({ title: 'Session has been revoked' });
    }

    req.user = payload;
    return true;
  }
}
