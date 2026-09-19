import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../infra/database.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { JwtPayload } from '../../common/types/authenticated-request';

export type ConsultationStatus = 'scheduled' | 'in_progress' | 'completed' | 'no_show' | 'cancelled';

/**
 * Legal transitions. Anything not listed is rejected with 409 — the state
 * machine is data, not scattered `if` statements, so it can be unit-tested and
 * rendered in the architecture doc.
 */
export const CONSULTATION_TRANSITIONS: Record<ConsultationStatus, ConsultationStatus[]> = {
  scheduled: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  no_show: [],
  cancelled: [],
};

export function canTransition(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return CONSULTATION_TRANSITIONS[from]?.includes(to) ?? false;
}

interface ConsultationRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  status: ConsultationStatus;
  mode: string;
  scheduled_at: Date;
  ends_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  chief_complaint: string | null;
  notes_enc: Buffer | null;
  amount: string;
}

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: FieldEncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async findById(id: string, user: JwtPayload) {
    const res = await this.db.query<ConsultationRow>(`SELECT * FROM consultations WHERE id = $1`, [id]);
    const consultation = res.rows[0];
    if (!consultation) throw new NotFoundException({ title: 'Consultation not found' });
    await this.assertAccess(consultation, user, 'read');
    return this.present(consultation, true);
  }

  async listForUser(user: JwtPayload, status?: string, limit = 20, cursor?: string) {
    const params: unknown[] = [];
    const where: string[] = [];

    if (user.role === 'patient') {
      params.push(user.sub);
      where.push(`patient_id = $${params.length}`);
    } else if (user.role === 'doctor') {
      const doctor = await this.db.query<{ id: string }>(`SELECT id FROM doctors WHERE user_id = $1`, [
        user.sub,
      ]);
      if (!doctor.rowCount) return { items: [], nextCursor: null };
      params.push(doctor.rows[0].id);
      where.push(`doctor_id = $${params.length}`);
    }
    // admin/support see everything, subject to audit logging.

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      where.push(`scheduled_at < $${params.length}::timestamptz`);
    }
    params.push(Math.min(limit, 100) + 1);

    const res = await this.db.queryReplica<ConsultationRow>(
      `SELECT * FROM consultations
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY scheduled_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const take = Math.min(limit, 100);
    const rows = res.rows.slice(0, take);
    return {
      items: rows.map((r) => this.present(r, false)),
      nextCursor: res.rows.length > take ? rows[rows.length - 1].scheduled_at.toISOString() : null,
    };
  }

  /** Doctor starts the consultation: scheduled -> in_progress. */
  async start(id: string, user: JwtPayload) {
    return this.transition(id, user, 'in_progress', async (client, consultation) => {
      await client.query(
        `UPDATE consultations SET status='in_progress', started_at = now(), updated_at = now()
          WHERE id = $1`,
        [consultation.id],
      );
      return { joinToken: `stub-rtc-token-${consultation.id}` };
    });
  }

  async complete(id: string, user: JwtPayload) {
    return this.transition(id, user, 'completed', async (client, consultation) => {
      await client.query(
        `UPDATE consultations SET status='completed', ended_at = now(), updated_at = now() WHERE id = $1`,
        [consultation.id],
      );
      await this.outbox.emit(client, {
        aggregateType: 'consultation',
        aggregateId: consultation.id,
        eventType: 'consultation.completed',
        payload: { consultationId: consultation.id, patientId: consultation.patient_id },
      });
      return {};
    });
  }

  async markNoShow(id: string, user: JwtPayload) {
    return this.transition(id, user, 'no_show', async (client, consultation) => {
      await client.query(
        `UPDATE consultations SET status='no_show', ended_at = now(), updated_at = now() WHERE id = $1`,
        [consultation.id],
      );
      return {};
    });
  }

  /** Clinical notes are PHI: encrypted at rest with a versioned envelope. */
  async updateNotes(id: string, user: JwtPayload, notes: string) {
    const res = await this.db.query<ConsultationRow>(`SELECT * FROM consultations WHERE id = $1`, [id]);
    const consultation = res.rows[0];
    if (!consultation) throw new NotFoundException({ title: 'Consultation not found' });

    const isTreating = await this.isTreatingDoctor(user, consultation.doctor_id);
    if (!isTreating) {
      throw new ForbiddenException({ title: 'Only the treating doctor may write clinical notes' });
    }
    if (['cancelled'].includes(consultation.status)) {
      throw new ConflictException({ title: 'Cannot add notes to a cancelled consultation' });
    }

    await this.db.query(
      `UPDATE consultations SET notes_enc = $2, key_version = $3, updated_at = now() WHERE id = $1`,
      [id, this.crypto.encrypt(notes), this.crypto.keyVersion],
    );

    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: 'consultation.notes.update',
      resourceType: 'consultation',
      resourceId: id,
      after: { length: notes.length }, // never log the PHI itself
    });

    return { id, notesUpdated: true };
  }

  private async transition(
    id: string,
    user: JwtPayload,
    to: ConsultationStatus,
    apply: (client: import('pg').PoolClient, consultation: ConsultationRow) => Promise<object>,
  ) {
    const result = await this.db.transaction(async (client) => {
      const res = await client.query<ConsultationRow>(
        `SELECT * FROM consultations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const consultation = res.rows[0];
      if (!consultation) throw new NotFoundException({ title: 'Consultation not found' });

      await this.assertAccess(consultation, user, 'write');

      if (!canTransition(consultation.status, to)) {
        throw new ConflictException({
          title: 'Invalid state transition',
          detail: `Cannot move a consultation from "${consultation.status}" to "${to}". Allowed: ${
            CONSULTATION_TRANSITIONS[consultation.status].join(', ') || 'none (terminal state)'
          }.`,
        });
      }

      const extra = await apply(client, consultation);
      return { consultation, extra };
    });

    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: `consultation.${to}`,
      resourceType: 'consultation',
      resourceId: id,
      before: { status: result.consultation.status },
      after: { status: to },
    });

    return { id, status: to, ...result.extra };
  }

  /** Only the patient, the treating doctor, or an admin may touch a record. */
  private async assertAccess(
    consultation: ConsultationRow,
    user: JwtPayload,
    mode: 'read' | 'write',
  ): Promise<void> {
    if (user.role === 'admin') return;
    if (user.role === 'support' && mode === 'read') return;
    if (consultation.patient_id === user.sub) {
      if (mode === 'read') return;
      // Patients cannot drive the clinical state machine.
      throw new ForbiddenException({ title: 'Only the treating doctor may change consultation state' });
    }
    if (await this.isTreatingDoctor(user, consultation.doctor_id)) return;

    // BOLA protection: identical 404 for "not yours" and "does not exist".
    throw new NotFoundException({ title: 'Consultation not found' });
  }

  private async isTreatingDoctor(user: JwtPayload, doctorId: string): Promise<boolean> {
    if (user.role !== 'doctor') return false;
    const res = await this.db.query(`SELECT 1 FROM doctors WHERE id = $1 AND user_id = $2`, [
      doctorId,
      user.sub,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  private present(c: ConsultationRow, includeNotes: boolean) {
    return {
      id: c.id,
      patientId: c.patient_id,
      doctorId: c.doctor_id,
      slotId: c.slot_id,
      status: c.status,
      mode: c.mode,
      scheduledAt: c.scheduled_at,
      endsAt: c.ends_at,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      chiefComplaint: c.chief_complaint,
      amount: Number(c.amount),
      notes: includeNotes ? this.crypto.decrypt(c.notes_enc) : undefined,
    };
  }
}
