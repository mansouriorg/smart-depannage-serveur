import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { transitionStatus } from '../intervention-workflow/transition-status';

import {
  AppointmentReminderStatus,
  AppointmentRequestStatus,
  AppointmentRequestType,
  AppointmentStatus,
  ArtisanTimeBlockType,
  DayOfWeek,
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

type AppointmentReminderCreateData = {
  appointmentId: number;
  recipientId: number;
  minutesBefore: number;
  dueAt: Date;
};

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,

    @Optional()
    private readonly notifications?: NotificationsService,

    @Optional()
    private readonly realtime?: RealtimeService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    const staffRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return staffRoles.includes(role);
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

  private jsDayToDayOfWeek(date: Date): DayOfWeek {
    const day = date.getDay();

    switch (day) {
      case 0:
        return DayOfWeek.SUNDAY;
      case 1:
        return DayOfWeek.MONDAY;
      case 2:
        return DayOfWeek.TUESDAY;
      case 3:
        return DayOfWeek.WEDNESDAY;
      case 4:
        return DayOfWeek.THURSDAY;
      case 5:
        return DayOfWeek.FRIDAY;
      case 6:
      default:
        return DayOfWeek.SATURDAY;
    }
  }

  private timeFromDate(date: Date): string {
    return date.toISOString().slice(11, 16);
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

  private async isWithinWeeklyAvailability(
    artisanId: number,
    startsAt: Date,
    endsAt: Date,
  ) {
    const profile = await this.prisma.artisanProfile.findUnique({
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

    const dayOfWeek = this.jsDayToDayOfWeek(startsAt);
    const slots = profile.availability.filter(
      (slot) => slot.dayOfWeek === dayOfWeek && slot.isAvailable,
    );

    if (!slots.length) {
      return true;
    }

    const startTime = this.timeFromDate(startsAt);
    const endTime = this.timeFromDate(endsAt);

    return slots.some(
      (slot) => slot.startTime <= startTime && slot.endTime >= endTime,
    );
  }

  private async checkDoubleBooking(params: {
    artisanId: number;
    startsAt: Date;
    endsAt: Date;
    excludeAppointmentId?: number;
  }) {
    const overlappingAppointments = await this.prisma.appointment.findMany({
      where: {
        artisanId: params.artisanId,
        id: params.excludeAppointmentId
          ? {
              not: params.excludeAppointmentId,
            }
          : undefined,
        status: {
          in: [
            AppointmentStatus.SCHEDULED,
            AppointmentStatus.CONFIRMED,
            AppointmentStatus.RESCHEDULE_REQUESTED,
          ],
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

    const overlappingBlocks = await this.prisma.artisanTimeBlock.findMany({
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

  private async createDefaultReminders(appointmentId: number) {
    const appointment = await this.getAppointmentOrFail(appointmentId);

    if (!appointment.startsAt) {
      return;
    }

    await this.prisma.appointmentReminder.deleteMany({
      where: {
        appointmentId,
        status: AppointmentReminderStatus.PENDING,
      },
    });

    const recipients = [appointment.clientId, appointment.artisanId].filter(
      Boolean,
    ) as number[];

    const reminders: AppointmentReminderCreateData[] = [];

    for (const recipientId of recipients) {
      for (const minutesBefore of [1440, 120]) {
        const dueAt = new Date(
          appointment.startsAt.getTime() - minutesBefore * 60 * 1000,
        );

        if (dueAt <= new Date()) {
          continue;
        }

        reminders.push({
          appointmentId,
          recipientId,
          minutesBefore,
          dueAt,
        });
      }
    }

    if (!reminders.length) {
      return;
    }

    await this.prisma.appointmentReminder.createMany({
      data: reminders,
    });
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

    if (role === Role.CLIENT && intervention.clientId !== userId) {
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

    return appointment;
  }

  async getAppointmentForIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    return this.prisma.appointment.findUnique({
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

    return request;
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

    return request;
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

    const intervention = await this.getInterventionOrFail(interventionId);

    await this.assertArtisanExists(dto.artisanId);

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    this.assertValidRange(startsAt, endsAt);

    const availability = await this.checkDoubleBooking({
      artisanId: dto.artisanId,
      startsAt,
      endsAt,
    });

    if (!availability.available) {
      throw new BadRequestException({
        message: 'Artisan indisponible ou déjà réservé sur ce créneau.',
        availability,
      });
    }

    // Status and appointment change together: if the job cannot be assigned
    // from where it is (already started, cancelled...), no appointment is kept.
    const appointment = await this.prisma.$transaction(async (tx) => {
      await transitionStatus(tx, {
        id: interventionId,
        to: Status.ASSIGNED,
        actor: { kind: 'staff', userId },
        data: {
          artisanId: dto.artisanId,
          assignedAt: new Date(),
          preferredDate: startsAt,
          preferredStartTime: startsAt.toISOString().slice(11, 16),
          preferredEndTime: endsAt.toISOString().slice(11, 16),
        },
      });

      return tx.appointment.upsert({
        where: {
          interventionId,
        },
        update: {
          artisanId: dto.artisanId,
          startsAt,
          endsAt,
          adminNote: dto.adminNote,
          scheduledById: userId,
          status: AppointmentStatus.SCHEDULED,
        },
        create: {
          interventionId,
          clientId: intervention.clientId,
          artisanId: dto.artisanId,
          startsAt,
          endsAt,
          adminNote: dto.adminNote,
          scheduledById: userId,
          status: AppointmentStatus.SCHEDULED,
        },
      });
    });

    await this.createDefaultReminders(appointment.id);

    await this.notifyUser({
      userId: intervention.clientId,
      title: 'Rendez-vous confirmé',
      message: 'Votre intervention a été planifiée.',
      entityType: 'APPOINTMENT',
      entityId: appointment.id,
    });

    await this.notifyUser({
      userId: dto.artisanId,
      title: 'Nouvelle mission planifiée',
      message: 'Une mission vous a été planifiée.',
      entityType: 'APPOINTMENT',
      entityId: appointment.id,
    });

    await this.realtime?.emitStatusChange?.({
      interventionId,
      oldStatus: intervention.status,
      newStatus: Status.ASSIGNED,
      actorId: userId,
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
            in: [
              AppointmentStatus.SCHEDULED,
              AppointmentStatus.CONFIRMED,
              AppointmentStatus.RESCHEDULE_REQUESTED,
            ],
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

    if (!approved) {
      const rejected = await this.prisma.appointmentRequest.update({
        where: {
          id: requestId,
        },
        data: {
          status: AppointmentRequestStatus.REJECTED,
          adminResponse: dto.adminResponse,
          reviewedById: userId,
          reviewedAt: new Date(),
        },
      });

      return rejected;
    }

    if (request.type === AppointmentRequestType.CANCEL) {
      await this.prisma.$transaction(async (tx) => {
        await transitionStatus(tx, {
          id: request.appointment.interventionId,
          to: Status.CANCELLED,
          actor: { kind: 'staff', userId },
          dataOnChange: {
            cancelledAt: new Date(),
            cancelledReason: request.reason,
          },
        });

        await tx.appointment.update({
          where: {
            id: request.appointmentId,
          },
          data: {
            status: AppointmentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelReason: request.reason,
          },
        });
      });
    }

    if (request.type === AppointmentRequestType.RESCHEDULE) {
      if (!request.requestedStartAt || !request.requestedEndAt) {
        throw new BadRequestException(
          'La demande de report ne contient pas de nouveau créneau.',
        );
      }

      if (!request.appointment.artisanId) {
        throw new BadRequestException('Aucun artisan assigné au rendez-vous.');
      }

      const availability = await this.checkDoubleBooking({
        artisanId: request.appointment.artisanId,
        startsAt: request.requestedStartAt,
        endsAt: request.requestedEndAt,
        excludeAppointmentId: request.appointmentId,
      });

      if (!availability.available) {
        throw new BadRequestException({
          message: 'Artisan indisponible sur le nouveau créneau.',
          availability,
        });
      }

      await this.prisma.appointment.update({
        where: {
          id: request.appointmentId,
        },
        data: {
          startsAt: request.requestedStartAt,
          endsAt: request.requestedEndAt,
          status: AppointmentStatus.SCHEDULED,
        },
      });

      await this.createDefaultReminders(request.appointmentId);
    }

    return this.prisma.appointmentRequest.update({
      where: {
        id: requestId,
      },
      data: {
        status: AppointmentRequestStatus.APPROVED,
        adminResponse: dto.adminResponse,
        reviewedById: userId,
        reviewedAt: new Date(),
      },
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
          in: [
            AppointmentStatus.SCHEDULED,
            AppointmentStatus.CONFIRMED,
            AppointmentStatus.RESCHEDULE_REQUESTED,
          ],
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

    const updated = await this.prisma.$transaction(async (tx) => {
      await transitionStatus(tx, {
        id: appointment.interventionId,
        to: Status.ARTISAN_ACCEPTED,
        actor: { kind: this.isStaff(role) ? 'staff' : 'artisan', userId },
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

    const availability = await this.checkDoubleBooking({
      artisanId: userId,
      startsAt,
      endsAt,
    });

    if (availability.overlappingAppointments.length) {
      throw new BadRequestException({
        message:
          'Impossible de bloquer un créneau contenant une intervention planifiée.',
        availability,
      });
    }

    return this.prisma.artisanTimeBlock.create({
      data: {
        artisanId: userId,
        startsAt,
        endsAt,
        type: dto.type || ArtisanTimeBlockType.UNAVAILABLE,
        reason: dto.reason,
        createdById: userId,
      },
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
