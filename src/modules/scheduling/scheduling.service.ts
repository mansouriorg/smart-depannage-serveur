import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { getBusinessTimeZone } from '../../config/env';
import { checkWeeklySchedule } from '../../common/availability/weekly-schedule';
import { businessDayWindow, instantOf } from '../../common/locale/business-time';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { canonicalStatus, STATUS_GROUPS } from '../intervention-workflow/intervention-status';
import { AssignmentService } from '../assignment/assignment.service';
import { MissionActionsService } from '../mission-actions/mission-actions.service';
import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';
import { lockArtisanCalendar, lockJob } from '../assignment/artisan-lock';
import { VISIT_ENDED } from '../assignment/appointment-release';
import {
  WORK_DONE_STATUSES,
  reminderChannels,
  reminderDueAt,
  reminderMessage,
  reminderSkipReason,
  replaceDefaultReminders,
} from '../assignment/appointment-reminders';
import { appointmentForParties, appointmentRequestForParties } from '../../common/views/views';
import { isTicketStaff } from '../../common/auth/role-policy';
import { moneyDueOnCancelledJob } from '../payments/financials-ops';
import { compareMoney, formatMoney } from '../../common/money/money';

import { overlapAsConflict } from './appointment-overlap';
import { baseStatusOf, STEADY_STATUSES, visitStatusFor, WAITING_STATUSES } from './appointment-requests';

import {
  AppointmentReminderStatus,
  AppointmentRequestStatus,
  AppointmentRequestType,
  AppointmentStatus,
  ArtisanTimeBlockType,
  InterventionEventType,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  Role,
  Status,
} from '../../../generated/prisma/client';

import {
  CancelAppointmentRequestDto,
  CreateTimeBlockDto,
  PreferredTimeDto,
  RescheduleRequestDto,
  ReviewAppointmentRequestDto,
  ScheduleInterventionDto,
  UpdateAvailabilitySlotDto,
} from './dto/scheduling.dto';

