import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class HoldSlotDto {
  @ApiProperty({ format: 'uuid', description: 'The availability slot to reserve.' })
  @IsUUID('4')
  slotId!: string;
}

export class ConfirmBookingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  slotId!: string;

  @ApiProperty({ format: 'uuid', description: 'Token returned by POST /bookings/hold.' })
  @IsUUID('4')
  holdToken!: string;

  @ApiPropertyOptional({ enum: ['video', 'audio', 'chat'], default: 'video' })
  @IsOptional()
  @IsIn(['video', 'audio', 'chat'])
  mode?: 'video' | 'audio' | 'chat';

  @ApiPropertyOptional({ example: 'Recurring acidity and bloating for three weeks.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  chiefComplaint?: string;
}

export class CancelBookingDto {
  @ApiPropertyOptional({ example: 'Travelling that day' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RescheduleDto {
  @ApiProperty({ format: 'uuid', description: 'Target slot (must belong to the same doctor).' })
  @IsUUID('4')
  newSlotId!: string;
}
