import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../../infra/database.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { JwtPayload } from '../../common/types/authenticated-request';
import type { CreatePrescriptionDto, PrescriptionItemDto } from './dto/prescriptions.dto';
import { canonicalJson } from '../../common/utils/canonical-json';

interface PrescriptionRow {
  id: string;
  consultation_id: string;
  doctor_id: string;
  patient_id: string;
  items_enc: Buffer;
  diagnosis_enc: Buffer | null;
  advice_enc: Buffer | null;
  signed_at: Date | null;
  signature: string | null;
  signature_alg: string | null;
  pdf_path: string | null;
  pdf_status: string;
  immutable: boolean;
  created_at: Date;
}

/**
 * Prescriptions.
 *
 * - Only the treating doctor may create one, and only for a consultation that
 *   actually happened (in_progress or completed).
 * - Drug list, diagnosis and advice are PHI -> AES-256-GCM at rest.
 * - Signing is a one-way door: it stamps an HMAC over the canonical content
 *   and flips `immutable`, after which every mutating path returns 409. The
 *   signature lets anyone re-verify the document was not altered after signing.
 * - PDF rendering is dispatched asynchronously through the outbox so a slow
 *   render never blocks the clinical workflow.
 */
@Injectable()
export class PrescriptionsService {
  private readonly signingKey: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: FieldEncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.signingKey = config.getOrThrow<string>('PRESCRIPTION_SIGNING_KEY');
  }

  async create(consultationId: string, user: JwtPayload, dto: CreatePrescriptionDto) {
    const consultation = await this.db.query<{
      id: string;
      patient_id: string;
      doctor_id: string;
      status: string;
    }>(`SELECT id, patient_id, doctor_id, status FROM consultations WHERE id = $1`, [consultationId]);
    const row = consultation.rows[0];
    if (!row) throw new NotFoundException({ title: 'Consultation not found' });

    const doctor = await this.db.query<{ id: string }>(
      `SELECT id FROM doctors WHERE id = $1 AND user_id = $2`,
      [row.doctor_id, user.sub],
    );
    if (!doctor.rowCount && user.role !== 'admin') {
      throw new ForbiddenException({ title: 'Only the treating doctor may issue this prescription' });
    }
    if (!['in_progress', 'completed'].includes(row.status)) {
      throw new ConflictException({
        title: 'Prescription requires an active or completed consultation',
        detail: `Consultation status is "${row.status}".`,
      });
    }

    const created = await this.db.transaction(async (client) => {
      const res = await client.query<PrescriptionRow>(
        `INSERT INTO prescriptions
           (consultation_id, doctor_id, patient_id, items_enc, diagnosis_enc, advice_enc, key_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          consultationId,
          row.doctor_id,
          row.patient_id,
          this.crypto.encryptJson(dto.items),
          dto.diagnosis ? this.crypto.encrypt(dto.diagnosis) : null,
          dto.advice ? this.crypto.encrypt(dto.advice) : null,
          this.crypto.keyVersion,
        ],
      );
      return res.rows[0];
    });

    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'prescription.create',
      resourceType: 'prescription',
      resourceId: created.id,
      after: { consultationId, itemCount: dto.items.length },
    });

    return this.present(created, true);
  }

  /**
   * Sign and freeze. Requires a step-up (MFA) session — enforced by the guard
   * on the controller.
   */
  async sign(id: string, user: JwtPayload) {
    const existing = await this.byId(id);

    const doctor = await this.db.query(`SELECT 1 FROM doctors WHERE id = $1 AND user_id = $2`, [
      existing.doctor_id,
      user.sub,
    ]);
    if (!doctor.rowCount) {
      throw new ForbiddenException({ title: 'Only the prescribing doctor may sign this prescription' });
    }
    if (existing.immutable) {
      throw new ConflictException({
        title: 'Prescription is already signed',
        detail: 'A signed prescription is immutable. Issue a new one to make changes.',
      });
    }

    const payload = this.canonical(existing);
    const signature = createHmac('sha256', this.signingKey).update(payload).digest('hex');

    const res = await this.db.transaction(async (client) => {
      const updated = await client.query<PrescriptionRow>(
        `UPDATE prescriptions
            SET signed_at = now(), signature = $2, signature_alg = 'HMAC-SHA256',
                immutable = true, pdf_status = 'pending', updated_at = now()
          WHERE id = $1 AND immutable = false
          RETURNING *`,
        [id, signature],
      );
      if (!updated.rowCount) throw new ConflictException({ title: 'Prescription is already signed' });

      // Async PDF generation via the outbox -> queue.
      await this.outbox.emit(client, {
        aggregateType: 'prescription',
        aggregateId: id,
        eventType: 'prescription.signed',
        payload: {
          prescriptionId: id,
          consultationId: existing.consultation_id,
          patientId: existing.patient_id,
          doctorId: existing.doctor_id,
        },
      });
      return updated.rows[0];
    });

    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'prescription.sign',
      resourceType: 'prescription',
      resourceId: id,
      after: { signatureAlg: 'HMAC-SHA256' },
    });

    return this.present(res, true);
  }

  async findById(id: string, user: JwtPayload) {
    const row = await this.byId(id);
    await this.assertAccess(row, user);
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'prescription.read',
      resourceType: 'prescription',
      resourceId: id,
    });
    return this.present(row, true);
  }

  /** Recompute the HMAC and report whether the stored content still matches. */
  async verify(id: string, user: JwtPayload) {
    const row = await this.byId(id);
    await this.assertAccess(row, user);
    if (!row.signature) {
      return { id, signed: false, valid: false, reason: 'Prescription has not been signed' };
    }
    const expected = createHmac('sha256', this.signingKey).update(this.canonical(row)).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(row.signature, 'utf8');
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return {
      id,
      signed: true,
      valid,
      signedAt: row.signed_at,
      algorithm: row.signature_alg,
      reason: valid ? 'Signature matches stored content' : 'Content has been altered since signing',
    };
  }

  async listForConsultation(consultationId: string, user: JwtPayload) {
    const res = await this.db.query<PrescriptionRow>(
      `SELECT * FROM prescriptions WHERE consultation_id = $1 ORDER BY created_at DESC`,
      [consultationId],
    );
    const visible: unknown[] = [];
    for (const row of res.rows) {
      try {
        await this.assertAccess(row, user);
        visible.push(this.present(row, false));
      } catch {
        // skip records the caller may not see
      }
    }
    return { items: visible };
  }

  async pdfPath(id: string, user: JwtPayload): Promise<{ path: string; filename: string }> {
    const row = await this.byId(id);
    await this.assertAccess(row, user);
    if (row.pdf_status !== 'ready' || !row.pdf_path) {
      throw new ConflictException({
        title: 'PDF is not ready yet',
        detail: `Current status: ${row.pdf_status}. Sign the prescription and retry shortly.`,
      });
    }
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'prescription.pdf.download',
      resourceType: 'prescription',
      resourceId: id,
    });
    return { path: row.pdf_path, filename: `prescription-${id}.pdf` };
  }

  /** Called by the worker once rendering finishes. */
  async attachPdf(id: string, path: string): Promise<void> {
    await this.db.query(
      `UPDATE prescriptions SET pdf_path = $2, pdf_status = 'ready', updated_at = now() WHERE id = $1`,
      [id, path],
    );
  }

  async markPdfFailed(id: string): Promise<void> {
    await this.db.query(`UPDATE prescriptions SET pdf_status = 'failed' WHERE id = $1`, [id]);
  }

  /** Decrypted view used only by the PDF worker (never exposed over HTTP). */
  async internalDetails(id: string) {
    const row = await this.byId(id);
    const meta = await this.db.query<{
      display_name: string;
      registration_no: string;
      full_name: string;
      scheduled_at: Date;
    }>(
      `SELECT d.display_name, d.registration_no, p.full_name, c.scheduled_at
         FROM prescriptions rx
         JOIN doctors d ON d.id = rx.doctor_id
         JOIN consultations c ON c.id = rx.consultation_id
         JOIN profiles p ON p.user_id = rx.patient_id
        WHERE rx.id = $1
        LIMIT 1`,
      [id],
    );
    return {
      id: row.id,
      createdAt: row.created_at,
      signedAt: row.signed_at,
      signature: row.signature,
      items: this.crypto.decryptJson<PrescriptionItemDto[]>(row.items_enc) ?? [],
      diagnosis: this.crypto.decrypt(row.diagnosis_enc),
      advice: this.crypto.decrypt(row.advice_enc),
      doctorName: meta.rows[0]?.display_name ?? 'Doctor',
      registrationNo: meta.rows[0]?.registration_no ?? '',
      patientName: meta.rows[0]?.full_name ?? 'Patient',
      scheduledAt: meta.rows[0]?.scheduled_at,
    };
  }

  /**
   * Canonical form that the digital signature is computed over. Key order must
   * be deterministic: the same clinical content has to hash identically at sign
   * time and at verification time, however the JSON was stored or parsed.
   */
  private canonical(row: PrescriptionRow): string {
    return canonicalJson({
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      items: this.crypto.decryptJson(row.items_enc),
      diagnosis: this.crypto.decrypt(row.diagnosis_enc),
      advice: this.crypto.decrypt(row.advice_enc),
    });
  }

  private async byId(id: string): Promise<PrescriptionRow> {
    const res = await this.db.query<PrescriptionRow>(`SELECT * FROM prescriptions WHERE id = $1`, [id]);
    if (!res.rowCount) throw new NotFoundException({ title: 'Prescription not found' });
    return res.rows[0];
  }

  private async assertAccess(row: PrescriptionRow, user: JwtPayload): Promise<void> {
    if (user.role === 'admin') return;
    if (row.patient_id === user.sub) return;
    if (user.role === 'doctor') {
      const res = await this.db.query(`SELECT 1 FROM doctors WHERE id = $1 AND user_id = $2`, [
        row.doctor_id,
        user.sub,
      ]);
      if (res.rowCount) return;
    }
    throw new NotFoundException({ title: 'Prescription not found' });
  }

  private present(row: PrescriptionRow, includeContent: boolean) {
    const base = {
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      signed: row.immutable,
      signedAt: row.signed_at,
      signature: row.signature,
      signatureAlg: row.signature_alg,
      pdfStatus: row.pdf_status,
      createdAt: row.created_at,
    };
    if (!includeContent) return base;
    return {
      ...base,
      items: this.crypto.decryptJson<PrescriptionItemDto[]>(row.items_enc) ?? [],
      diagnosis: this.crypto.decrypt(row.diagnosis_enc),
      advice: this.crypto.decrypt(row.advice_enc),
    };
  }
}