/** From these statuses on, the artisan has accepted the job: a staff acceptance of the visit confirms the visit and leaves the job alone. */
const ACCEPTED_OR_LATER: readonly string[] = [
  'ARTISAN_ACCEPTED',
  'ARTISAN_ON_THE_WAY',
  'ARTISAN_ARRIVED',
  'IN_PROGRESS',
  'WAITING_CLIENT_VALIDATION',
];

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,

    @Optional()
    private readonly notifications?: NotificationsService,

    @Optional()
    private readonly realtime?: RealtimeService,

    // What an artisan does with a mission (P1-06). Optional only so that a spec can build the
    // service without it; the module always provides it.
    @Optional()
    private readonly missionActions?: MissionActionsService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  /**
   * The staff who work on jobs: scheduling a visit, answering a request to move or cancel it, accepting for an
   * artisan all move a job's status, which is theirs alone (P1-17). The accountant is of the back office but has no
   * business here: the dashboard offers no scheduling page to that role.
   */
  private isStaff(role: Role): boolean {
    return isTicketStaff(role);
  }

  /**
   * The visit as this person may read it (P1-17): the back office gets the row as it is; the customer and
   * the artisan of the job get a copy without the back office's note, the staff ids and the reminders.
   */
  private visitFor(appointment: any, userId: number, role: Role, clientId: number) {
    if (!appointment || this.isStaff(role)) return appointment;

    return appointmentForParties(appointment, clientId === userId ? 'client' : 'artisan', userId);
  }

  private assertValidRange(startsAt: Date, endsAt: Date) {
    if (
      !startsAt ||
      !endsAt ||
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime())
    ) {
      throw new BadRequestException('Date ou horaire invalide.');
    }

    if (startsAt >= endsAt) {
      throw new BadRequestException(
        'La date de fin doit être après la date de début.',
      );
    }
  }

  private assertValidTimeSlot(startTime: string, endTime: string) {
    if (startTime >= endTime) {
      throw new BadRequestException(
        'Le créneau de fin doit être après le créneau de début.',
      );
    }
  }

  private async getInterventionOrFail(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        appointment: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private async getAppointmentOrFail(appointmentId: number) {
    const appointment = await this.prisma.appointment.findUnique({
      where: {
        id: appointmentId,
      },
      include: {
        intervention: true,
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        requests: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        reminders: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Rendez-vous introuvable.');
    }

    return appointment;
  }

  private async checkInterventionAccess(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    const intervention = await this.getInterventionOrFail(interventionId);

    const isClient = intervention.clientId === userId;
    const isArtisan = intervention.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  private async checkAppointmentAccess(
    userId: number,
    role: Role,
    appointmentId: number,
  ) {
    const appointment = await this.getAppointmentOrFail(appointmentId);

    const isClient = appointment.clientId === userId;
    const isArtisan = appointment.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return appointment;
  }

  private async assertArtisanExists(artisanId: number) {
    const artisan = await this.prisma.user.findFirst({
      where: {
        id: artisanId,
        role: Role.ARTISAN,
        isActive: true,
      },
    });

    if (!artisan) {
      throw new NotFoundException('Artisan introuvable ou inactif.');
    }

    return artisan;
  }

  private async getArtisanProfileOrFail(artisanId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({
      where: {
        userId: artisanId,
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    return profile;
  }

  /**
   * The weekly hours, read by the one rule the matching and the assignment use
   * (P1-05): no schedule at all is no restriction, any schedule is the list of
   * the hours the appointment must fit in, on the clock of the business.
   */
  private async isWithinWeeklyAvailability(
    artisanId: number,
    startsAt: Date,
    endsAt: Date,
    db: any = this.prisma,
  ) {
    const profile = await db.artisanProfile.findUnique({
      where: {
        userId: artisanId,
      },
      include: {
        availability: true,
      },
    });

    if (!profile) {
      return false;
    }

    return checkWeeklySchedule(
      profile.availability,
      startsAt,
      endsAt,
      getBusinessTimeZone(),
    ).ok;
  }

  private async checkDoubleBooking(params: {
    artisanId: number;
    startsAt: Date;
    endsAt: Date;
    excludeAppointmentId?: number;
    /** The transaction that holds the artisan's lock, when the caller is about to write. */
    db?: any;
  }) {
    const db: any = params.db ?? this.prisma;

    const overlappingAppointments = await db.appointment.findMany({
      where: {
        artisanId: params.artisanId,
        id: params.excludeAppointmentId
          ? {
              not: params.excludeAppointmentId,
            }
          : undefined,
        status: {
          in: ACTIVE_APPOINTMENT_STATUSES,
        },
        startsAt: {
          lt: params.endsAt,
        },
        endsAt: {
          gt: params.startsAt,
        },
      },
      include: {
        intervention: {
          select: {
            id: true,
            address: true,
            serviceType: true,
            status: true,
          },
        },
      },
    });

    const overlappingBlocks = await db.artisanTimeBlock.findMany({
      where: {
        artisanId: params.artisanId,
        startsAt: {
          lt: params.endsAt,
        },
        endsAt: {
          gt: params.startsAt,
        },
      },
    });

    const withinAvailability = await this.isWithinWeeklyAvailability(
      params.artisanId,
      params.startsAt,
      params.endsAt,
      db,
    );

    return {
      available:
        overlappingAppointments.length === 0 &&
        overlappingBlocks.length === 0 &&
        withinAvailability,
      overlappingAppointments,
      overlappingBlocks,
      withinAvailability,
    };
  }

  private async notifyUser(params: {
    userId: number;
    title: string;
    message: string;
    entityType?: string;
    entityId?: number;
    /** What kind of notice it is (GENERAL unless it is a reminder), where it goes (the app, a push, an e-mail unless told), and what travels with it. */
    type?: NotificationType;
    channels?: NotificationChannel[];
    data?: Record<string, string | number | boolean>;
  }) {
    return this.notifications?.notify?.({
      recipientId: params.userId,
      type: params.type ?? NotificationType.GENERAL,
      priority: NotificationPriority.NORMAL,
      title: params.title,
      message: params.message,
      channels: params.channels ?? [
        NotificationChannel.IN_APP,
        NotificationChannel.PUSH,
        NotificationChannel.EMAIL,
      ],
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.data ? { data: params.data } : {}),
    });
  }

  /**
   * A visit is no longer something to ask about once its job is over, cancelled or in dispute, or once the visit itself is over
   * or cancelled (P3-01). Scheduling is for a job that is still to be done: it never reopens one that was done (a finished job's
   * visit put back to "requested", or a request to move a visit that took place).
   */
  private assertJobOpenForScheduling(jobStatus: unknown) {
    const status = String(canonicalStatus(String(jobStatus)));

    for (const [words, statuses] of [
      ['terminée', WORK_DONE_STATUSES],
      ['annulée', STATUS_GROUPS.cancelled as readonly string[]],
      ['en litige', STATUS_GROUPS.disputed as readonly string[]],
    ] as const) {
      if (statuses.includes(status)) {
        throw new ConflictException(`Cette mission est ${words}: son rendez-vous ne peut plus être modifié.`);
      }
    }
  }

  /**
   * The job and its visit, read under the lock of the job (P3-01): what a customer asks about is checked against what is true now,
   * not against what was read before the lock (a hand-over, an approved cancellation or a payment may have come in between).
   */
  private async lockedVisit(tx: any, interventionId: number) {
    await lockJob(tx, interventionId);

    const job = await tx.intervention.findUnique({
      where: { id: interventionId },
      select: { id: true, status: true, clientId: true, artisanId: true },
    });

    if (!job) throw new NotFoundException('Intervention introuvable.');

    this.assertJobOpenForScheduling(job.status);

    const visit = await tx.appointment.findUnique({ where: { interventionId } });

    return { job, visit };
  }

  // ==========================================================
  // Client side
  // ==========================================================

  async choosePreferredTime(
    userId: number,
    role: Role,
    interventionId: number,
    dto: PreferredTimeDto,
  ) {
    this.assertValidTimeSlot(dto.preferredStartTime, dto.preferredEndTime);

    const intervention = await this.checkInterventionAccess(
      userId,
      role,
      interventionId,
    );

    // The time is the customer's to give. The artisan of the job is on the job, and may ask to move the
    // visit (reschedule-request), but does not change the time the customer asked for (P1-17).
    if (!this.isStaff(role) && intervention.clientId !== userId) {
      throw new ForbiddenException('Vous ne pouvez modifier que vos demandes.');
    }

    const preferredDate = new Date(dto.preferredDate);

    // Under the lock of the job, like every other write of the visit: what is refused or kept is decided on the visit as it is
    // now, and the visit and the job's preferred time are written together (P3-01).
    const appointment = await this.prisma.$transaction(async (tx) => {
      const { job, visit } = await this.lockedVisit(tx, interventionId);

      // Who may give the time is checked again on the job as it is under the lock: the customer of the job, or the back office.
      if (!this.isStaff(role) && job.clientId !== userId) {
        throw new ForbiddenException('Vous ne pouvez modifier que vos demandes.');
      }

      // A visit that is planned holds the artisan's calendar; this route writes "REQUESTED", which does not. Applied to a planned
      // visit it freed the hour (the artisan could be booked on it again) and dropped what the artisan had confirmed. A planned
      // visit is moved by asking for it to be moved (reschedule-request), which the back office answers.
      if (visit && (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(visit.status))) {
        throw new ConflictException(
          'Un rendez-vous est déjà prévu pour cette mission. Pour le déplacer, demandez un report: l’administration vous répondra.',
        );
      }

      if (visit && visit.status === AppointmentStatus.COMPLETED) {
        throw new ConflictException('La visite a déjà eu lieu: son horaire ne peut plus être modifié.');
      }

      // The job's preferred time first, then the visit: both in this transaction, so one failing leaves neither.
      await tx.intervention.update({
        where: {
          id: interventionId,
        },
        data: {
          preferredDate,
          preferredStartTime: dto.preferredStartTime,
          preferredEndTime: dto.preferredEndTime,
        },
      });

      const saved = await tx.appointment.upsert({
        where: {
          interventionId,
        },
        update: {
          preferredDate,
          preferredStartTime: dto.preferredStartTime,
          preferredEndTime: dto.preferredEndTime,
          clientNote: dto.clientNote,
          status: AppointmentStatus.REQUESTED,
          // A visit that was cancelled or missed is asked for again: the old hour, its confirmation and the reason it ended go with it.
          // Kept, the old hour would be confirmed by the next acceptance, whatever the customer chose now.
          startsAt: null,
          endsAt: null,
          confirmedAt: null,
          cancelledAt: null,
          cancelReason: null,
        },
        create: {
          interventionId,
          clientId: job.clientId,
          artisanId: job.artisanId,
          timezone: getBusinessTimeZone(),
          preferredDate,
          preferredStartTime: dto.preferredStartTime,
          preferredEndTime: dto.preferredEndTime,
          clientNote: dto.clientNote,
          status: AppointmentStatus.REQUESTED,
        },
      });

      return saved;
    });

    return this.visitFor(appointment, userId, role, intervention.clientId);
  }

  async getAppointmentForIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    const intervention = await this.checkInterventionAccess(userId, role, interventionId);

    const appointment = await this.prisma.appointment.findUnique({
      where: {
        interventionId,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        requests: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        reminders: true,
      },
    });

    return this.visitFor(appointment, userId, role, intervention.clientId);
  }

  /**
   * A request to move or cancel a visit, made under the lock of the job (P3-01). It is made only about a visit that is planned (not
   * one that is over or cancelled) on a job that is still to be done, and not twice over: a second identical request while the first
   * waits is a double click, not a new wish. The request keeps what the visit was, so that a refusal can put it back; a visit that
   * already waits for an answer to another request keeps showing the stronger one (a cancellation shows over a move).
   */
  private async openRequest(
    userId: number,
    role: Role,
    interventionId: number,
    appointmentId: number,
    wish: {
      type: AppointmentRequestType;
      requestedStartAt?: Date;
      requestedEndAt?: Date;
      reason?: string | null;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const { visit } = await this.lockedVisit(tx, interventionId);

      if (!visit || visit.id !== appointmentId) throw new NotFoundException('Rendez-vous introuvable.');

      // Who asks is checked again on the visit as it is under the lock: an artisan who gave the job back, or was replaced, since the
      // first check is no longer a party of the visit.
      if (!this.isStaff(role) && visit.clientId !== userId && visit.artisanId !== userId) {
        throw new ForbiddenException('Accès refusé.');
      }

      if (visit.status === AppointmentStatus.REQUESTED) {
        throw new ConflictException('Aucun horaire n’est encore planifié pour cette mission: il n’y a rien à reporter ni à annuler.');
      }

      // A visit nobody holds (the artisan gave the job back) cannot be moved or cancelled by an answer: that answer would find no
      // artisan. The job goes back to the dispatcher, who plans it again.
      if (visit.artisanId === null || visit.artisanId === undefined) {
        throw new ConflictException('Ce rendez-vous n’a plus d’artisan: la mission est à replanifier par l’administration.');
      }

      if (!(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(visit.status))) {
        throw new ConflictException('Ce rendez-vous n’est plus actif: il ne peut plus faire l’objet d’une demande.');
      }

      const waiting = await tx.appointmentRequest.findMany({
        where: { appointmentId, status: AppointmentRequestStatus.PENDING },
        orderBy: { id: 'asc' },
      });

      if (waiting.some((other: any) => other.type === wish.type)) {
        throw new ConflictException('Une demande identique attend déjà une réponse de l’administration.');
      }

      const request = await tx.appointmentRequest.create({
        data: {
          appointmentId,
          requestedById: userId,
          type: wish.type,
          previousStatus: baseStatusOf(visit, waiting),
          ...(wish.requestedStartAt ? { requestedStartAt: wish.requestedStartAt } : {}),
          ...(wish.requestedEndAt ? { requestedEndAt: wish.requestedEndAt } : {}),
          reason: wish.reason,
        },
      });

      await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: visitStatusFor([...waiting, request], baseStatusOf(visit, waiting)) },
      });

      return request;
    });
  }

  async requestReschedule(
    userId: number,
    role: Role,
    appointmentId: number,
    dto: RescheduleRequestDto,
  ) {
    const appointment = await this.checkAppointmentAccess(
      userId,
      role,
      appointmentId,
    );

    const requestedStartAt = instantOf(dto.requestedStartAt);
    const requestedEndAt = instantOf(dto.requestedEndAt);

    this.assertValidRange(requestedStartAt, requestedEndAt);

    const request = await this.openRequest(userId, role, appointment.interventionId, appointmentId, {
      type: AppointmentRequestType.RESCHEDULE,
      requestedStartAt,
      requestedEndAt,
      reason: dto.reason,
    });

    await this.notifications?.notifyAdmins?.({
      type: NotificationType.GENERAL,
      priority: NotificationPriority.HIGH,
      title: 'Demande de report',
      message: `Une demande de report a été créée pour l’intervention #${appointment.interventionId}.`,
      entityType: 'APPOINTMENT_REQUEST',
      entityId: request.id,
    });

    return this.isStaff(role) ? request : appointmentRequestForParties(request, userId);
  }

  async requestCancel(
    userId: number,
    role: Role,
    appointmentId: number,
    dto: CancelAppointmentRequestDto,
  ) {
    const appointment = await this.checkAppointmentAccess(
      userId,
      role,
      appointmentId,
    );

    const request = await this.openRequest(userId, role, appointment.interventionId, appointmentId, {
      type: AppointmentRequestType.CANCEL,
      reason: dto.reason,
    });

    await this.notifications?.notifyAdmins?.({
      type: NotificationType.GENERAL,
      priority: NotificationPriority.HIGH,
      title: 'Demande d’annulation',
      message: `Une demande d’annulation a été créée pour l’intervention #${appointment.interventionId}.`,
      entityType: 'APPOINTMENT_REQUEST',
      entityId: request.id,
    });

    return this.isStaff(role) ? request : appointmentRequestForParties(request, userId);
  }

  // ==========================================================
  // Admin side
  // ==========================================================

  async scheduleIntervention(
    userId: number,
    role: Role,
    interventionId: number,
    dto: ScheduleInterventionDto,
  ) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Seule l’administration peut planifier.');
    }

    // The one assignment path: the artisan must be approved and free, the job in a
    // status that can be assigned, and the status, the artisan and the appointment
    // are written together (with the reminders, the notifications and the live event).
    const { appointment } = await this.assignment.assign({
      interventionId,
      artisanId: dto.artisanId,
      actorId: userId,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      adminNote: dto.adminNote,
    });

    return this.getAppointmentOrFail(appointment.id);
  }

  async getAdminCalendar(
    userId: number,
    role: Role,
    from: string,
    to: string,
    artisanId?: number,
  ) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Accès réservé à l’administration.');
    }

    const fromDate = instantOf(from);
    const toDate = instantOf(to);

    this.assertValidRange(fromDate, toDate);

    return this.prisma.appointment.findMany({
      where: {
        startsAt: {
          lt: toDate,
        },
        endsAt: {
          gt: fromDate,
        },
        ...(artisanId ? { artisanId } : {}),
        status: {
          notIn: [AppointmentStatus.CANCELLED],
        },
      },
      include: {
        intervention: {
          select: {
            id: true,
            address: true,
            serviceType: true,
            status: true,
            urgency: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
      orderBy: {
        startsAt: 'asc',
      },
    });
  }

  async getArtisanAvailability(
    userId: number,
    role: Role,
    artisanId: number,
    date?: string,
  ) {
    if (!this.isStaff(role) && userId !== artisanId) {
      throw new ForbiddenException('Accès refusé.');
    }

    await this.assertArtisanExists(artisanId);

    const profile = await this.prisma.artisanProfile.findUnique({
      where: {
        userId: artisanId,
      },
      include: {
        availability: {
          orderBy: [
            {
              dayOfWeek: 'asc',
            },
            {
              startTime: 'asc',
            },
          ],
        },
      },
    });

    const result: any = {
      artisanId,
      weeklyAvailability: profile?.availability || [],
    };

    if (date) {
      // The day is the one of the business clock: midnight to midnight in Tunis, whatever the TZ of the server is.
      const window = businessDayWindow(date);

      if (!window) throw new BadRequestException('Date invalide.');

      const { start: dayStart, end: dayEnd } = window;

      const blocks = await this.prisma.artisanTimeBlock.findMany({
        where: {
          artisanId,
          startsAt: {
            lt: dayEnd,
          },
          endsAt: {
            gt: dayStart,
          },
        },
        orderBy: {
          startsAt: 'asc',
        },
      });

      const appointments = await this.prisma.appointment.findMany({
        where: {
          artisanId,
          startsAt: {
            lt: dayEnd,
          },
          endsAt: {
            gt: dayStart,
          },
          status: {
            in: ACTIVE_APPOINTMENT_STATUSES,
          },
        },
        include: {
          intervention: {
            select: {
              id: true,
              address: true,
              serviceType: true,
              status: true,
            },
          },
        },
        orderBy: {
          startsAt: 'asc',
        },
      });

      result.date = date;
      result.timeBlocks = blocks;
      result.appointments = appointments;
    }

    return result;
  }

  async reviewAppointmentRequest(
    userId: number,
    role: Role,
    requestId: number,
    approved: boolean,
    dto: ReviewAppointmentRequestDto,
  ) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException(
        'Seule l’administration peut traiter cette demande.',
      );
    }

    const request = await this.prisma.appointmentRequest.findUnique({
      where: {
        id: requestId,
      },
      include: {
        appointment: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Demande introuvable.');
    }

    if (request.status !== AppointmentRequestStatus.PENDING) {
      throw new BadRequestException('Cette demande a déjà été traitée.');
    }

    // What was read above may be out of date by the time the job is ours: a hand-over
    // closes the pending requests of the appointment, and gives it to somebody else.
    // So the job is locked first (like an assignment does), and the request and the
    // appointment are read again under that lock; what they say then is what counts.
    const lockedPendingRequest = async (tx: any) => {
      await lockJob(tx, request.appointment.interventionId);

      const fresh = await tx.appointmentRequest.findUnique({
        where: { id: requestId },
        include: { appointment: true },
      });

      if (!fresh || fresh.status !== AppointmentRequestStatus.PENDING) {
        throw new BadRequestException('Cette demande a déjà été traitée.');
      }

      return fresh;
    };

    // Approving acts on the visit as it is now: still planned, still held by the artisan who
    // has the job, on a job that is still under way. A request filed before a hand-over, or
    // beside a cancellation that was approved, would otherwise act on a visit that is gone.
    const assertVisitStillStands = async (tx: any, fresh: any) => {
      if (!ACTIVE_APPOINTMENT_STATUSES.includes(fresh.appointment.status)) {
        throw new BadRequestException('Ce rendez-vous n’est plus actif: la demande n’a plus lieu d’être.');
      }

      const job = await tx.intervention.findUnique({
        where: { id: fresh.appointment.interventionId },
        select: { artisanId: true, status: true },
      });

      if (!job || job.artisanId === null || job.artisanId !== fresh.appointment.artisanId) {
        throw new BadRequestException('L’artisan de ce rendez-vous n’est plus celui de la mission.');
      }

      const jobStatus = String(canonicalStatus(job.status));

      if (!(STATUS_GROUPS.active as readonly string[]).includes(jobStatus) || WORK_DONE_STATUSES.includes(jobStatus)) {
        throw new ConflictException('La mission n’est plus en cours: la demande n’a plus lieu d’être.');
      }
    };

    const answer = {
      adminResponse: dto.adminResponse,
      reviewedById: userId,
      reviewedAt: new Date(),
    };

    if (!approved) {
      return this.prisma.$transaction(async (tx) => {
        const fresh = await lockedPendingRequest(tx);

        const rejected = await tx.appointmentRequest.update({
          where: {
            id: requestId,
          },
          data: {
            status: AppointmentRequestStatus.REJECTED,
            ...answer,
          },
        });

        // The visit stops saying that an answer is waited for: it is what it was before the request, or shows the next request still
        // waiting (P3-01).
        await this.showWaitingRequests(tx, fresh.appointment, requestId, fresh);

        return rejected;
      });
    }

    const approvedData = {
      status: AppointmentRequestStatus.APPROVED,
      ...answer,
    };

    if (request.type === AppointmentRequestType.CANCEL) {
      const done = await this.prisma.$transaction(async (tx) => {
        const fresh = await lockedPendingRequest(tx);

        await assertVisitStillStands(tx, fresh);

        await transitionStatus(tx, {
          id: fresh.appointment.interventionId,
          to: Status.CANCELLED,
          actor: { kind: 'staff', userId },
          dataOnChange: {
            cancelledAt: new Date(),
            cancelledReason: fresh.reason,
            // Who cancelled: the cancellations of the back office write it, and the case file reads it (P3-01).
            cancelledById: userId,
          },
        });

        // A job that is cancelled while it holds money owes it back: the line goes in the job's timeline for the back office, and
        // the people who handle money are told once the cancellation is written (below).
        const held = await this.moneyHeldOn(tx, fresh.appointment.interventionId);

        await tx.interventionEvent.create({
          data: {
            interventionId: fresh.appointment.interventionId,
            type: InterventionEventType.CANCELLED,
            title: 'Annulation approuvée',
            message: fresh.reason ?? undefined,
            createdById: userId,
          },
        });

        if (held !== null && compareMoney(held.due, 0) > 0) {
          await tx.interventionEvent.create({
            data: {
              interventionId: fresh.appointment.interventionId,
              type: InterventionEventType.INTERNAL_NOTE_ADDED,
              title: 'Remboursement à décider',
              message: `La mission a été annulée alors que ${held.keptText} du client sont encaissés: un remboursement de ${held.dueText} est à décider.`,
              createdById: userId,
              metadata: { internal: true, refundDue: held.due },
            },
          });
        } else if (held !== null && held.invoiceNumber) {
          // The customer paid, and the invoice that stands asks for all of it (it may even be marked paid): nothing is to be given back,
          // but the invoice of a job that was cancelled stays in force until somebody cancels it or credits it.
          await tx.interventionEvent.create({
            data: {
              interventionId: fresh.appointment.interventionId,
              type: InterventionEventType.INTERNAL_NOTE_ADDED,
              title: 'Facture à annuler ou à créditer',
              message: `La mission a été annulée alors que la facture ${held.invoiceNumber} reste en vigueur et que le client a payé ${held.keptText}: la facture est à annuler ou à créditer.`,
              createdById: userId,
              metadata: { internal: true, invoiceStanding: held.invoiceNumber },
            },
          });
        }

        await tx.appointment.update({
          where: {
            id: fresh.appointmentId,
          },
          data: {
            status: AppointmentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelReason: fresh.reason,
          },
        });

        // The visit is gone: its other waiting requests have nothing left to ask, and the
        // reminders not sent yet must not go out for a cancelled visit.
        await tx.appointmentRequest.updateMany({
          where: { appointmentId: fresh.appointmentId, status: AppointmentRequestStatus.PENDING, id: { not: requestId } },
          data: {
            status: AppointmentRequestStatus.CANCELLED,
            adminResponse: 'Demande classée: le rendez-vous a été annulé.',
            reviewedById: userId,
            reviewedAt: new Date(),
          },
        });

        await replaceDefaultReminders(tx as any, {
          id: fresh.appointmentId,
          startsAt: null,
          clientId: fresh.appointment.clientId,
          artisanId: fresh.appointment.artisanId,
        });

        const answered = await tx.appointmentRequest.update({
          where: {
            id: requestId,
          },
          data: approvedData,
        });

        return { answered, held, interventionId: fresh.appointment.interventionId as number };
      });

      // Once the cancellation is written: the people who handle money are told that a job that holds money was cancelled. A failure
      // to tell must not undo it (the line in the job's timeline and the refunds-due list say it too).
      if (done.held !== null && compareMoney(done.held.due, 0) > 0) {
        try {
          await this.notifications?.notifyRefundDueAfterCancellation?.(done.interventionId, done.held.due, userId);
        } catch {
          // The notification service logs its own failures; the cancellation stands.
        }
      }

      return done.answered;
    }

    // A request to move the appointment
    if (!request.requestedStartAt || !request.requestedEndAt) {
      throw new BadRequestException(
        'La demande de report ne contient pas de nouveau créneau.',
      );
    }

    if (!request.appointment.artisanId) {
      throw new BadRequestException('Aucun artisan assigné au rendez-vous.');
    }

    const requestedStartAt = request.requestedStartAt;
    const requestedEndAt = request.requestedEndAt;

    // Checked and written under the artisan's lock, like an assignment: an assignment
    // and an approval for the same hour cannot both see "free".
    return this.prisma.$transaction(async (tx) => {
      const fresh = await lockedPendingRequest(tx);

      await assertVisitStillStands(tx, fresh);

      const artisanId: number | null = fresh.appointment.artisanId;

      if (!artisanId) {
        throw new BadRequestException('Aucun artisan assigné au rendez-vous.');
      }

      await lockArtisanCalendar(tx as any, artisanId);

      const availability = await this.checkDoubleBooking({
        artisanId,
        startsAt: requestedStartAt,
        endsAt: requestedEndAt,
        excludeAppointmentId: fresh.appointmentId,
        db: tx,
      });

      if (!availability.available) {
        throw new BadRequestException({
          message: 'Artisan indisponible sur le nouveau créneau.',
          availability,
        });
      }

      const movedAppointment = await tx.appointment.update({
        where: {
          id: fresh.appointmentId,
        },
        data: {
          startsAt: requestedStartAt,
          endsAt: requestedEndAt,
          status: AppointmentStatus.SCHEDULED,
          // The artisan confirmed the old time, not this one.
          confirmedAt: null,
        },
      });

      // A request that still waits kept the visit as it was before it: confirmed, at the old time. Refused later, it must not give
      // the new time a confirmation nobody gave.
      await tx.appointmentRequest.updateMany({
        where: { appointmentId: fresh.appointmentId, status: AppointmentRequestStatus.PENDING, id: { not: requestId } },
        data: { previousStatus: AppointmentStatus.SCHEDULED },
      });

      // The reminders follow the appointment: moved, re-made and answered together or not at all.
      await replaceDefaultReminders(tx as any, movedAppointment);

      const answered = await tx.appointmentRequest.update({
        where: {
          id: requestId,
        },
        data: approvedData,
      });

      // The visit is at its new time, planned: unless another request still waits (a cancellation asked meanwhile), which it keeps showing.
      await this.showWaitingRequests(tx, { ...movedAppointment, status: AppointmentStatus.SCHEDULED }, requestId, fresh, AppointmentStatus.SCHEDULED);

      return answered;
    }).catch((error) => {
      // Two bookings for one artisan are refused by the database whatever the code checked before: a clash that slipped through a
      // check made a moment too early is a conflict for the person, not an error 500 (P3-01).
      throw overlapAsConflict(error);
    });
  }

  /**
   * The visit shows what is still waiting, and when nothing is, what it was (P3-01). Called once a request is answered: `answered` is
   * the request that was just closed (it is not waiting any more, whatever its row says yet). Only a visit that shows a request is
   * touched: one that was cancelled, or moved on in the meantime, keeps what it has. `steady` is what the visit is when nothing waits,
   * where the answer itself says (an approved move leaves it planned, not confirmed).
   */
  private async showWaitingRequests(
    tx: any,
    visit: { id: number; status: AppointmentStatus | string; confirmedAt?: Date | null },
    answeredId: number,
    answered: { previousStatus?: AppointmentStatus | string | null },
    steady?: AppointmentStatus,
  ) {
    if (
      !(WAITING_STATUSES as readonly string[]).includes(String(visit.status)) &&
      !(steady && (STEADY_STATUSES as readonly string[]).includes(String(visit.status)))
    ) {
      return;
    }

    const waiting = await tx.appointmentRequest.findMany({
      where: { appointmentId: visit.id, status: AppointmentRequestStatus.PENDING, id: { not: answeredId } },
      orderBy: { id: 'asc' },
    });

    const next = visitStatusFor(waiting, steady ?? baseStatusOf(visit, waiting, answered));

    if (next !== visit.status) {
      await tx.appointment.update({ where: { id: visit.id }, data: { status: next } });
    }
  }

  /**
   * What a job that is being cancelled holds (P3-01), read in the transaction that cancels it, so that what is written for the back
   * office says what the job held at that moment. The sum is the one of the refunds-due list (`moneyDueOnCancelledJob`): the money
   * received, less what went back, less what a standing invoice still asks of the customer. Null for a job that holds nothing.
   */
  private async moneyHeldOn(
    tx: any,
    interventionId: number,
  ): Promise<{ due: number; dueText: string; keptText: string; invoiceNumber: string | null } | null> {
    const payments = await tx.payment.findMany({
      where: { interventionId },
      select: { id: true, status: true, amount: true, amountRefunded: true, currency: true },
    });
    const invoices = await tx.invoice.findMany({
      where: { interventionId, status: { notIn: ['CANCELLED', 'DRAFT'] } },
      orderBy: { id: 'asc' },
    });

    const { kept, due, standing } = moneyDueOnCancelledJob(payments, invoices);

    if (compareMoney(kept, 0) <= 0) return null;

    return { due, dueText: formatMoney(due), keptText: formatMoney(kept), invoiceNumber: standing ? String(standing.invoiceNumber) : null };
  }

  // ==========================================================
  // Artisan side
  // ==========================================================

  async getArtisanDailySchedule(
    userId: number,
    role: Role,
    date: string,
    artisanId?: number,
  ) {
    const targetArtisanId = this.isStaff(role) && artisanId ? artisanId : userId;

    if (role === Role.CLIENT) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (!this.isStaff(role) && role !== Role.ARTISAN) {
      throw new ForbiddenException('Accès refusé.');
    }

    const window = businessDayWindow(date);

    if (!window) throw new BadRequestException('Date invalide.');

    const { start: dayStart, end: dayEnd } = window;

    return this.prisma.appointment.findMany({
      where: {
        artisanId: targetArtisanId,
        startsAt: {
          lt: dayEnd,
        },
        endsAt: {
          gt: dayStart,
        },
        status: {
          in: ACTIVE_APPOINTMENT_STATUSES,
        },
      },
      include: {
        intervention: {
          select: {
            id: true,
            address: true,
            serviceType: true,
            status: true,
            urgency: true,
            contactName: true,
            contactPhone: true,
            accessInstructions: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        startsAt: 'asc',
      },
    });
  }

  /**
   * The visit is confirmed, under the lock of the job (P3-01). A visit that shows a request still waiting keeps showing it: the
   * confirmation is written and the waiting requests remember it (a refusal then puts the visit back CONFIRMED). Written over, the
   * status would hide the request that waits, and a later refusal would restore a state that is no longer true (or lose the confirmation).
   */
  private async confirmVisit(tx: any, interventionId: number, appointmentId: number, artisanId: number | null) {
    await lockJob(tx, interventionId);

    const visit = await tx.appointment.findUnique({ where: { id: appointmentId } });

    // A visit that was cancelled or is over is not brought back to life by an acceptance (it would hold an hour that may be taken), nor
    // is one that is only asked for (REQUESTED): it holds no hour yet.
    if (visit && !(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(visit.status))) return visit;

    // The visit is confirmed by the artisan who holds it, and only when a time is planned: an acceptance that comes after a hand-over
    // is not the new artisan's, and a visit with no time has nothing to confirm (it would show as confirmed with no hour, and the
    // customer could not choose a time any more).
    if (visit && (visit.artisanId !== artisanId || !visit.startsAt)) return visit;

    if (visit && (WAITING_STATUSES as readonly string[]).includes(String(visit.status))) {
      await tx.appointmentRequest.updateMany({
        where: { appointmentId, status: AppointmentRequestStatus.PENDING },
        data: { previousStatus: AppointmentStatus.CONFIRMED },
      });

      return tx.appointment.update({ where: { id: appointmentId }, data: { confirmedAt: new Date() } });
    }

    return tx.appointment.update({ where: { id: appointmentId }, data: { status: AppointmentStatus.CONFIRMED, confirmedAt: new Date() } });
  }

  async acceptScheduledMission(
    userId: number,
    role: Role,
    appointmentId: number,
  ) {
    const appointment = await this.checkAppointmentAccess(
      userId,
      role,
      appointmentId,
    );

    if (!this.isStaff(role) && appointment.artisanId !== userId) {
      throw new ForbiddenException('Seul l’artisan assigné peut accepter.');
    }

    if ((VISIT_ENDED as readonly string[]).includes(String(appointment.status))) {
      throw new ConflictException('Ce rendez-vous n’est plus actif: il ne peut plus être accepté.');
    }

    if (!appointment.startsAt || !(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(appointment.status))) {
      throw new ConflictException('Aucun horaire n’est encore planifié pour cette mission: il n’y a rien à accepter.');
    }

    // The artisan accepting is the mission service's action (P1-06): the same lock, the same
    // dates, the same line in the timeline, the client and the back office told, the live event.
    // Only the visit is confirmed here.
    if (!this.isStaff(role)) {
      if (!this.missionActions) {
        throw new Error('SchedulingService: the mission actions are not available.');
      }

      await this.missionActions.accept({ userId, interventionId: appointment.interventionId });

      const confirmed = await this.prisma.$transaction((tx) => this.confirmVisit(tx, appointment.interventionId, appointmentId, appointment.artisanId));

      return this.visitFor(confirmed, userId, role, appointment.clientId);
    }

    // Staff accepting for the artisan: the status table lets them, and the client is told.
    const { visit: updated, accepted, from } = await this.prisma.$transaction(async (tx) => {
      // The lock of the job before the status is written, as everyone who takes both (an approved cancellation, the artisan's own
      // acceptance, a payment): the other order would let two of them wait for each other.
      await lockJob(tx, appointment.interventionId);

      const held = await tx.appointment.findUnique({ where: { id: appointmentId }, select: { artisanId: true } });

      if (!held || held.artisanId !== appointment.artisanId) {
        throw new ConflictException('Le rendez-vous a changé d’artisan entre-temps: rechargez avant de recommencer.');
      }

      // The job is read under the lock: a job that is over, cancelled or in dispute is not accepted, and a job that is under way is
      // never put back to "accepted" (the status table lets staff hand a job back, which is not what accepting a visit means). From
      // "accepted" onwards only the visit is confirmed.
      const job = await tx.intervention.findUnique({ where: { id: appointment.interventionId }, select: { status: true } });

      if (!job) throw new NotFoundException('Intervention introuvable.');

      this.assertJobOpenForScheduling(job.status);

      const from = String(canonicalStatus(String(job.status)));
      const accepted = !ACCEPTED_OR_LATER.includes(from);

      if (accepted) {
        await transitionStatus(tx, {
          id: appointment.interventionId,
          to: Status.ARTISAN_ACCEPTED,
          actor: { kind: 'staff', userId },
          dataOnChange: { artisanAcceptedAt: new Date() },
        });
      }

      return { visit: await this.confirmVisit(tx, appointment.interventionId, appointmentId, appointment.artisanId), accepted, from };
    });

    // The customer is told once, when the job really goes to "accepted" now.
    if (accepted) {
      await this.notifyUser({
        userId: appointment.clientId,
        title: 'Mission acceptée',
        message: 'L’artisan a accepté la mission planifiée.',
        entityType: 'APPOINTMENT',
        entityId: appointment.id,
      });

      await this.realtime?.emitStatusChange?.({
        interventionId: appointment.interventionId,
        oldStatus: from,
        newStatus: Status.ARTISAN_ACCEPTED,
        actorId: userId,
      });
    }

    return updated;
  }

  async upsertAvailabilitySlot(
    userId: number,
    role: Role,
    dto: UpdateAvailabilitySlotDto,
  ) {
    if (role !== Role.ARTISAN && !this.isStaff(role)) {
      throw new ForbiddenException(
        'Seul un artisan peut modifier ses disponibilités.',
      );
    }

    this.assertValidTimeSlot(dto.startTime, dto.endTime);

    const profile = await this.getArtisanProfileOrFail(userId);

    if (dto.slotId) {
      // A slot is changed by the artisan it belongs to: an id from somebody else's schedule is not found.
      const owned = await this.prisma.artisanAvailabilitySlot.findFirst({
        where: { id: dto.slotId, artisanProfileId: profile.id },
        select: { id: true },
      });

      if (!owned) {
        throw new NotFoundException('Créneau introuvable.');
      }

      return this.prisma.artisanAvailabilitySlot.update({
        where: {
          id: dto.slotId,
        },
        data: {
          dayOfWeek: dto.dayOfWeek,
          startTime: dto.startTime,
          endTime: dto.endTime,
          isAvailable: dto.isAvailable ?? true,
        },
      });
    }

    return this.prisma.artisanAvailabilitySlot.create({
      data: {
        artisanProfileId: profile.id,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        isAvailable: dto.isAvailable ?? true,
      },
    });
  }

  async createTimeBlock(
    userId: number,
    role: Role,
    dto: CreateTimeBlockDto,
  ) {
    if (role !== Role.ARTISAN && !this.isStaff(role)) {
      throw new ForbiddenException(
        'Seul un artisan peut bloquer un créneau.',
      );
    }

    const startsAt = instantOf(dto.startsAt);
    const endsAt = instantOf(dto.endsAt);

    this.assertValidRange(startsAt, endsAt);

    // Under the artisan's lock, like an assignment: a block and an appointment for the
    // same hour cannot both be accepted.
    return this.prisma.$transaction(async (tx) => {
      await lockArtisanCalendar(tx as any, userId);

      const availability = await this.checkDoubleBooking({
        artisanId: userId,
        startsAt,
        endsAt,
        db: tx,
      });

      if (availability.overlappingAppointments.length) {
        throw new BadRequestException({
          message:
            'Impossible de bloquer un créneau contenant une intervention planifiée.',
          availability,
        });
      }

      return tx.artisanTimeBlock.create({
        data: {
          artisanId: userId,
          startsAt,
          endsAt,
          type: dto.type || ArtisanTimeBlockType.UNAVAILABLE,
          reason: dto.reason,
          createdById: userId,
        },
      });
    });
  }

  async listMyTimeBlocks(userId: number, role: Role, from: string, to: string) {
    if (role !== Role.ARTISAN && !this.isStaff(role)) {
      throw new ForbiddenException('Accès refusé.');
    }

    const fromDate = instantOf(from);
    const toDate = instantOf(to);

    this.assertValidRange(fromDate, toDate);

    return this.prisma.artisanTimeBlock.findMany({
      where: {
        artisanId: userId,
        startsAt: {
          lt: toDate,
        },
        endsAt: {
          gt: fromDate,
        },
      },
      orderBy: {
        startsAt: 'asc',
      },
    });
  }

  // ==========================================================
  // Reminders
  // ==========================================================

  /**
   * Sends the reminders that are due (every 5 minutes). A reminder goes out only for a visit that still stands (P3-01): not for one that
   * was cancelled or is over, nor for a job that was cancelled, finished or disputed, nor once the visit has started, nor to somebody
   * who is no longer on the visit. Each such reminder is closed as SKIPPED with the reason. The message says how long before in hours
   * ("2 heures", not "120 minutes") and the day and hour of the visit; it travels as a reminder (its own type), to a guest by SMS.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendDueReminders() {
    const now = new Date();

    const dueReminders = await this.prisma.appointmentReminder.findMany({
      where: {
        status: AppointmentReminderStatus.PENDING,
        dueAt: {
          lte: now,
        },
      },
      take: 50,
      orderBy: {
        dueAt: 'asc',
      },
      include: { appointment: { select: { interventionId: true } } },
    });

    // A reminder is written only from the state it was read in: one that was deleted (the visit was cancelled or moved: its reminders
    // are made again) or taken by another run is left alone, and a write that finds nothing to write is not an error.
    const settleIn = (db: any, reminderId: number, from: AppointmentReminderStatus[], data: Record<string, unknown>) =>
      db.appointmentReminder.updateMany({
        where: { id: reminderId, status: { in: from } },
        data,
      });

    for (const reminder of dueReminders) {
      let claimed = false;

      try {
        // The look at the visit, the decision and the claim are made under the lock of the job, the lock a cancellation or a move
        // holds while it writes: a reminder is either taken before the cancellation (and goes out for a visit that stood) or after
        // it (and finds the visit cancelled, or its reminders gone). Nothing is sent from inside the transaction.
        const taken = await this.prisma.$transaction(async (tx) => {
          const interventionId = (reminder as any).appointment?.interventionId;

          if (typeof interventionId === 'number') await lockJob(tx as any, interventionId);

          // The visit and its job as they are now, not as they were when the batch was read.
          const appointment = await tx.appointment.findUnique({
            where: { id: reminder.appointmentId },
            include: { intervention: { select: { status: true } } },
          });

          const why = appointment
            ? reminderSkipReason(reminder, appointment, appointment.intervention?.status, new Date())
            : 'The visit does not exist any more.';

          if (why || !appointment) {
            await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], { status: AppointmentReminderStatus.SKIPPED, error: why });

            return null;
          }

          // A reminder made for another time of the visit: the visit was moved to a later time and its reminders have not been made
          // again yet. It waits for the hour it is really due, instead of telling "in 24 hours" about a visit days away.
          const dueFor = reminderDueAt(appointment.startsAt as Date, reminder.minutesBefore);

          if (dueFor.getTime() > Date.now()) {
            await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], { dueAt: dueFor });

            return null;
          }

          // After an outage the reminders of a day and of two hours before can be due together: the person is told once, by the closest.
          // Looked up here, on the visit as it is now and not on the batch (a batch holds 50 reminders, and the pair can be split by
          // it). A closer reminder counts when the sender will pick it up and its own hour has come, or when it has been sent since this
          // one was made (a reminder tried again after a failed read comes after the closer one went out; one sent for an earlier
          // schedule of the visit is older than this one and does not count).
          const now = new Date();
          const closer = await tx.appointmentReminder.findMany({
            where: {
              appointmentId: reminder.appointmentId,
              recipientId: reminder.recipientId,
              minutesBefore: { lt: reminder.minutesBefore },
              OR: [
                // Only one the sender will really pick up: a closer reminder that waits for a later hour tells nobody meanwhile.
                { status: AppointmentReminderStatus.PENDING, dueAt: { lte: now } },
                { status: AppointmentReminderStatus.SENT, sentAt: { gte: reminder.createdAt } },
              ],
            },
            select: { minutesBefore: true, status: true },
          });

          if (
            closer.some(
              (other: any) =>
                other.status === AppointmentReminderStatus.SENT ||
                reminderDueAt(appointment.startsAt as Date, other.minutesBefore).getTime() <= now.getTime(),
            )
          ) {
            await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], {
              status: AppointmentReminderStatus.SKIPPED,
              error: 'A closer reminder is due as well: the person is told by that one.',
            });

            return null;
          }

          const recipient = await tx.user.findUnique({
            where: {
              id: reminder.recipientId as number,
            },
            select: {
              id: true,
              isGuest: true,
              phone: true,
            },
          });

          if (!recipient) {
            await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], { status: AppointmentReminderStatus.SKIPPED, error: 'The recipient does not exist any more.' });

            return null;
          }

          // A guest is reached by SMS and nothing else: without a number there is nowhere to send it, and the reminder must not say "sent".
          if (recipient.isGuest && !recipient.phone) {
            await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], { status: AppointmentReminderStatus.SKIPPED, error: 'A guest without a phone number cannot be reminded.' });

            return null;
          }

          // The reminder is taken before it is sent: two runs at once cannot both send it.
          const claim = await settleIn(tx, reminder.id, [AppointmentReminderStatus.PENDING], { status: AppointmentReminderStatus.SENT, sentAt: new Date() });

          return claim.count === 1 ? { appointment, recipient } : null;
        });

        if (!taken) continue;

        claimed = true;

        const { appointment, recipient } = taken;

        const sent: any = await this.notifyUser({
          userId: recipient.id,
          type: NotificationType.APPOINTMENT_REMINDER,
          channels: reminderChannels(recipient),
          title: 'Rappel de rendez-vous',
          message: reminderMessage(
            reminder.minutesBefore,
            appointment.startsAt as Date,
            appointment.timezone || getBusinessTimeZone(),
            new Date(),
          ),
          entityType: 'APPOINTMENT',
          entityId: reminder.appointmentId,
          // What the phone reads when the reminder is tapped: which job to open.
          data: {
            interventionId: appointment.interventionId,
            appointmentId: reminder.appointmentId,
            minutesBefore: reminder.minutesBefore,
          },
        });

        // The notification service answers null when nobody was written to (the person is deactivated, or turned every channel off). A
        // guest has the SMS or nothing: the copy in the app is a record nobody reads, so a guest whose SMS was turned off was not reminded.
        const nowhere = sent === null;
        const guestWithoutSms = Boolean(recipient.isGuest) && Array.isArray(sent?.channels) && !sent.channels.includes(NotificationChannel.SMS);

        if (nowhere || guestWithoutSms) {
          await this.prisma.appointmentReminder.updateMany({
            where: { id: reminder.id, status: AppointmentReminderStatus.SENT },
            data: {
              status: AppointmentReminderStatus.SKIPPED,
              sentAt: null,
              error: nowhere
                ? 'Nothing was sent: the recipient is inactive or turned the channels off.'
                : 'Nothing was sent: the guest cannot be reached by SMS.',
            },
          });
        }
      } catch (error: any) {
        const message = error?.message || 'Reminder failed.';

        if (claimed) {
          // Taken, and the sending failed: it is not sent again (it may have gone out), and the reason is written.
          await this.prisma.appointmentReminder
            .updateMany({
              where: { id: reminder.id, status: { in: [AppointmentReminderStatus.PENDING, AppointmentReminderStatus.SENT] } },
              data: { status: AppointmentReminderStatus.FAILED, sentAt: null, error: message },
            })
            .catch(() => undefined);
        } else {
          // Nothing was taken and nothing was sent (a read failed, the database blinked): it is tried again in a few minutes, until the
          // visit has started and the reminder is skipped. The reason is written meanwhile.
          await this.prisma.appointmentReminder
            .updateMany({
              where: { id: reminder.id, status: AppointmentReminderStatus.PENDING },
              data: { error: message, dueAt: new Date(Date.now() + 5 * 60000) },
            })
            .catch(() => undefined);
        }
      }
    }
  }}
