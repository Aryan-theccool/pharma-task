import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class OnboardDoctorDto {
  @ApiProperty({ example: 'Dr. Meera Iyer' })
  @IsString()
  @Length(2, 120)
  displayName!: string;

  @ApiProperty({ example: 'MCI-2024-118823' })
  @IsString()
  @Length(4, 64)
  registrationNo!: string;

  @ApiPropertyOptional({ example: 'Ayurvedic practitioner focused on digestive health.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiProperty({ example: ['ayurveda', 'dermatology'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  specializations!: string[];

  @ApiProperty({ example: ['en', 'hi'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages!: string[];

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(70)
  experienceYears?: number;

  @ApiProperty({ example: 750 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  consultationFee!: number;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class UpdateDoctorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  specializations?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(70)
  experienceYears?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  consultationFee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ enum: ['pending', 'verified', 'rejected'], description: 'Admin only.' })
  @IsOptional()
  @IsIn(['pending', 'verified', 'rejected'])
  verificationState?: 'pending' | 'verified' | 'rejected';
}

export class SearchDoctorsQuery {
  @ApiPropertyOptional({ description: 'Free-text search over name, specialization, language and bio.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ example: 'ayurveda' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  specialization?: string;

  @ApiPropertyOptional({ example: 'hi' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @ApiPropertyOptional({ example: 300 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minFee?: number;

  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxFee?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minExperience?: number;

  @ApiPropertyOptional({ description: 'Only doctors with a free slot at or after this instant.' })
  @IsOptional()
  @IsISO8601()
  availableFrom?: string;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateAvailabilityRuleDto {
  @ApiProperty({ example: 1, description: '0 = Sunday … 6 = Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Length(5, 5)
  startTime!: string;

  @ApiProperty({ example: '13:00' })
  @IsString()
  @Length(5, 5)
  endTime!: string;

  @ApiPropertyOptional({ example: 30, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  slotMinutes?: number;

  @ApiProperty({ example: '2026-09-20' })
  @IsString()
  @Length(10, 10)
  validFrom!: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsString()
  @Length(10, 10)
  validTo?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class SlotQueryDto {
  @ApiProperty({ example: '2026-09-20T00:00:00.000Z' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ example: '2026-09-27T00:00:00.000Z' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({ enum: ['available', 'held', 'booked', 'blocked'] })
  @IsOptional()
  @IsIn(['available', 'held', 'booked', 'blocked'])
  status?: string;
}

export class BlockSlotDto {
  @ApiProperty({ example: '2026-09-20T09:00:00.000Z' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ example: '2026-09-20T11:00:00.000Z' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({ example: 'Personal leave' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;
}

export class MaterializeSlotsDto {
  @ApiProperty({ example: '2026-09-20' })
  @IsString()
  @Length(10, 10)
  from!: string;

  @ApiProperty({ example: 14, description: 'Number of days to materialise.' })
  @IsInt()
  @Min(1)
  @Max(90)
  days!: number;
}
