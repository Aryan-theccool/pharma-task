import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RedisService } from '../../infra/redis.service';
import type { AuthenticatedRequest, JwtPayload } from '../types/authenticated-request';

/**
 * Validates the bearer access token and checks the Redis session denylist so
 * that logout / refresh-reuse revocation takes effect immediately rather than
 * waiting for the 10-minute token TTL to elapse.
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
      const revoked = await this.redis.client.exists(`denylist:session:${payload.sid}`);
      if (revoked) throw new UnauthorizedException({ title: 'Session has been revoked' });
    }

    req.user = payload;
    return true;
  }
}
