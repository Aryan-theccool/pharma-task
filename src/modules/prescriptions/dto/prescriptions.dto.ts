import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PrescriptionItemDto {
  @ApiProperty({ example: 'Triphala Churna' })
  @IsString()
  @Length(2, 200)
  drug!: string;

  @ApiProperty({ example: '5 g' })
  @IsString()
  @Length(1, 60)
  dosage!: string;

  @ApiProperty({ example: 'Twice daily after meals' })
  @IsString()
  @Length(1, 200)
  frequency!: string;

  @ApiProperty({ example: '14 days' })
  @IsString()
  @Length(1, 60)
  duration!: string;

  @ApiPropertyOptional({ example: 'Take with warm water' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;
}

export class CreatePrescriptionDto {
  @ApiProperty({ type: [PrescriptionItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];

  @ApiPropertyOptional({ example: 'Functional dyspepsia' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  diagnosis?: string;

  @ApiPropertyOptional({ example: 'Avoid cold drinks; walk 20 minutes after dinner.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  advice?: string;
}
