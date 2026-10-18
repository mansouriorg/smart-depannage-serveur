import { offsetPaginated } from '../../common/api-contract/envelope';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  FileAssetPurpose,
  InterventionEventType,
  ProofKind,
  ProofSource,
  ProofStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { Semaphore } from '../../common/concurrency/limits';
import { isTicketStaff } from '../../common/auth/role-policy';
import { lockJob } from '../assignment/artisan-lock';
import { FilesService, StoredLocalFile } from '../files/files.service';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { canonicalStatus, checkTransition } from '../intervention-workflow/intervention-status';
import { transitionStatusDetailed } from '../intervention-workflow/transition-status';
import { describeError } from '../notifications/delivery/delivery-error';
import { NotificationsService } from '../notifications/notifications.service';
import { fingerprintImage, findSimilar, BLANK_DETAIL, Fingerprint } from './image-fingerprint';
import { RawCapture, readCapture } from './proof-input';
import {
  Assessment,
  assessCapture,
  getProofPolicy,
  isRefusal,
  isUsablePosition,
  refusalMessage,
  staffReasonText,
} from './proof-policy';

export type ProofActor = { id: number; role: Role };

export type SubmitProofInput = {
  interventionId: number;
  kind: ProofKind;
  actor: ProofActor;
  file: Express.Multer.File | undefined;
  /** What the phone says (an artisan); the back office sends no position. */
  capture?: RawCapture | null;
  /** complete-work: the same transaction closes the job with this photo as the "after" proof. */
  completeJob?: boolean;
  /** What the caller wants back on the intervention. */
  include?: unknown;
};

/** What an artisan is told about the photo: no distance, no limit, no reason of the review. */
export type ProofView = {
  id: number;
  kind: ProofKind;
  status: ProofStatus;
  message: string;
  photoUrl: string | null;
  receivedAt: Date;
};

export type SubmitProofResult = {
  proof: any;
  view: ProofView;
  intervention: any;
  /** This call closed the job. */
  completed: boolean;
  /** The same photo had already been sent by the same person for the same job: nothing was written. */
  replay: boolean;
};

/** An artisan takes the proof photos on site: once arrived, and until the work is closed. */
const PHOTO_STATUSES = ['ARTISAN_ARRIVED', 'IN_PROGRESS'] as const;

/** How long back a new photo is compared with the ones kept (days), and how many are compared. */
const SIMILARITY_DAYS = 180;
const SIMILARITY_CANDIDATES = 3000;

/** One person, one job: more attempts than this in an hour is somebody trying values until one passes. */
const MAX_ATTEMPTS_PER_HOUR = 30;

const MAX_ROW_ID = 2_147_483_647;

const isRowId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ROW_ID;

const PURPOSE: Record<ProofKind, FileAssetPurpose> = {
  BEFORE: FileAssetPurpose.ARTISAN_BEFORE_PHOTO,
  AFTER: FileAssetPurpose.ARTISAN_AFTER_PHOTO,
};

const kindWord = (kind: ProofKind) => (kind === 'BEFORE' ? 'avant' : 'après');

@Injectable()
export class ProofsService {
  private readonly logger = new Logger(ProofsService.name);

  /** Decoding a photo takes a second and a few hundred MB: two at a time, whatever the number of calls. */
  private readonly decodeSlots = new Semaphore(2);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly events: InterventionEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The clock of the server: the only time that counts (a test moves it here). */
  protected now(): Date {
    return new Date();
  }

  // ==========================================================
  // Taking a proof
  // ==========================================================

