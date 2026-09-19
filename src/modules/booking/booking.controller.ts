import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BookingService } from './booking.service';
import { CancelBookingDto, ConfirmBookingDto, HoldSlotDto, RescheduleDto } from './dto/booking.dto';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('booking')
@ApiBearerAuth()
@Controller('bookings')
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Post('hold')
  @HttpCode(201)
  @Roles('patient', 'admin')
  @Idempotent()
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Hold a slot for a short window',
    description:
      'Reserves the slot for 5 minutes and returns an unguessable holdToken bound to the caller. ' +
      'Protected by a Redis lock, a `FOR UPDATE NOWAIT` row lock and a GiST exclusion constraint, ' +
      'so concurrent holds on the same slot yield exactly one winner.',
  })
  @ApiResponse({ status: 201, description: 'Slot held.' })
  @ApiResponse({ status: 409, description: 'Slot unavailable or contended.' })
  hold(@Body() dto: HoldSlotDto, @CurrentUser() user: JwtPayload) {
    return this.booking.hold(user, dto);
  }

  @Post('confirm')
  @HttpCode(201)
  @Roles('patient', 'admin')
  @Idempotent()
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({
    summary: 'Confirm a held slot (booking saga)',
    description:
      'Runs the orchestrated saga: validate hold → authorize payment → create consultation → ' +
      'capture payment → emit notifications through the transactional outbox. Any failure triggers ' +
      'compensations in reverse order (void/refund payment, cancel consultation, release slot).',
  })
  @ApiResponse({ status: 201, description: 'Consultation created and payment captured.' })
  @ApiResponse({ status: 409, description: 'Hold expired, slot already booked, or duplicate in flight.' })
  confirm(@Body() dto: ConfirmBookingDto, @CurrentUser() user: JwtPayload) {
    return this.booking.confirm(user, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancel a consultation',
    description:
      'Releases the slot and refunds automatically when cancelled outside the refund window ' +
      '(REFUND_WINDOW_HOURS, default 24h).',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.booking.cancel(user, id, dto);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @Roles('patient', 'admin')
  @Idempotent()
  @ApiOperation({
    summary: 'Move a consultation to another slot',
    description: 'Claims the new slot and releases the old one in a single atomic transaction.',
  })
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.booking.reschedule(user, id, dto);
  }
}
