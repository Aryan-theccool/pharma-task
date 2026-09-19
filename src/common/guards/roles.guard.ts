import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedRequest, UserRole } from '../types/authenticated-request';

/** Coarse-grained RBAC. Fine-grained ownership (ABAC) lives in the services. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException({ title: 'Authentication required' });

    if (!required.includes(user.role)) {
      throw new ForbiddenException({
        title: 'Insufficient role',
        detail: `This endpoint requires one of: ${required.join(', ')}.`,
      });
    }
    return true;
  }
}
