import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';

export const REQUIRE_MFA_KEY = 'requireMfa';

/** Demand a step-up (MFA-authenticated) session for sensitive operations. */
export const RequireMfa = () =>
  applyDecorators(
    SetMetadata(REQUIRE_MFA_KEY, true),
    ApiForbiddenResponse({ description: 'Requires a multi-factor authenticated session.' }),
  );
