import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class RefundDto {
  @ApiPropertyOptional({ description: 'Partial refund amount. Defaults to the full amount.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({ example: 'Patient cancelled within the refund window' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class WebhookDto {
  @ApiProperty({ example: 'evt_01HX8Z0Q' })
  @IsString()
  @MaxLength(128)
  eventId!: string;

  @ApiProperty({ example: 'payment.captured' })
  @IsString()
  @MaxLength(64)
  type!: string;

  @ApiPropertyOptional({ example: 'mock_4b1f...' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  providerRef?: string;

  @ApiPropertyOptional({ example: 'captured' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
