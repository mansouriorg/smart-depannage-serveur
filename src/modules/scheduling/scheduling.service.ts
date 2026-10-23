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
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { canonicalStatus, STATUS_GROUPS } from '../intervention-workflow/intervention-status';
import { AssignmentService } from '../assignment/assignment.service';
import { MissionActionsService } from '../mission-actions/mission-actions.service';
import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';
import { lockArtisanCalendar, lockJob } from '../assignment/artisan-lock';
import { replaceDefaultReminders } from '../assignment/appointment-reminders';
import { appointmentForParties, appointmentRequestForParties } from '../../common/views/views';
import { isTicketStaff } from '../../common/auth/role-policy';

import {
  AppointmentReminderStatus,
  AppointmentRequestStatus,
  AppointmentRequestType,
  AppointmentStatus,
  ArtisanTimeBlockType,
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
  }) {
    await this.notifications?.notify?.({
      recipientId: params.userId,
      type: NotificationType.GENERAL,
      priority: NotificationPriority.NORMAL,
      title: params.title,
      message: params.message,
      channels: [
        NotificationChannel.IN_APP,
        NotificationChannel.PUSH,
        NotificationChannel.EMAIL,
      ],
      entityType: params.entityType,
      entityId: params.entityId,
    });
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

    const appointment = await this.prisma.appointment.upsert({
      where: {
        interventionId,
      },
      update: {
        preferredDate,
        preferredStartTime: dto.preferredStartTime,
        preferredEndTime: dto.preferredEndTime,
        clientNote: dto.clientNote,
        status: AppointmentStatus.REQUESTED,
      },
      create: {
        interventionId,
        clientId: intervention.clientId,
        artisanId: intervention.artisanId,
        preferredDate,
        preferredStartTime: dto.preferredStartTime,
        preferredEndTime: dto.preferredEndTime,
        clientNote: dto.clientNote,
        status: AppointmentStatus.REQUESTED,
      },
    });

    await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        preferredDate,
        preferredStartTime: dto.preferredStartTime,
        preferredEndTime: dto.preferredEndTime,
      },
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

    const requestedStartAt = new Date(dto.requestedStartAt);
    const requestedEndAt = new Date(dto.requestedEndAt);

    this.assertValidRange(requestedStartAt, requestedEndAt);

    const request = await this.prisma.appointmentRequest.create({
      data: {
        appointmentId,
        requestedById: userId,
        type: AppointmentRequestType.RESCHEDULE,
        requestedStartAt,
        requestedEndAt,
        reason: dto.reason,
      },
    });

    await this.prisma.appointment.update({
      where: {
        id: appointmentId,
      },
      data: {
        status: AppointmentStatus.RESCHEDULE_REQUESTED,
      },
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

    const request = await this.prisma.appointmentRequest.create({
      data: {
        appointmentId,
        requestedById: userId,
        type: AppointmentRequestType.CANCEL,
        reason: dto.reason,
      },
    });

    await this.prisma.appointment.update({
      where: {
        id: appointmentId,
      },
      data: {
        status: AppointmentStatus.CANCEL_REQUESTED,
      },
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

    const fromDate = new Date(from);
    const toDate = new Date(to);

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
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

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

      if (!(STATUS_GROUPS.active as readonly string[]).includes(String(canonicalStatus(job.status)))) {
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
        await lockedPendingRequest(tx);

        return tx.appointmentRequest.update({
          where: {
            id: requestId,
          },
          data: {
            status: AppointmentRequestStatus.REJECTED,
            ...answer,
          },
        });
      });
    }

    const approvedData = {
      status: AppointmentRequestStatus.APPROVED,
      ...answer,
    };

    if (request.type === AppointmentRequestType.CANCEL) {
      return this.prisma.$transaction(async (tx) => {
        const fresh = await lockedPendingRequest(tx);

        await assertVisitStillStands(tx, fresh);

        await transitionStatus(tx, {
          id: fresh.appointment.interventionId,
          to: Status.CANCELLED,
          actor: { kind: 'staff', userId },
          dataOnChange: {
            cancelledAt: new Date(),
            cancelledReason: fresh.reason,
          },
        });

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

        return tx.appointmentRequest.update({
          where: {
            id: requestId,
          },
          data: approvedData,
        });
      });
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
        },
      });

      // The reminders follow the appointment: moved, re-made and answered together or not at all.
      await replaceDefaultReminders(tx as any, movedAppointment);

      return tx.appointmentRequest.update({
        where: {
          id: requestId,
        },
        data: approvedData,
      });
    });
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

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

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

    // The artisan accepting is the mission service's action (P1-06): the same lock, the same
    // dates, the same line in the timeline, the client and the back office told, the live event.
    // Only the visit is confirmed here.
    if (!this.isStaff(role)) {
      if (!this.missionActions) {
        throw new Error('SchedulingService: the mission actions are not available.');
      }

      await this.missionActions.accept({ userId, interventionId: appointment.interventionId });

      const confirmed = await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: AppointmentStatus.CONFIRMED, confirmedAt: new Date() },
      });

      return this.visitFor(confirmed, userId, role, appointment.clientId);
    }

    // Staff accepting for the artisan: the status table lets them, and the client is told.
    const updated = await this.prisma.$transaction(async (tx) => {
      await transitionStatus(tx, {
        id: appointment.interventionId,
        to: Status.ARTISAN_ACCEPTED,
        actor: { kind: 'staff', userId },
        dataOnChange: { artisanAcceptedAt: new Date() },
      });

      return tx.appointment.update({
        where: {
          id: appointmentId,
        },
        data: {
          status: AppointmentStatus.CONFIRMED,
          confirmedAt: new Date(),
        },
      });
    });

    await this.notifyUser({
      userId: appointment.clientId,
      title: 'Mission acceptée',
      message: 'L’artisan a accepté la mission planifiée.',
      entityType: 'APPOINTMENT',
      entityId: appointment.id,
    });

    await this.realtime?.emitStatusChange?.({
      interventionId: appointment.interventionId,
      oldStatus: appointment.intervention.status,
      newStatus: Status.ARTISAN_ACCEPTED,
      actorId: userId,
    });

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

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

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

    const fromDate = new Date(from);
    const toDate = new Date(to);

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

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendDueReminders() {
    const dueReminders = await this.prisma.appointmentReminder.findMany({
      where: {
        status: AppointmentReminderStatus.PENDING,
        dueAt: {
          lte: new Date(),
        },
      },
      include: {
        appointment: true,
      },
      take: 50,
      orderBy: {
        dueAt: 'asc',
      },
    });

    for (const reminder of dueReminders) {
      try {
        if (!reminder.recipientId || !reminder.appointment.startsAt) {
          await this.prisma.appointmentReminder.update({
            where: {
              id: reminder.id,
            },
            data: {
              status: AppointmentReminderStatus.SKIPPED,
              error: 'Missing recipient or appointment start.',
            },
          });

          continue;
        }

        await this.notifyUser({
          userId: reminder.recipientId,
          title: 'Rappel de rendez-vous',
          message: `Votre intervention est prévue dans ${reminder.minutesBefore} minutes.`,
          entityType: 'APPOINTMENT',
          entityId: reminder.appointmentId,
        });

        await this.prisma.appointmentReminder.update({
          where: {
            id: reminder.id,
          },
          data: {
            status: AppointmentReminderStatus.SENT,
            sentAt: new Date(),
          },
        });
      } catch (error: any) {
        await this.prisma.appointmentReminder.update({
          where: {
            id: reminder.id,
          },
          data: {
            status: AppointmentReminderStatus.FAILED,
            error: error?.message || 'Reminder failed.',
          },
        });
      }
    }
  }
}
