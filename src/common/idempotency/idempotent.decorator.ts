import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a route as requiring an `Idempotency-Key` header, and documents the
 * replay semantics in the generated OpenAPI spec.
 */
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Client-generated unique key (UUIDv4 recommended). Replaying the same key with the same ' +
        'payload returns the original response with `Idempotent-Replay: true`. Reusing it with a ' +
        'different payload returns 409. Keys are scoped to user + endpoint and expire after 24h.',
      schema: { type: 'string', example: '5f1d8f4e-6c2b-4a5b-9f1e-3b7c1d2e4a55' },
    }),
    ApiResponse({
      status: 409,
      description: 'Idempotency-Key reused with a different payload, or an identical request is in flight.',
    }),
  );
