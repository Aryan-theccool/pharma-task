import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, MfaVerifyDto, RefreshDto, RegisterDto } from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import type { AuthenticatedRequest, JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private ctx(req: AuthenticatedRequest) {
    return {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: req.requestId ?? null,
    };
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  @RateLimit({ limit: 5, windowSeconds: 60, scope: 'ip' })
  @ApiOperation({
    summary: 'Register a patient or doctor account',
    description:
      'Passwords are hashed with a memory-hard KDF; the email is stored as an AES-256-GCM ciphertext ' +
      'plus a deterministic HMAC blind index for lookup. Privileged roles cannot be self-assigned.',
  })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 409, description: 'Registration could not be completed.' })
  register(@Body() dto: RegisterDto, @Req() req: AuthenticatedRequest) {
    return this.auth.register(dto, this.ctx(req));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'ip' })
  @ApiOperation({
    summary: 'Authenticate and receive an access + refresh token pair',
    description:
      'Returns a 10-minute access token and a rotating refresh token. Accounts lock for 15 minutes ' +
      'after 5 failed attempts. When MFA is enabled the `totp` field is mandatory.',
  })
  login(@Body() dto: LoginDto, @Req() req: AuthenticatedRequest) {
    return this.auth.login(dto, this.ctx(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60, scope: 'ip' })
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Single-use rotation with reuse detection: replaying a consumed token revokes the entire token ' +
      'family, on the assumption that it was exfiltrated.',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: AuthenticatedRequest) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req));
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session and refresh token' })
  async logout(@Body() dto: LogoutDto, @CurrentUser() user: JwtPayload) {
    await this.auth.logout(user.sub, user.sid, dto.refreshToken);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit({ limit: 5, windowSeconds: 300 })
  @Audit({ action: 'auth.mfa.enroll_started', resourceType: 'user' })
  @ApiOperation({
    summary: 'Start TOTP enrolment',
    description: 'Returns an otpauth:// URI and a QR data-URL. The secret only becomes active after verify.',
  })
  enrollMfa(@CurrentUser() user: JwtPayload) {
    return this.auth.enrollMfa(user.sub);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit({ limit: 10, windowSeconds: 300 })
  @ApiOperation({
    summary: 'Confirm TOTP enrolment and receive recovery codes',
    description: 'Ten single-use recovery codes are returned once and stored only as hashes.',
  })
  verifyMfa(@Body() dto: MfaVerifyDto, @CurrentUser() user: JwtPayload) {
    return this.auth.verifyMfaEnrollment(user.sub, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @ApiBearerAuth()
  @RateLimit({ limit: 5, windowSeconds: 300 })
  @ApiOperation({ summary: 'Disable MFA (not permitted for administrators)' })
  async disableMfa(@Body() dto: MfaVerifyDto, @CurrentUser() user: JwtPayload) {
    await this.auth.disableMfa(user.sub, dto.code);
  }
}
