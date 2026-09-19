import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { createReadStream, existsSync } from 'node:fs';
import type { Response } from 'express';
import { PrescriptionsService } from './prescriptions.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { JwtPayload } from '../../common/types/authenticated-request';

@ApiTags('prescriptions')
@ApiBearerAuth()
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Fetch a prescription (decrypted for authorised readers)',
    description: 'Visible to the patient, the prescribing doctor and admins. Every read is audited.',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.prescriptions.findById(id, user);
  }

  @Post(':id/sign')
  @Roles('doctor', 'admin')
  @RequireMfa()
  @Idempotent()
  @ApiOperation({
    summary: 'Digitally sign a prescription (step-up MFA required)',
    description:
      'Stamps an HMAC-SHA256 signature over the canonical content and makes the record immutable. ' +
      'Triggers asynchronous PDF generation via the transactional outbox.',
  })
  sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.prescriptions.sign(id, user);
  }

  @Get(':id/verify')
  @ApiOperation({
    summary: 'Verify the digital signature',
    description: 'Recomputes the HMAC over current content to prove nothing changed after signing.',
  })
  verify(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.prescriptions.verify(id, user);
  }

  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Download the generated PDF',
    description: 'Returns 409 until the asynchronous worker has finished rendering.',
  })
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { path, filename } = await this.prescriptions.pdfPath(id, user);
    if (!existsSync(path)) {
      throw new NotFoundException({ title: 'PDF file is missing from storage' });
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store', // never cache PHI
    });
    return new StreamableFile(createReadStream(path));
  }
}
