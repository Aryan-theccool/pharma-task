import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { QUEUE_ANALYTICS, QUEUE_NOTIFICATIONS, QUEUE_PDF } from './queue.constants';
import { DatabaseService } from '../infra/database.service';
import { PrescriptionsService } from '../modules/prescriptions/prescriptions.service';
import { AdminService } from '../modules/admin/admin.service';
import { metrics } from '../observability/metrics';

/**
 * Queue consumers.
 *
 * Every handler is idempotent: it first claims the event id in
 * `processed_events`, so BullMQ's at-least-once delivery (and any manual
 * replay) produces exactly one effect.
 */
@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersService.name);
  private readonly connection: Redis;
  private readonly workers: Worker[] = [];
  private readonly storageDir: string;
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly db: DatabaseService,
    private readonly prescriptions: PrescriptionsService,
    private readonly admin: AdminService,
  ) {
    this.connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.storageDir = resolve(config.get<string>('STORAGE_DIR', './storage'));
    this.enabled = config.get<boolean>('RUN_WORKERS_IN_API', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('in-process workers disabled (RUN_WORKERS_IN_API=false)');
      return;
    }
    this.start();
  }

  /** Public so the standalone worker entrypoint can reuse it. */
  start(): void {
    this.workers.push(
      this.build(QUEUE_NOTIFICATIONS, (job) => this.handleNotification(job)),
      this.build(QUEUE_PDF, (job) => this.handlePdf(job)),
      this.build(QUEUE_ANALYTICS, () => this.admin.refreshMaterializedViews()),
    );
    this.logger.log(`started ${this.workers.length} queue workers`);
  }

  private build(name: string, handler: (job: Job) => Promise<unknown>): Worker {
    const worker = new Worker(
      name,
      async (job) => {
        const stop = metrics.queueJobDuration.startTimer({ queue: name });
        try {
          const result = await handler(job);
          metrics.queueJobs.inc({ queue: name, result: 'success' });
          return result;
        } catch (error) {
          metrics.queueJobs.inc({ queue: name, result: 'failure' });
          throw error;
        } finally {
          stop();
        }
      },
      { connection: this.connection, concurrency: 5 },
    );

    worker.on('failed', (job, err) => {
      const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
      this.logger[exhausted ? 'error' : 'warn'](
        { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
        exhausted ? 'job exhausted retries — moved to dead-letter' : 'job failed, will retry',
      );
    });

    return worker;
  }

  /**
   * Consumer-side dedupe. Returns false when this event was already handled.
   */
  private async claimEvent(eventId: string, consumer: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [`${consumer}:${eventId}`, consumer],
    );
    return res.rowCount === 1;
  }

  /** Email/SMS stub — writes a durable notification row instead of sending. */
  private async handleNotification(job: Job): Promise<void> {
    const { eventId, eventType, payload } = job.data as {
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    };
    if (!(await this.claimEvent(eventId, 'notifications'))) {
      this.logger.debug(`duplicate notification event ${eventId} ignored`);
      return;
    }

    // Domain events carry `doctorId` as a *doctors.id*, whereas notifications are
    // addressed to a *users.id*. Resolve the doctor's login account before
    // inserting, otherwise the FK to users(id) rejects the row.
    const recipients = new Set<string>();
    if (typeof payload.patientId === 'string') recipients.add(payload.patientId);
    if (typeof payload.doctorId === 'string') {
      const owner = await this.db.query<{ user_id: string }>(
        `SELECT user_id FROM doctors WHERE id = $1`,
        [payload.doctorId],
      );
      if (owner.rows[0]) recipients.add(owner.rows[0].user_id);
    }

    for (const userId of recipients) {
      await this.db.query(
        `INSERT INTO notifications (user_id, channel, template, payload, status, event_id, sent_at)
         VALUES ($1, 'email', $2, $3::jsonb, 'sent', $4, now())
         ON CONFLICT (event_id) DO NOTHING`,
        [userId, eventType, JSON.stringify(payload), `${eventId}:${userId}`],
      );
    }
    this.logger.log(`notification "${eventType}" delivered to ${recipients.size} recipient(s)`);
  }

  /** Render the signed prescription to a PDF on disk (S3 in production). */
  private async handlePdf(job: Job): Promise<void> {
    const { eventId, payload } = job.data as { eventId: string; payload: { prescriptionId: string } };
    const prescriptionId = payload.prescriptionId;
    if (!(await this.claimEvent(eventId, 'pdf'))) return;

    try {
      const details = await this.prescriptions.internalDetails(prescriptionId);
      await mkdir(this.storageDir, { recursive: true });
      const filePath = join(this.storageDir, `prescription-${prescriptionId}.pdf`);
      const buffer = await this.renderPdf(details);
      await writeFile(filePath, buffer);
      await this.prescriptions.attachPdf(prescriptionId, filePath);
      this.logger.log(`rendered prescription PDF ${prescriptionId}`);
    } catch (error) {
      await this.prescriptions.markPdfFailed(prescriptionId).catch(() => undefined);
      throw error;
    }
  }

  private renderPdf(details: {
    id: string;
    doctorName: string;
    registrationNo: string;
    patientName: string;
    scheduledAt?: Date;
    signedAt: Date | null;
    signature: string | null;
    diagnosis: string | null;
    advice: string | null;
    items: Array<{ drug: string; dosage: string; frequency: string; duration: string; instructions?: string }>;
  }): Promise<Buffer> {
    return new Promise((resolvePdf, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('Amrutam Telemedicine', { align: 'center' });
      doc.fontSize(12).text('Digital Prescription', { align: 'center' });
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Prescription ID : ${details.id}`);
      doc.text(`Doctor          : ${details.doctorName} (Reg. ${details.registrationNo})`);
      doc.text(`Patient         : ${details.patientName}`);
      if (details.scheduledAt) doc.text(`Consultation    : ${new Date(details.scheduledAt).toISOString()}`);
      if (details.signedAt) doc.text(`Signed at       : ${new Date(details.signedAt).toISOString()}`);
      doc.moveDown();

      if (details.diagnosis) {
        doc.fontSize(12).text('Diagnosis', { underline: true });
        doc.fontSize(10).text(details.diagnosis);
        doc.moveDown(0.5);
      }

      doc.fontSize(12).text('Medication', { underline: true });
      doc.fontSize(10);
      details.items.forEach((item, index) => {
        doc.text(
          `${index + 1}. ${item.drug} — ${item.dosage}, ${item.frequency}, for ${item.duration}` +
            (item.instructions ? ` (${item.instructions})` : ''),
        );
      });
      doc.moveDown(0.5);

      if (details.advice) {
        doc.fontSize(12).text('Advice', { underline: true });
        doc.fontSize(10).text(details.advice);
        doc.moveDown(0.5);
      }

      if (details.signature) {
        doc.moveDown();
        doc.fontSize(8).fillColor('#555');
        doc.text(`Digital signature (HMAC-SHA256): ${details.signature}`, { width: 500 });
        doc.text('Verify at GET /api/v1/prescriptions/{id}/verify');
      }

      doc.end();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close())).catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}
