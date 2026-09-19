import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateNotesDto {
  @ApiProperty({ example: 'Patient reports improvement. Continue triphala for two weeks.' })
  @IsString()
  @MaxLength(20_000)
  notes!: string;
}

export class ListConsultationsQuery {
  @ApiPropertyOptional({ enum: ['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'] })
  @IsOptional()
  @IsIn(['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'ISO timestamp cursor from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