  /**
   * The one way a before/after photo gets onto a job. The photo is judged on what the server
   * knows (proof-policy.ts); a refused photo is recorded without the picture and answered with
   * a 400 that says what to do; a kept photo is stored privately, recorded, and copied onto the
   * intervention in one transaction (with the closing of the job when `completeJob`).
   */
  async submit(input: SubmitProofInput): Promise<SubmitProofResult> {
    const { interventionId, kind, actor } = input;
    const isArtisan = actor.role === Role.ARTISAN;

    if (!isArtisan && !isTicketStaff(actor.role)) {
      throw new ForbiddenException('Seuls les artisans et l’administration peuvent ajouter une preuve.');
    }

    if (kind !== 'BEFORE' && kind !== 'AFTER') {
      throw new BadRequestException('Le type de preuve doit être « avant » ou « après ».');
    }

    if (input.completeJob && !isArtisan) {
      throw new ForbiddenException('Seul l’artisan de la mission peut la terminer avec une photo.');
    }

    if (input.completeJob && kind !== 'AFTER') {
      throw new BadRequestException('Seule la photo « après » termine une intervention.');
    }

    if (!isRowId(interventionId)) {
      throw new NotFoundException('Intervention introuvable.');
    }

    // The clock starts here: it is the time of the proof, whatever the decoding takes.
    const receivedAt = this.now();

    this.files.assertProofImage(input.file);

    const file = input.file as Express.Multer.File;
    const job = await this.loadJob(interventionId);

    this.assertMayAdd(job, input, isArtisan);

    const attempts = await this.prisma.proofCapture.count({
      where: {
        interventionId,
        submittedById: actor.id,
        receivedAt: { gte: new Date(receivedAt.getTime() - 3600_000) },
      },
    });

    if (attempts >= MAX_ATTEMPTS_PER_HOUR) {
      throw new HttpException(
        'Trop de tentatives pour cette intervention. Réessayez dans une heure ou contactez le support.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const print = await this.fingerprint(file);
    const source: ProofSource = isArtisan ? 'ARTISAN' : 'STAFF';

    // The same photo, sent again by the same person for the same job (a reply that got lost on
    // the way back): the answer is the first one, not a refusal.
    const known = await this.prisma.proofCapture.findUnique({ where: { sha256: print.sha256 } });

    // (Closing a job is never a replay: a job that is closed already was refused above, and one
    // that is still open needs a photo that was not used yet.)
    if (!input.completeJob && this.isOwnEarlierSend(known, input)) {
      return this.replayOf(known, input);
    }

    const policy = getProofPolicy();
    const read = isArtisan ? readCapture(input.capture) : null;
    let assessment: Assessment;

    if (read) {
      const similar = await this.similarProof(print.dhash, interventionId, receivedAt, policy.similarityBits);
      const jobPosition = this.jobPosition(job);

      assessment = assessCapture(
        {
          latitude: read.latitude ?? NaN,
          longitude: read.longitude ?? NaN,
          accuracyM: read.accuracyM,
          mocked: read.mocked,
          clientCapturedAt: read.clientCapturedAt,
          receivedAt,
          job: jobPosition,
          picture: {
            alreadyUsed: !!known,
            similarTo: similar,
            blank: print.detail < BLANK_DETAIL,
          },
        },
        policy,
      );
    } else {
      // The back office sends no position: only the reuse of a photo is checked.
      assessment = {
        verdict: known ? 'REJECTED' : 'ACCEPTED',
        reasons: known ? ['PHOTO_ALREADY_USED'] : [],
        distanceM: null,
        effectiveDistanceM: null,
        clockOffsetSeconds: null,
      };
    }

    const base = {
      interventionId,
      kind,
      source,
      submittedById: actor.id,
      reasons: assessment.reasons,
      latitude: read?.latitude ?? null,
      longitude: read?.longitude ?? null,
      accuracyM: read?.accuracyM ?? null,
      mocked: read?.mocked ?? null,
      clientCapturedAt: read?.clientCapturedAt ?? null,
      distanceM: assessment.distanceM,
      clockOffsetSeconds: assessment.clockOffsetSeconds,
      receivedAt,
    };

    if (assessment.verdict === 'REJECTED') {
      // Kept for the audit, without the picture and without its fingerprint (a refused photo
      // does not block the same bytes later, and does not count as "already used").
      await this.prisma.proofCapture.create({
        data: { ...base, status: 'REJECTED', fileAssetId: null, photoUrl: null, sha256: null, dhash: null, detail: null },
      });

      // Our own codes only (never a position, a name or a photo address).
      const what = kindWord(kind);
      const reason = assessment.reasons.filter(isRefusal).join(', ');

      this.logger.warn(`Proof ${what} refused for intervention #${interventionId} (${reason}).`);

      throw this.refusal(assessment);
    }

    return this.keep({ input, job, print, assessment, base, file, receivedAt });
  }

  // ----------------------------------------------------------

  private async loadJob(interventionId: number) {
    const job = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      select: {
        id: true,
        status: true,
        clientId: true,
        artisanId: true,
        latitude: true,
        longitude: true,
        savedAddress: { select: { latitude: true, longitude: true } },
      },
    });

    if (!job) {
      throw new NotFoundException(`Intervention #${interventionId} introuvable.`);
    }

    return job;
  }

