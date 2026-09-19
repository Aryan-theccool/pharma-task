import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_MFA_KEY } from '../decorators/require-mfa.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Step-up authentication. Routes with @RequireMfa() (prescription signing,
 * refunds, admin analytics) demand a session whose `amr` claim proves an MFA
 * challenge was satisfied during login — a stolen password alone is not enough.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException({ title: 'Authentication required' });

    if (!user.amr?.includes('mfa')) {
      throw new ForbiddenException({
        title: 'Step-up authentication required',
        detail:
          'This operation requires a multi-factor authenticated session. Re-authenticate with your TOTP code.',
      });
    }
    return true;
  }
}
