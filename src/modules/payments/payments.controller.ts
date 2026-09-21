import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { RefundDto, WebhookDto } from './dto/payments.dto';
import { Public } from '../../common/decorators/public.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the caller’s payments' })
  list(@CurrentUser() user: JwtPayload) {
    return this.payments.listForUser(user);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fetch a payment (owner or admin only)' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.payments.findForUser(id, user);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @ApiBearerAuth()
  @RequireMfa()
  @Idempotent()
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Refund a payment (step-up MFA required)',
    description: 'Full or partial. Idempotency-Key guarantees a retry never issues a second refund.',
  })
  refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto, @CurrentUser() user: JwtPayload) {
    return this.payments.refund(id, user, dto.amount, `refund-api:${id}:${dto.amount ?? 'full'}`, dto.reason);
  }

  /**
   * Provider webhook. Public (the provider has no user session) but protected
   * by HMAC signature verification, a timestamp freshness window and a unique
   * event-id insert, so it is authentic, replay-bounded and exactly-once.
   */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  @RateLimit({ limit: 200, windowSeconds: 60, scope: 'ip' })
  @ApiOperation({
    summary: 'Payment provider webhook (HMAC verified, replay-safe)',
    description:
      'Requires `X-Signature` (hex HMAC-SHA256 of `${timestamp}.${rawBody}`) and `X-Timestamp` ' +
      '(unix seconds, ±5 min). Duplicate eventIds are acknowledged without reprocessing.',
  })
  webhook(
    @Body() dto: WebhookDto,
    @Headers('x-signature') signature: string,
    @Headers('x-timestamp') timestamp: string,
    @Req() req: Request & { rawBody?: string },
  ) {
    return this.payments.handleWebhook({
      rawBody: req.rawBody ?? JSON.stringify(dto),
      signature,
      timestamp,
      body: dto,
    });
  }

  @ApiExcludeEndpoint()
  @Get('health/ping')
  @Public()
  ping() {
    return { ok: true };
  }
}