  /** Where the job is: its own coordinates, or those of the saved address it was made from. */
  private jobPosition(job: { latitude?: number | null; longitude?: number | null; savedAddress?: any }) {
    // A (0, 0) or out-of-range position is what an app writes when it had no fix: not a place.
    if (isUsablePosition(job.latitude, job.longitude)) {
      return { latitude: job.latitude as number, longitude: job.longitude as number };
    }

    const saved = job.savedAddress;

    return {
      latitude: saved?.latitude ?? null,
      longitude: saved?.longitude ?? null,
    };
  }

  /** Who may add a proof to this job, and in which status. */
  private assertMayAdd(job: { artisanId: number | null; status: unknown }, input: SubmitProofInput, isArtisan: boolean) {
    if (!isArtisan) return;

    if (job.artisanId !== input.actor.id) {
      throw new NotFoundException(`Intervention #${input.interventionId} introuvable.`);
    }

    if (input.completeJob) {
      // The status table decides, in the transaction too; this is the fast answer before the
      // photo is decoded.
      const verdict = checkTransition(String(job.status), Status.COMPLETED, 'artisan');

      if (verdict.ok === false) {
        throw verdict.reason === 'wrong_actor'
          ? new ForbiddenException(verdict.message)
          : new ConflictException(verdict.message);
      }

      if (verdict.same) throw new ConflictException('Cette mission est déjà clôturée.');

      return;
    }

    const current = canonicalStatus(String(job.status));

    if (!current || !(PHOTO_STATUSES as readonly string[]).includes(current)) {
      throw new ConflictException(
        'La photo de preuve se prend sur place: indiquez d’abord que vous êtes arrivé, et avant la fin de la mission.',
      );
    }
  }

  private async fingerprint(file: Express.Multer.File): Promise<Fingerprint> {
    return this.decodeSlots.run(async () => {
      try {
        return await fingerprintImage(file.buffer);
      } catch {
        // A damaged picture, or one with more pixels than allowed: a refusal, not a server error.
        throw new BadRequestException('Image illisible, corrompue ou trop grande.');
      }
    });
  }

  /** The earlier proof (of another job) this picture looks like, if any. */
  private async similarProof(dhash: string, interventionId: number, now: Date, maxBits: number): Promise<number | null> {
    // Only photos that were kept have a fingerprint (a refused capture has none), a photo the back
    // office refused afterwards included: a new photo that looks like a fake one is the more suspect.
    const candidates = await this.prisma.proofCapture.findMany({
      where: {
        dhash: { not: null },
        interventionId: { not: interventionId },
        receivedAt: { gte: new Date(now.getTime() - SIMILARITY_DAYS * 24 * 3600_000) },
      },
      select: { id: true, dhash: true },
      orderBy: { id: 'desc' },
      take: SIMILARITY_CANDIDATES,
    });

    return findSimilar(dhash, candidates, maxBits)?.id ?? null;
  }

