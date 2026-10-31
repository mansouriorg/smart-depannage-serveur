import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  AppointmentStatus,
  ArtisanVerificationStatus,
  InterventionEventType,
  NotificationChannel,
  NotificationType,
  Role,
  Status,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { getBusinessTimeZone } from '../../config/env';
import { formatLocalDateTime } from '../../common/availability/weekly-schedule';
import { instantOf } from '../../common/locale/business-time';
import { canonicalStatus, LEGACY_STATUS_ALIASES } from '../intervention-workflow/intervention-status';
import { transitionStatusDetailed } from '../intervention-workflow/transition-status';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { describeError } from '../notifications/delivery/delivery-error';
import { RealtimeService } from '../realtime/realtime.service';
import { overlapAsConflict } from '../scheduling/appointment-overlap';

import {
  ACTIVE_APPOINTMENT_STATUSES,
  ACTIVE_JOB_STATUSES,
  MAX_APPOINTMENT_MS,
  artisanAvailabilityIssues,
  isCurrentVisit,
} from './artisan-availability';
import { closePendingRequests, detachAppointment } from './appointment-release';
import { replaceDefaultReminders } from './appointment-reminders';
import { lockArtisanCalendar, lockJob } from './artisan-lock';

/** A job already held by this artisan can only be re-scheduled before the artisan is on the road. */
const RESCHEDULABLE = ['ASSIGNED', 'ARTISAN_ACCEPTED'];

/** The same statuses in every spelling the database may hold (ACCEPTED is the old ARTISAN_ACCEPTED). */
const RESCHEDULABLE_SPELLINGS = [
  ...RESCHEDULABLE,
  ...Object.entries(LEGACY_STATUS_ALIASES)
    .filter(([, canonical]) => RESCHEDULABLE.includes(canonical))
    .map(([legacy]) => legacy),
];

export type AssignInput = {
  interventionId: number;
  artisanId: number;
  /** The staff member who decides. */
  actorId: number;
  /** The time of the visit, both or none. A job that already has an appointment keeps its time. */
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  adminNote?: string | null;
  /**
   * The status the job lands on: ASSIGNED (the default, what the admin route, the
   * matching and the scheduling always did) or ARTISAN_ACCEPTED (what the dashboard
   * dropdown always did, and what the deployed mobile app and the dashboard still
   * show as "affecté"). Nothing else: this is not a way to move a job anywhere.
   */
  status?: Status | string;
  /**
   * Who the screen showed as holding the job (null: nobody). If somebody else holds it by now, nothing is
   * written (409): two dispatchers choosing at the same time must not overwrite each other without knowing.
   * Left out, nothing is checked (the callers that never knew who held it). Giving the job to the one who
   * holds it already is not a conflict: it is the same wish twice.
   */
  expectedArtisanId?: number | null;
  /** What the caller wants back on the intervention. */
  include?: unknown;
};

export type AssignResult = {
  intervention: any;
  appointment: any | null;
  previousArtisanId: number | null;
  previousStatus: string;
};


function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** The largest id the database holds (a 32-bit integer): a bigger one is no job and no artisan. */
const MAX_ID = 2_147_483_647;
const isRowId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ID;

/** The time asked for: both ends or none, in order, and not longer than a day. */
export function parseAssignmentRange(
  startsAt: unknown,
  endsAt: unknown,
  timeZone: string = getBusinessTimeZone(),
): { startsAt: Date; endsAt: Date } | undefined {
  if (isBlank(startsAt) && isBlank(endsAt)) return undefined;

  if (isBlank(startsAt) || isBlank(endsAt)) {
    throw new BadRequestException('startsAt et endsAt doivent être fournis ensemble.');
  }

  const start = instantOf(startsAt, timeZone);
  const end = instantOf(endsAt, timeZone);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('Date ou horaire invalide.');
  }

  if (start >= end) {
    throw new BadRequestException('La date de fin doit être après la date de début.');
  }

  if (end.getTime() - start.getTime() > MAX_APPOINTMENT_MS) {
    throw new BadRequestException('Un rendez-vous ne peut pas durer plus de 24 heures.');
  }

  return { startsAt: start, endsAt: end };
}

