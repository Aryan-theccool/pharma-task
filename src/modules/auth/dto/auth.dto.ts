import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'asha.patel@example.com' })
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: 'Str0ng!Passphrase2024',
    description: 'Min 12 chars with upper, lower, digit and symbol.',
  })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Asha Patel' })
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'phone must be 8-15 digits, optionally prefixed with +' })
  phone?: string;

  @ApiPropertyOptional({ enum: ['patient', 'doctor'], default: 'patient' })
  @IsOptional()
  @IsIn(['patient', 'doctor'])
  role?: 'patient' | 'doctor';
}

export class LoginDto {
  @ApiProperty({ example: 'asha.patel@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Str0ng!Passphrase2024' })
  @IsString()
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ example: '123456', description: 'TOTP code, required when MFA is enabled.' })
  @IsOptional()
  @IsString()
  @Length(6, 20)
  totp?: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'The opaque refresh token returned by /auth/login.' })
  @IsString()
  @MaxLength(300)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  refreshToken?: string;
}

export class MfaVerifyDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 20)
  code!: string;
}