  /** The same photo, sent again by the same person for the same job: a reply that got lost. */
  private isOwnEarlierSend(known: any, input: SubmitProofInput): boolean {
    return (
      !!known &&
      known.status !== 'REJECTED' &&
      known.interventionId === input.interventionId &&
      known.kind === input.kind &&
      known.submittedById === input.actor.id
    );
  }

  private async replayOf(known: any, input: SubmitProofInput): Promise<SubmitProofResult> {
    return {
      proof: known,
      view: this.viewFor(known),
      intervention: await this.prisma.intervention.findUnique({
        where: { id: input.interventionId },
        ...(input.include ? { include: input.include as any } : {}),
      }),
      completed: false,
      replay: true,
    };
  }

  private refusal(assessment: Assessment) {
    return new BadRequestException({
      statusCode: 400,
      message: refusalMessage(assessment),
      error: 'Bad Request',
      code: 'PROOF_REJECTED',
      reasons: assessment.reasons.filter(isRefusal),
    });
  }

  // ----------------------------------------------------------
  // Keeping the photo
  // ----------------------------------------------------------

  private async keep(params: {
    input: SubmitProofInput;
    job: { id: number; artisanId: number | null };
    print: Fingerprint;
    assessment: Assessment;
    base: Record<string, any>;
    file: Express.Multer.File;
    receivedAt: Date;
  }): Promise<SubmitProofResult> {
    const { input, print, assessment, base, file, receivedAt } = params;
    const { interventionId, kind, actor } = input;
    const purpose = PURPOSE[kind];
    const source: ProofSource = base.source;

    let staged: StoredLocalFile | null = null;

    try {
      // The compressed copy goes to the private folder first (no database row yet, nothing to
      // undo but the file); the rows are written together afterwards.
      staged = await this.decodeSlots.run(() => this.files.stageProofPhoto(file, purpose, interventionId));

      const written = await this.prisma.$transaction(async (tx) => {
        await lockJob(tx, interventionId);

        // The job may have changed hands, or moved on, while the photo was being read.
        const current = await tx.intervention.findUnique({
          where: { id: interventionId },
          select: { status: true, artisanId: true, beforePhotoUrl: true, afterPhotoUrl: true },
        });

        if (!current) throw new NotFoundException(`Intervention #${interventionId} introuvable.`);

        this.assertMayAdd(current, input, actor.role === Role.ARTISAN);

        const asset = await this.files.recordProofAsset(tx, actor, file, staged as StoredLocalFile, purpose, interventionId);
        const photoUrl = `/api/files/${asset.id}/download`;

        const proof = await tx.proofCapture.create({
          data: {
            ...base,
            status: assessment.verdict,
            fileAssetId: asset.id,
            photoUrl,
            sha256: print.sha256,
            dhash: print.dhash,
            detail: print.detail,
          },
        });

        const lat = base.latitude;
        const lng = base.longitude;
        const include = input.include ? { include: input.include as any } : {};

        if (input.completeJob) {
          // Proof of work closes a job that is in progress (the status table refuses every other
          // status). The proof is written together with the status and never replaced afterwards.
          const moved = await transitionStatusDetailed(tx, {
            id: interventionId,
            to: Status.COMPLETED,
            actor: { kind: 'artisan', userId: actor.id },
            dataOnChange: {
              workCompletedAt: receivedAt,
              afterPhotoUrl: photoUrl,
              afterPhotoLat: lat,
              afterPhotoLng: lng,
              afterPhotoAt: receivedAt,
            },
            ...include,
          });

          if (!moved.changed) throw new ConflictException('Cette mission est déjà clôturée.');

          return { proof, intervention: moved.row, completed: true };
        }

        // A photo added by the back office never replaces the one that is on the job: it is kept
        // beside it (the dashboard lists it), so the evidence of what the artisan sent stays.
        const column = kind === 'BEFORE' ? 'beforePhotoUrl' : 'afterPhotoUrl';

        if (source === 'STAFF' && current[column]) {
          return {
            proof,
            intervention: await tx.intervention.findUnique({ where: { id: interventionId }, ...include }),
            completed: false,
          };
        }

        const intervention =
          kind === 'BEFORE'
            ? await tx.intervention.update({
                where: { id: interventionId },
                data: { beforePhotoUrl: photoUrl, beforePhotoLat: lat, beforePhotoLng: lng, beforePhotoAt: receivedAt },
                ...include,
              })
            : await tx.intervention.update({
                where: { id: interventionId },
                data: { afterPhotoUrl: photoUrl, afterPhotoLat: lat, afterPhotoLng: lng, afterPhotoAt: receivedAt },
                ...include,
              });

        return { proof, intervention, completed: false };
      });

      await this.afterKept(written.proof, assessment, input);

      return {
        proof: written.proof,
        view: this.viewFor(written.proof),
        intervention: written.intervention,
        completed: written.completed,
        replay: false,
      };
    } catch (error) {
      if (staged) await this.files.discardStagedPhoto(staged).catch(() => undefined);

      // Two requests with the same photo at the same moment: the database lets one in.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        // ...and when the winner is the same person sending the same photo for the same job (a
        // double tap), the second request gets the winner's answer, not a refusal of its own photo.
        // (Closing the job is not a replay: two closings are serialized by the lock of the job, and
        // the second one is told the job is closed before it gets here.)
        const winner = input.completeJob
          ? null
          : await this.prisma.proofCapture.findUnique({ where: { sha256: print.sha256 } }).catch(() => null);

        if (this.isOwnEarlierSend(winner, input)) {
          return this.replayOf(winner, input);
        }

        throw this.refusal({
          verdict: 'REJECTED',
          reasons: ['PHOTO_ALREADY_USED'],
          distanceM: null,
          effectiveDistanceM: null,
          clockOffsetSeconds: null,
        });
      }

      throw error;
    }
  }

  /** The timeline and the back office, each on its own: a failure here never undoes a kept proof. */
  private async afterKept(proof: any, assessment: Assessment, input: SubmitProofInput) {
    const { interventionId, kind, actor } = input;

    await this.attempt('timeline', () =>
      this.events.create({
        interventionId,
        type: kind === 'BEFORE' ? InterventionEventType.BEFORE_PHOTO_UPLOADED : InterventionEventType.AFTER_PHOTO_UPLOADED,
        title: `Photo ${kindWord(kind)} intervention ajoutée`,
        message: `Une preuve photo ${kindWord(kind)} intervention a été enregistrée.`,
        createdById: actor.id,
        metadata: { proofId: proof.id },
      }),
    );

    if (assessment.verdict === 'NEEDS_REVIEW') {
      await this.attempt('review notification', () =>
        this.notifications.notifyProofNeedsReview({
          interventionId,
          proofId: proof.id,
          kind,
          artisanId: actor.id,
          details: this.reasonLabels(proof),
        }),
      );
    }
  }

  private async attempt(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      // Kind of error only: the details may hold a phone number or an address.
      this.logger.error(`After a proof, the ${what} failed (${describeError(error)}).`);
    }
  }

  // ==========================================================
  // Words
  // ==========================================================

  /** What the artisan is told. */
  private viewFor(proof: any): ProofView {
    const status: ProofStatus = proof.status;
    const message =
      status === 'NEEDS_REVIEW'
        ? 'Photo enregistrée. L’équipe la vérifiera, vous pouvez continuer.'
        : 'Photo enregistrée.';

    return {
      id: proof.id,
      kind: proof.kind,
      status,
      message,
      photoUrl: proof.photoUrl ?? null,
      receivedAt: proof.receivedAt,
    };
  }

  /** What the back office reads: one sentence per reason. */
  reasonLabels(proof: {
    reasons?: string[] | null;
    distanceM?: number | null;
    accuracyM?: number | null;
    clockOffsetSeconds?: number | null;
  }): string[] {
    return (proof.reasons ?? []).map((reason) =>
      staffReasonText(reason, {
        distanceM: proof.distanceM,
        accuracyM: proof.accuracyM,
        clockOffsetSeconds: proof.clockOffsetSeconds,
      }),
    );
  }

  // ==========================================================
  // The back office: what is waiting, what was decided
  // ==========================================================

  async list(query: {
    status?: string;
    interventionId?: number;
    kind?: string;
    take?: number;
    skip?: number;
  }) {
    const take = Math.min(Math.max(Math.trunc(query.take ?? 50), 1), 200);
    const skip = Math.max(Math.trunc(query.skip ?? 0), 0);
    const where: Record<string, unknown> = {};

    if (query.status) {
      if (!['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED'].includes(query.status)) {
        throw new BadRequestException('Statut de preuve inconnu.');
      }

      where.status = query.status;
    }

    if (query.kind) {
      if (query.kind !== 'BEFORE' && query.kind !== 'AFTER') {
        throw new BadRequestException('Type de preuve inconnu.');
      }

      where.kind = query.kind;
    }

    if (query.interventionId !== undefined) {
      if (!isRowId(query.interventionId)) throw new BadRequestException('Intervention invalide.');

      where.interventionId = query.interventionId;
    }

    const [rows, total] = await Promise.all([
      this.prisma.proofCapture.findMany({
        where,
        // The oldest waiting first when the queue is what is asked for; the newest first otherwise.
        orderBy: { id: query.status === 'NEEDS_REVIEW' ? 'asc' : 'desc' },
        take,
        skip,
      }),
      this.prisma.proofCapture.count({ where }),
    ]);

    const ids = [...new Set(rows.map((row: any) => row.interventionId as number))];
    const jobs = ids.length
      ? await this.prisma.intervention.findMany({
          where: { id: { in: ids } },
          select: { id: true, address: true, status: true, serviceType: true },
        })
      : [];
    const byId = new Map<number, any>(jobs.map((job: any) => [job.id, job]));

    return offsetPaginated(
      rows.map((row: any) => this.staffView(row, byId.get(row.interventionId) ?? null)),
      take,
      skip,
      total,
    );
  }

  private staffView(row: any, job: any) {
    return {
      id: row.id,
      interventionId: row.interventionId,
      kind: row.kind,
      source: row.source,
      status: row.status,
      reasons: row.reasons ?? [],
      reasonLabels: this.reasonLabels(row),
      photoUrl: row.photoUrl ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      accuracyM: row.accuracyM ?? null,
      mocked: row.mocked ?? null,
      distanceM: row.distanceM ?? null,
      clientCapturedAt: row.clientCapturedAt ?? null,
      clockOffsetSeconds: row.clockOffsetSeconds ?? null,
      receivedAt: row.receivedAt,
      submittedById: row.submittedById ?? null,
      reviewedById: row.reviewedById ?? null,
      reviewedAt: row.reviewedAt ?? null,
      reviewNote: row.reviewNote ?? null,
      createdAt: row.createdAt,
      intervention: job
        ? { id: job.id, address: job.address, status: job.status, serviceType: job.serviceType }
        : null,
    };
  }

  /**
   * A person of the back office looks at a kept photo. Approving makes it a proof for good;
   * refusing marks it refused and, while the job is still open, takes it off the job so the
   * artisan has to take it again (and is told). The decision is made once: two people pressing
   * at the same time, the second is told it has been decided.
   */
  async review(params: {
    proofId: number;
    decision: 'APPROVE' | 'REJECT';
    note?: string | null;
    reviewer: ProofActor;
  }) {
    const { proofId, decision, reviewer } = params;

    if (!isTicketStaff(reviewer.role)) {
      throw new ForbiddenException('Seule l’administration peut vérifier une preuve.');
    }

    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new BadRequestException('La décision doit être « APPROVE » ou « REJECT ».');
    }

    if (!isRowId(proofId)) throw new NotFoundException('Preuve introuvable.');

    const note = String(params.note ?? '').trim().slice(0, 500) || null;
    const proof = await this.prisma.proofCapture.findUnique({ where: { id: proofId } });

    if (!proof) throw new NotFoundException('Preuve introuvable.');

    if (proof.status !== 'NEEDS_REVIEW') {
      throw new ConflictException('Cette preuve a déjà été traitée.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, proof.interventionId);

      // The decision is made once: the row must still be waiting at the moment of the UPDATE.
      const changed = await tx.proofCapture.updateMany({
        where: { id: proofId, status: 'NEEDS_REVIEW' },
        data: {
          status: decision === 'APPROVE' ? 'ACCEPTED' : 'REJECTED',
          reviewedById: reviewer.id,
          reviewedAt: this.now(),
          reviewNote: note,
        },
      });

      if (changed.count !== 1) throw new ConflictException('Cette preuve a déjà été traitée.');

      let withdrawn = false;

      if (decision === 'REJECT') {
        withdrawn = await this.withdraw(tx, proof);
      }

      return { withdrawn, row: await tx.proofCapture.findUnique({ where: { id: proofId } }) };
    });

    if (decision === 'REJECT' && proof.submittedById && proof.source === 'ARTISAN') {
      await this.attempt('refusal notification', () =>
        this.notifications.notifyProofRefused({
          interventionId: proof.interventionId,
          proofId,
          kind: proof.kind,
          artisanId: proof.submittedById as number,
          actorId: reviewer.id,
          retake: result.withdrawn,
        }),
      );
    }

    return { ...this.staffView(result.row, null), withdrawn: result.withdrawn };
  }

  /**
   * A refused proof stops being the photo of the job — unless the job is already closed, where
   * the columns stay as the evidence of what was sent. The columns go back to the latest proof
   * of the same kind that is still kept, or to nothing.
   */
  private async withdraw(tx: any, proof: any): Promise<boolean> {
    const job = await tx.intervention.findUnique({
      where: { id: proof.interventionId },
      select: { status: true, beforePhotoUrl: true, afterPhotoUrl: true },
    });

    if (!job) return false;

    // Only a job on which the artisan can still take the photo again (arrived, in progress).
    // Closed, paid, disputed, cancelled...: the columns stay as the evidence of what was sent.
    const open = (PHOTO_STATUSES as readonly string[]).includes(String(canonicalStatus(String(job.status))));
    const column = proof.kind === 'BEFORE' ? 'beforePhotoUrl' : 'afterPhotoUrl';

    if (!open || job[column] !== proof.photoUrl) return false;

    const earlier = await tx.proofCapture.findMany({
      where: {
        interventionId: proof.interventionId,
        kind: proof.kind,
        status: { in: ['ACCEPTED', 'NEEDS_REVIEW'] },
        id: { not: proof.id },
      },
      orderBy: { id: 'desc' },
      take: 1,
    });
    const back = earlier[0] ?? null;

    if (proof.kind === 'BEFORE') {
      await tx.intervention.update({
        where: { id: proof.interventionId },
        data: {
          beforePhotoUrl: back?.photoUrl ?? null,
          beforePhotoLat: back?.latitude ?? null,
          beforePhotoLng: back?.longitude ?? null,
          beforePhotoAt: back?.receivedAt ?? null,
        },
      });
    } else {
      await tx.intervention.update({
        where: { id: proof.interventionId },
        data: {
          afterPhotoUrl: back?.photoUrl ?? null,
          afterPhotoLat: back?.latitude ?? null,
          afterPhotoLng: back?.longitude ?? null,
          afterPhotoAt: back?.receivedAt ?? null,
        },
      });
    }

    return true;
  }
}