/**
 * The one way an artisan is given a job (P1-05).
 *
 * The admin route, the matching, the scheduling and the general update of an
 * intervention each had their own copy, with their own checks: one looked at the
 * approval only, one at the availability only, the dropdown of the dashboard
 * (PATCH /interventions/:id, deleted in P3-03) at nothing. Now they all call this,
 * and a job is given to an artisan only when:
 *
 *  - the artisan exists, is active and APPROVED;
 *  - the job is in a status from which it may be assigned (the status table);
 *  - the artisan is free: for the time asked (or the time already booked for this
 *    job) the same rule as the matching, and always: accepting missions, below
 *    the maximum of active missions, available for an emergency if the job is one.
 *
 * The check and the writes (status, artisan, appointment) happen in ONE transaction
 * that holds a lock on the job and on the artisan, so two dispatchers cannot book
 * the same artisan for the same hour. The reminders, the timeline line, the
 * notifications and the live event come after, and a failure there is logged, never
 * undoes an assignment that was made.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly realtime: RealtimeService,
  ) {}

  async assign(input: AssignInput): Promise<AssignResult> {
    const { interventionId, artisanId, actorId } = input;
    const timeZone = getBusinessTimeZone();
    const asked = parseAssignmentRange(input.startsAt, input.endsAt, timeZone);

    // Before any query: a number the database cannot hold would be an error 500 from the
    // lock statement, not the "not found" it is.
    if (!isRowId(interventionId)) throw new NotFoundException('Intervention introuvable.');
    if (!isRowId(artisanId)) throw new NotFoundException('Artisan introuvable.');

    const asLanding = input.status === undefined ? 'ASSIGNED' : canonicalStatus(input.status);

    if (asLanding !== 'ASSIGNED' && asLanding !== 'ARTISAN_ACCEPTED') {
      throw new BadRequestException('Une mission confiée à un artisan est « assignée » ou « acceptée », pas autre chose.');
    }

    // The accepted landing is written the way the dashboard dropdown always wrote it
    // (ACCEPTED, the old spelling of ARTISAN_ACCEPTED): that is the word the deployed mobile
    // app and dashboard read as "affecté". It is the same status for the status table.
    const landing: Status = asLanding === 'ARTISAN_ACCEPTED' ? Status.ACCEPTED : Status.ASSIGNED;

    const done = await this.prisma.$transaction(async (tx: any) => {
      // The same two locks, always in this order: no two assignments can wait for each other.
      await lockJob(tx, interventionId);
      await lockArtisanCalendar(tx, artisanId);

      await this.assertArtisanCanBeAssigned(tx, artisanId);

      const job = await tx.intervention.findUnique({
        where: { id: interventionId },
        select: { id: true, status: true, clientId: true, artisanId: true, urgency: true },
      });

      if (!job) throw new NotFoundException('Intervention introuvable.');

      const existing = await tx.appointment.findUnique({ where: { interventionId } });
      // A visit that is over (the artisan did not come, the job is given to someone else
      // days later) is no time to check the new artisan against: only the profile counts.
      const existingIsCurrent = isCurrentVisit(existing);

      // The time that counts: the one asked for, else the one already booked for this job.
      const range =
        asked ?? (existingIsCurrent ? { startsAt: existing.startsAt as Date, endsAt: existing.endsAt as Date } : undefined);

      const status = canonicalStatus(job.status);
      const sameArtisan = job.artisanId === artisanId;

      if (input.expectedArtisanId !== undefined && !sameArtisan && job.artisanId !== input.expectedArtisanId) {
        throw new ConflictException(
          'La demande a été confiée à un autre technicien entre-temps. Rechargez la liste avant de recommencer.',
        );
      }

      if (sameArtisan && !RESCHEDULABLE.includes(String(status))) {
        throw new ConflictException(
          'Cette mission ne peut plus être assignée à cet artisan dans son état actuel (déjà en route, en cours, terminée ou annulée).',
        );
      }

      let row: any;
      let previousStatus = String(job.status);

      // The same artisan, the same hours again (a double click, a form sent twice): nothing
      // to move and nobody to tell, and a visit the artisan already confirmed stays confirmed.
      const sameVisitAgain =
        sameArtisan &&
        !!asked &&
        !!existing &&
        existing.artisanId === artisanId &&
        ACTIVE_APPOINTMENT_STATUSES.includes(existing.status) &&
        existing.startsAt instanceof Date &&
        existing.endsAt instanceof Date &&
        existing.startsAt.getTime() === asked.startsAt.getTime() &&
        existing.endsAt.getTime() === asked.endsAt.getTime();

      if (sameArtisan && (!asked || sameVisitAgain)) {
        // The artisan already has this job and nobody asked for another time: nothing to
        // do, and nothing to refuse (the profile may have changed since; the job did not).
        row = await tx.intervention.findUnique({ where: { id: interventionId }, include: input.include });

        // Only the note of the same visit changed: the note is written, and nothing else is
        // (the visit did not move, so nobody is told, no waiting request is closed, and the
        // status the visit has stays).
        const noteChanged = sameVisitAgain && input.adminNote !== undefined && input.adminNote !== existing.adminNote;
        const appointment = noteChanged
          ? await tx.appointment.update({ where: { interventionId }, data: { adminNote: input.adminNote } })
          : (existing ?? null);

        return {
          row,
          appointment,
          scheduled: false,
          previousStatus,
          previousArtisanId: job.artisanId as number | null,
          nothingChanged: true,
        };
      }

      if (sameArtisan) {
        // A new time for the artisan who has the job: the status they gave it stays. The
        // job is checked again and locked in one statement: the artisan can give the job
        // back (or the dispatcher take it) through a route that does not take our locks,
        // and the time must not be booked for an artisan who has just left the job.
        const stillTheirs = await tx.intervention.updateMany({
          where: { id: interventionId, artisanId, status: { in: RESCHEDULABLE_SPELLINGS } },
          data: { updatedAt: new Date() },
        });

        if (stillTheirs.count !== 1) {
          throw new ConflictException('La mission vient de changer: rechargez la page et recommencez.');
        }

        row = await tx.intervention.findUnique({ where: { id: interventionId }, include: input.include });
      } else {
        const moved = await transitionStatusDetailed(tx, {
          id: interventionId,
          to: landing,
          actor: { kind: 'staff', userId: actorId },
          data: { artisanId, assignedAt: new Date() },
          include: input.include,
        });

        row = moved.row;
        previousStatus = moved.previousStatus;
      }

      const [activeJobsCount, overlappingAppointments, overlappingTimeBlocks, profile] = await Promise.all([
        tx.intervention.count({
          where: { artisanId, status: { in: ACTIVE_JOB_STATUSES }, id: { not: interventionId } },
        }),
        range
          ? tx.appointment.count({
              where: {
                artisanId,
                interventionId: { not: interventionId },
                status: { in: ACTIVE_APPOINTMENT_STATUSES },
                startsAt: { lt: range.endsAt },
                endsAt: { gt: range.startsAt },
              },
            })
          : 0,
        range
          ? tx.artisanTimeBlock.count({
              where: { artisanId, startsAt: { lt: range.endsAt }, endsAt: { gt: range.startsAt } },
            })
          : 0,
        tx.artisanProfile.findUnique({ where: { userId: artisanId }, include: { availability: true } }),
      ]);

      const issues = artisanAvailabilityIssues({
        profile: {
          isAcceptingJobs: profile.isAcceptingJobs,
          emergencyAvailable: profile.emergencyAvailable,
          maxActiveJobs: profile.maxActiveJobs,
          availability: profile.availability ?? [],
        },
        activeJobsCount,
        overlappingAppointments,
        overlappingTimeBlocks,
        range,
        emergency: String(job.urgency) === 'EMERGENCY',
        timeZone,
        holdsTheJob: sameArtisan,
      });

      // Throwing undoes the status and the artisan written above: the job stays as it was.
      if (issues.length) {
        throw new BadRequestException({ message: 'Cet artisan n’est pas disponible.', issues });
      }

      let appointment: any = null;
      let scheduled = false;

      if (range) {
        appointment = await tx.appointment.upsert({
          where: { interventionId },
          update: {
            artisanId,
            startsAt: range.startsAt,
            endsAt: range.endsAt,
            scheduledById: actorId,
            ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
            status: AppointmentStatus.SCHEDULED,
            // The artisan confirmed the time that was planned before, not this one (P3-01).
            confirmedAt: null,
            timezone: timeZone,
          },
          create: {
            interventionId,
            clientId: job.clientId,
            artisanId,
            startsAt: range.startsAt,
            endsAt: range.endsAt,
            scheduledById: actorId,
            adminNote: input.adminNote ?? undefined,
            status: AppointmentStatus.SCHEDULED,
            timezone: timeZone,
          },
        });
        scheduled = true;
      } else if (existing && existing.artisanId !== null && existing.artisanId !== artisanId) {
        // The old appointment is not what the new artisan is given (it is over, or it was
        // cancelled): it must not stay in the name of the artisan who lost the job, and it
        // must not be put in the name of the new one, who never agreed to that time.
        // The requests about it are closed below, so the status must stop saying that one is open.
        appointment = await detachAppointment(tx, existing, 'Mission confiée à un autre artisan.');
      }

      // A request about the appointment (move it, cancel it) is a request about the visit as
      // it was. Once the visit is rewritten or taken away from its artisan, an approval would
      // act on a visit that no longer exists, so the open ones are closed here.
      if (existing && (scheduled || appointment)) {
        await closePendingRequests(tx, existing.id, {
          response: 'Demande classée: l’administration a modifié le rendez-vous ou changé d’artisan.',
          reviewedById: actorId,
        });
      }

      return {
        row,
        appointment,
        scheduled,
        previousStatus,
        previousArtisanId: job.artisanId as number | null,
        nothingChanged: false,
      };
    }).catch((error: unknown) => {
      // The check above looked at the artisan's calendar under the lock; the database refuses two visits at the same time whatever
      // was checked (P3-01). What it refuses is a conflict for the dispatcher (409), not an error 500, and nothing was written.
      throw overlapAsConflict(error);
    });

    if (!done.nothingChanged) {
      await this.afterAssignment({
        interventionId,
        artisanId,
        actorId,
        appointment: done.appointment,
        scheduled: done.scheduled,
        previousArtisanId: done.previousArtisanId,
        previousStatus: done.previousStatus,
        newStatus: String(done.row?.status ?? landing),
        timeZone,
      });
    }

    return {
      intervention: done.row,
      appointment: done.appointment,
      previousArtisanId: done.previousArtisanId,
      previousStatus: done.previousStatus,
    };
  }

  /** Exists, is an artisan, is active, and its application was approved. */
  private async assertArtisanCanBeAssigned(tx: any, artisanId: number) {
    const user = await tx.user.findUnique({ where: { id: artisanId } });

    if (!user || user.role !== Role.ARTISAN) {
      throw new NotFoundException('Artisan introuvable.');
    }

    const profile = await tx.artisanProfile.findUnique({ where: { userId: artisanId } });

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    if (!user.isActive || user.deletedAt) {
      throw new BadRequestException('Ce compte artisan est désactivé.');
    }

    if (profile.verificationStatus !== ArtisanVerificationStatus.APPROVED) {
      throw new BadRequestException('Cet artisan n’est pas encore approuvé.');
    }
  }

  /**
   * Everything that follows a made assignment. Each step alone: a mail server that
   * is down must not turn a job that WAS assigned into an error the dispatcher
   * answers by assigning it again.
   */
  private async afterAssignment(params: {
    interventionId: number;
    artisanId: number;
    actorId: number;
    appointment: any | null;
    /** True when this assignment wrote the time of the visit; false for an old appointment only detached. */
    scheduled: boolean;
    previousArtisanId: number | null;
    previousStatus: string;
    newStatus: string;
    timeZone: string;
  }) {
    const { interventionId, artisanId, actorId, appointment, scheduled, previousArtisanId, timeZone } = params;
    const changedHands = previousArtisanId !== null && previousArtisanId !== artisanId;
    const rescheduled = previousArtisanId === artisanId;
    const when =
      scheduled && appointment?.startsAt instanceof Date ? formatLocalDateTime(appointment.startsAt, timeZone) : null;

    await this.attempt('reminders', async () => {
      // The reminders are replaced in one transaction, under the lock of the job (P3-01): a crash between the delete and the create
      // would leave the visit with none, and a cancellation in between would not see the new ones. They follow the visit as it is under
      // the lock, not as this assignment left it: a cancellation, or a later assignment that finished first, has changed it since, and
      // reminders made from the old picture would be for a visit that is gone or for somebody who no longer has it. A visit has
      // reminders when it is active, has an artisan and has a time; otherwise it has none (that also drops the ones the artisan who
      // lost the job was still to receive).
      if (appointment) {
        await this.prisma.$transaction(async (tx) => {
          await lockJob(tx, interventionId);

          const current = await tx.appointment.findUnique({ where: { id: appointment.id } });

          if (!current) return;

          const holdsAnHour =
            (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(current.status)) &&
            current.artisanId !== null &&
            current.artisanId !== undefined &&
            Boolean(current.startsAt);

          await replaceDefaultReminders(tx as any, holdsAnHour ? current : { ...current, startsAt: null });
        });
      }
    });

    await this.attempt('timeline', () =>
      this.events.create({
        interventionId,
        type: InterventionEventType.ARTISAN_ASSIGNED,
        title: rescheduled ? 'Rendez-vous modifié' : changedHands ? 'Artisan changé' : 'Artisan assigné',
        message: rescheduled
          ? `Rendez-vous fixé par l’administration${when ? ` le ${when}` : ''}.`
          : `Artisan assigné par l’administration${when ? ` (rendez-vous le ${when})` : ''}.`,
        createdById: actorId,
        metadata: {
          artisanId,
          previousArtisanId,
          startsAt: scheduled && appointment?.startsAt instanceof Date ? appointment.startsAt.toISOString() : null,
          endsAt: scheduled && appointment?.endsAt instanceof Date ? appointment.endsAt.toISOString() : null,
        },
      }),
    );

    await this.attempt('notification', async () => {
      if (!rescheduled) {
        await this.notifications.notifyArtisanAssigned(
          interventionId,
          artisanId,
          actorId,
          when ? { when } : undefined,
        );
        return;
      }

      // The same artisan, another time: both are told the new time, not "assigned" again.
      const job = await (this.prisma as any).intervention.findUnique({
        where: { id: interventionId },
        select: { clientId: true },
      });

      for (const recipientId of [artisanId, job?.clientId].filter((id): id is number => typeof id === 'number')) {
        await this.notifications.notify({
          recipientId,
          actorId,
          type: NotificationType.GENERAL,
          title: 'Rendez-vous modifié',
          message: `Le rendez-vous de l’intervention #${interventionId} est fixé${when ? ` le ${when}` : ''}.`,
          channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
          entityType: 'INTERVENTION',
          entityId: interventionId,
        });
      }
    });

    if (changedHands) {
      await this.attempt('notification of the previous artisan', async () => {
        await this.notifications.notify({
          recipientId: previousArtisanId as number,
          actorId,
          type: NotificationType.GENERAL,
          title: 'Mission retirée',
          message: `La mission #${interventionId} a été confiée à un autre artisan.`,
          channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
          entityType: 'INTERVENTION',
          entityId: interventionId,
        });
      });
    }

    // The artisan who lost the job stops receiving what is said about it. Before the live event,
    // so the next one does not reach them.
    if (changedHands) {
      await this.attempt('removal of the previous artisan from the live room', async () => {
        this.realtime.removeFromJobRoom(previousArtisanId as number, interventionId);
      });
    }

    // The live event says what happened: the status the job really has now, and only when
    // the status or the artisan changed (a new time for the same artisan is in the notification).
    if (changedHands || canonicalStatus(params.previousStatus) !== canonicalStatus(params.newStatus)) {
      await this.attempt('live event', () =>
        this.realtime.emitStatusChange({
          interventionId,
          oldStatus: params.previousStatus,
          newStatus: params.newStatus,
          actorId,
        }),
      );
    }
  }

  private async attempt(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      // Kind of error only: the details may hold a phone number or an address.
      this.logger.error(`After an assignment, the ${what} failed (${describeError(error)}).`);
    }
  }
}
