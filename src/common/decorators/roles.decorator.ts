import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import type { UserRole } from '../types/authenticated-request';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given roles (enforced by RolesGuard). */
export const Roles = (...roles: UserRole[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    ApiForbiddenResponse({ description: `Requires role: ${roles.join(' | ')}` }),
  );
