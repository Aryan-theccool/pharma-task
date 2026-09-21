import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedRequest, JwtPayload } from '../types/authenticated-request';

/** Injects the verified JWT payload into a handler parameter. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): JwtPayload => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return req.user as JwtPayload;
});
