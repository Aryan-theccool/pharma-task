import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Asha Patel' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ example: '1991-04-17', description: 'Encrypted at rest.' })
  @IsOptional()
  @IsISO8601()
  dob?: string;

  @ApiPropertyOptional({ enum: ['female', 'male', 'other', 'undisclosed'] })
  @IsOptional()
  @IsIn(['female', 'male', 'other', 'undisclosed'])
  gender?: string;

  @ApiPropertyOptional({ description: 'Encrypted at rest.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: 'en-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}
