import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';

import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';

import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationPriority,
  NotificationType,
  Prisma,
  Role,
} from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

type NotifyPayload = {
  recipientId: number;
  actorId?: number;
  type: NotificationType;
  title: string;
  message: string;
  channels?: NotificationChannel[];
  priority?: NotificationPriority;
  entityType?: string;
  entityId?: number;
  data?: Prisma.InputJsonValue;
};

type RegisterPushTokenDto = {
  token: string;
  platform?: string;
  deviceId?: string;
  deviceName?: string;
};

type UpdateNotificationPreferencesDto = {
  inAppEnabled?: boolean;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
  adminRealtimeEnabled?: boolean;

  interventionUpdates?: boolean;
  quoteUpdates?: boolean;
  paymentUpdates?: boolean;
  invoiceUpdates?: boolean;
  complaintUpdates?: boolean;
  marketingUpdates?: boolean;

  newInterventionCreated?: boolean;
  artisanAssigned?: boolean;
  artisanAcceptedMission?: boolean;
  artisanOnTheWay?: boolean;
  artisanArrived?: boolean;
  workStarted?: boolean;
  workCompleted?: boolean;
  quoteSent?: boolean;
  quoteAccepted?: boolean;
  paymentReceived?: boolean;
  invoiceReady?: boolean;
  complaintOpened?: boolean;
  complaintUpdated?: boolean;
  artisanApplicationApproved?: boolean;
  artisanApplicationRejected?: boolean;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,

    @Optional()
    private readonly gateway?: NotificationsGateway,
  ) {}

  // ==========================================================
  // Includes
  // ==========================================================

  private notificationInclude: Prisma.NotificationInclude = {
    recipient: {
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      },
    },
    actor: {
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    },
    deliveries: {
      orderBy: {
        createdAt: 'desc',
      },
    },
  };

  // ==========================================================
  // Helpers
  // ==========================================================

  private isAdminRole(role: Role): boolean {
    const adminRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return adminRoles.includes(role);
  }

  private defaultChannelsForType(type: NotificationType): NotificationChannel[] {
    switch (type) {
      case NotificationType.NEW_INTERVENTION_CREATED:
      case NotificationType.COMPLAINT_OPENED:
        return [
          NotificationChannel.IN_APP,
          NotificationChannel.EMAIL,
          NotificationChannel.ADMIN_REAL_TIME,
        ];

      case NotificationType.PAYMENT_RECEIVED:
      case NotificationType.INVOICE_READY:
      case NotificationType.QUOTE_SENT:
      case NotificationType.QUOTE_ACCEPTED:
        return [
          NotificationChannel.IN_APP,
          NotificationChannel.EMAIL,
          NotificationChannel.PUSH,
        ];

      case NotificationType.ARTISAN_ASSIGNED:
      case NotificationType.ARTISAN_ACCEPTED_MISSION:
      case NotificationType.ARTISAN_ON_THE_WAY:
      case NotificationType.ARTISAN_ARRIVED:
      case NotificationType.WORK_STARTED:
      case NotificationType.WORK_COMPLETED:
        return [
          NotificationChannel.IN_APP,
          NotificationChannel.PUSH,
          NotificationChannel.SMS,
        ];

      case NotificationType.ARTISAN_APPLICATION_APPROVED:
      case NotificationType.ARTISAN_APPLICATION_REJECTED:
        return [
          NotificationChannel.IN_APP,
          NotificationChannel.EMAIL,
        ];

      default:
        return [
          NotificationChannel.IN_APP,
        ];
    }
  }

  private preferenceFieldForType(
    type: NotificationType,
  ): keyof UpdateNotificationPreferencesDto | undefined {
    switch (type) {
      case NotificationType.NEW_INTERVENTION_CREATED:
        return 'newInterventionCreated';

      case NotificationType.ARTISAN_ASSIGNED:
        return 'artisanAssigned';

      case NotificationType.ARTISAN_ACCEPTED_MISSION:
        return 'artisanAcceptedMission';

      case NotificationType.ARTISAN_ON_THE_WAY:
        return 'artisanOnTheWay';

      case NotificationType.ARTISAN_ARRIVED:
        return 'artisanArrived';

      case NotificationType.WORK_STARTED:
        return 'workStarted';

      case NotificationType.WORK_COMPLETED:
        return 'workCompleted';

      case NotificationType.QUOTE_SENT:
        return 'quoteSent';

      case NotificationType.QUOTE_ACCEPTED:
        return 'quoteAccepted';

      case NotificationType.PAYMENT_RECEIVED:
        return 'paymentReceived';

      case NotificationType.INVOICE_READY:
        return 'invoiceReady';

      case NotificationType.COMPLAINT_OPENED:
        return 'complaintOpened';

      case NotificationType.COMPLAINT_UPDATED:
        return 'complaintUpdated';

      case NotificationType.ARTISAN_APPLICATION_APPROVED:
        return 'artisanApplicationApproved';

      case NotificationType.ARTISAN_APPLICATION_REJECTED:
        return 'artisanApplicationRejected';

      default:
        return undefined;
    }
  }

  private async getOrCreatePreferences(userId: number) {
    const existing = await this.prisma.notificationPreference.findUnique({
      where: {
        userId,
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.notificationPreference.create({
      data: {
        userId,
      },
    });
  }

  private channelAllowed(
    preferences: any,
    channel: NotificationChannel,
  ): boolean {
    switch (channel) {
      case NotificationChannel.IN_APP:
        return preferences.inAppEnabled !== false;

      case NotificationChannel.EMAIL:
        return preferences.emailEnabled !== false;

      case NotificationChannel.SMS:
        return preferences.smsEnabled !== false;

      case NotificationChannel.PUSH:
        return preferences.pushEnabled !== false;

      case NotificationChannel.ADMIN_REAL_TIME:
        return preferences.adminRealtimeEnabled !== false;

      default:
        return true;
    }
  }

  private eventAllowed(preferences: any, type: NotificationType): boolean {
    const field = this.preferenceFieldForType(type);

    if (!field) {
      return true;
    }

    return preferences[field] !== false;
  }

  private async getNotificationOrFail(notificationId: number) {
    const notification = await this.prisma.notification.findUnique({
      where: {
        id: notificationId,
      },
      include: this.notificationInclude,
    });

    if (!notification || notification.deletedAt) {
      throw new NotFoundException('Notification introuvable.');
    }

    return notification;
  }

  private checkNotificationOwner(
    user: AuthenticatedUser,
    notification: { recipientId: number },
  ) {
    if (notification.recipientId !== user.id && !this.isAdminRole(user.role)) {
      throw new ForbiddenException('Accès refusé.');
    }
  }

  private async logDelivery(data: {
    notificationId: number;
    userId: number;
    channel: NotificationChannel;
    status: NotificationDeliveryStatus;
    destination?: string;
    provider?: string;
    providerMessageId?: string;
    error?: string;
    sentAt?: Date;
  }) {
    return this.prisma.notificationDeliveryLog.create({
      data,
    });
  }

  // ==========================================================
  // 1. STANDARD CRUD METHODS
  // Compatible with your generated controller
  // ==========================================================

  async create(createNotificationDto: CreateNotificationDto) {
    const payload = createNotificationDto as any;

    return this.createNotification({
      recipientId: Number(payload.recipientId),
      actorId: payload.actorId ? Number(payload.actorId) : undefined,
      type: payload.type || NotificationType.GENERAL,
      priority: payload.priority || NotificationPriority.NORMAL,
      title: payload.title || 'Notification',
      message: payload.message || payload.content || '',
      channels: payload.channels,
      entityType: payload.entityType,
      entityId: payload.entityId ? Number(payload.entityId) : undefined,
      data: payload.data,
    });
  }

  async findAll() {
    return this.prisma.notification.findMany({
      where: {
        deletedAt: null,
      },
      include: this.notificationInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOneById(id: number) {
    return this.getNotificationOrFail(id);
  }

  async update(id: number, updateNotificationDto: UpdateNotificationDto) {
    await this.getNotificationOrFail(id);

    const payload = updateNotificationDto as any;

    return this.prisma.notification.update({
      where: {
        id,
      },
      data: {
        title: payload.title,
        message: payload.message,
        priority: payload.priority,
        channels: payload.channels,
        entityType: payload.entityType,
        entityId: payload.entityId,
        data: payload.data,
        isRead: payload.isRead,
        readAt: payload.isRead ? new Date() : undefined,
      },
      include: this.notificationInclude,
    });
  }

  async remove(id: number) {
    await this.getNotificationOrFail(id);

    return this.prisma.notification.update({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  // ==========================================================
  // 2. SIMULATED DELIVERY CHANNELS
  // No external API for now
  // ==========================================================

  async sendSms(phoneNumber: string, message: string) {
    this.logger.log(
      `📱 [SMS SIMULATION] To: ${phoneNumber} | Message: "${message}"`,
    );

    return {
      provider: 'SIMULATED_SMS',
      success: true,
      to: phoneNumber,
      message,
    };
  }

  async sendEmail(email: string, subject: string, content: string) {
    this.logger.log(
      `📧 [EMAIL SIMULATION] To: ${email} | Subject: "${subject}"`,
    );
    this.logger.log(`   Body: "${content}"`);

    return {
      provider: 'SIMULATED_EMAIL',
      success: true,
      to: email,
      subject,
      content,
    };
  }

  async sendPush(
    userId: number,
    title: string,
    message: string,
    data?: Prisma.InputJsonValue,
  ) {
    const tokens = await this.prisma.pushDeviceToken.findMany({
      where: {
        userId,
        isActive: true,
      },
    });

    this.logger.log(
      `🔔 [PUSH SIMULATION] User: ${userId} | Tokens: ${tokens.length} | Title: "${title}"`,
    );

    return {
      provider: 'SIMULATED_PUSH',
      success: true,
      userId,
      tokenCount: tokens.length,
      title,
      message,
      data,
    };
  }

  // Old compatibility helpers
  async notifyArtisan(artisanPhone: string, jobDescription: string) {
    const msg = `Nouvelle mission disponible: ${jobDescription}. Connectez-vous pour accepter.`;

    return this.sendSms(artisanPhone, msg);
  }

  async notifyClient(clientPhone: string, artisanName: string) {
    const msg = `Bonne nouvelle! ${artisanName} a accepté votre demande et est en route.`;

    return this.sendSms(clientPhone, msg);
  }

  // ==========================================================
  // 3. CORE NOTIFICATION CREATION
  // ==========================================================

  async createNotification(dto: {
    recipientId: number;
    actorId?: number;
    type?: NotificationType;
    priority?: NotificationPriority;
    title: string;
    message: string;
    channels?: NotificationChannel[];
    entityType?: string;
    entityId?: number;
    data?: Prisma.InputJsonValue;
  }) {
    return this.notify({
      recipientId: dto.recipientId,
      actorId: dto.actorId,
      type: dto.type || NotificationType.GENERAL,
      title: dto.title,
      message: dto.message,
      channels: dto.channels,
      priority: dto.priority,
      entityType: dto.entityType,
      entityId: dto.entityId,
      data: dto.data,
    });
  }

  async notify(payload: NotifyPayload) {
    const recipient = await this.prisma.user.findUnique({
      where: {
        id: payload.recipientId,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });

    if (!recipient || !recipient.isActive) {
      return null;
    }

    const preferences = await this.getOrCreatePreferences(payload.recipientId);

    if (!this.eventAllowed(preferences, payload.type)) {
      return null;
    }

    const requestedChannels =
      payload.channels?.length
        ? payload.channels
        : this.defaultChannelsForType(payload.type);

    const allowedChannels = requestedChannels.filter((channel) =>
      this.channelAllowed(preferences, channel),
    );

    if (!allowedChannels.length) {
      return null;
    }

    const notification = await this.prisma.notification.create({
      data: {
        recipientId: payload.recipientId,
        actorId: payload.actorId,
        type: payload.type,
        priority: payload.priority || NotificationPriority.NORMAL,
        title: payload.title,
        message: payload.message,
        channels: allowedChannels,
        entityType: payload.entityType,
        entityId: payload.entityId,
        data: payload.data,
      },
      include: this.notificationInclude,
    });

    await this.deliverNotification(notification);

    return notification;
  }

  private async deliverNotification(notification: any) {
    for (const channel of notification.channels as NotificationChannel[]) {
      try {
        if (channel === NotificationChannel.IN_APP) {
          this.gateway?.emitToUser?.(notification.recipientId, 'notification.new', {
            notification,
          });

          await this.logDelivery({
            notificationId: notification.id,
            userId: notification.recipientId,
            channel,
            status: NotificationDeliveryStatus.SENT,
            provider: 'IN_APP',
            sentAt: new Date(),
          });

          continue;
        }

        if (channel === NotificationChannel.ADMIN_REAL_TIME) {
          this.gateway?.emitToAdmins?.('admin.notification.new', {
            notification,
          });

          await this.logDelivery({
            notificationId: notification.id,
            userId: notification.recipientId,
            channel,
            status: NotificationDeliveryStatus.SENT,
            provider: 'SOCKET_IO',
            sentAt: new Date(),
          });

          continue;
        }

        if (channel === NotificationChannel.EMAIL) {
          const email = notification.recipient.email;

          if (!email) {
            await this.logDelivery({
              notificationId: notification.id,
              userId: notification.recipientId,
              channel,
              status: NotificationDeliveryStatus.SKIPPED,
              provider: 'SIMULATED_EMAIL',
              error: 'No email address.',
            });

            continue;
          }

          await this.sendEmail(email, notification.title, notification.message);

          await this.logDelivery({
            notificationId: notification.id,
            userId: notification.recipientId,
            channel,
            destination: email,
            status: NotificationDeliveryStatus.SENT,
            provider: 'SIMULATED_EMAIL',
            sentAt: new Date(),
          });

          continue;
        }

        if (channel === NotificationChannel.SMS) {
          const phone = notification.recipient.phone;

          if (!phone) {
            await this.logDelivery({
              notificationId: notification.id,
              userId: notification.recipientId,
              channel,
              status: NotificationDeliveryStatus.SKIPPED,
              provider: 'SIMULATED_SMS',
              error: 'No phone number.',
            });

            continue;
          }

          await this.sendSms(phone, notification.message);

          await this.logDelivery({
            notificationId: notification.id,
            userId: notification.recipientId,
            channel,
            destination: phone,
            status: NotificationDeliveryStatus.SENT,
            provider: 'SIMULATED_SMS',
            sentAt: new Date(),
          });

          continue;
        }

        if (channel === NotificationChannel.PUSH) {
          const result = await this.sendPush(
            notification.recipientId,
            notification.title,
            notification.message,
            notification.data,
          );

          await this.logDelivery({
            notificationId: notification.id,
            userId: notification.recipientId,
            channel,
            status:
              result.tokenCount > 0
                ? NotificationDeliveryStatus.SENT
                : NotificationDeliveryStatus.SKIPPED,
            provider: 'SIMULATED_PUSH',
            sentAt: result.tokenCount > 0 ? new Date() : undefined,
            error:
              result.tokenCount > 0
                ? undefined
                : 'No active push token.',
          });
        }
      } catch (error: any) {
        await this.logDelivery({
          notificationId: notification.id,
          userId: notification.recipientId,
          channel,
          status: NotificationDeliveryStatus.FAILED,
          provider: 'INTERNAL',
          error: error?.message || 'Notification delivery failed.',
        });
      }
    }
  }

  // ==========================================================
  // 4. NOTIFICATION CENTER
  // ==========================================================

  async findMine(user: AuthenticatedUser, options?: { unreadOnly?: boolean }) {
    return this.prisma.notification.findMany({
      where: {
        recipientId: user.id,
        deletedAt: null,
        ...(options?.unreadOnly ? { isRead: false } : {}),
      },
      include: {
        deliveries: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findUnread(user: AuthenticatedUser) {
    return this.findMine(user, {
      unreadOnly: true,
    });
  }

  async findRead(user: AuthenticatedUser) {
    return this.prisma.notification.findMany({
      where: {
        recipientId: user.id,
        deletedAt: null,
        isRead: true,
      },
      include: {
        deliveries: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
      orderBy: {
        readAt: 'desc',
      },
    });
  }

  async findOne(user: AuthenticatedUser, notificationId: number) {
    const notification = await this.getNotificationOrFail(notificationId);

    this.checkNotificationOwner(user, notification);

    return notification;
  }

  async markAsRead(user: AuthenticatedUser, notificationId: number) {
    const notification = await this.getNotificationOrFail(notificationId);

    this.checkNotificationOwner(user, notification);

    return this.prisma.notification.update({
      where: {
        id: notificationId,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
      include: this.notificationInclude,
    });
  }

  async markAllAsRead(user: AuthenticatedUser) {
    await this.prisma.notification.updateMany({
      where: {
        recipientId: user.id,
        deletedAt: null,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return {
      success: true,
    };
  }

  async deleteNotification(user: AuthenticatedUser, notificationId: number) {
    const notification = await this.getNotificationOrFail(notificationId);

    this.checkNotificationOwner(user, notification);

    return this.prisma.notification.update({
      where: {
        id: notificationId,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async countUnread(user: AuthenticatedUser) {
    const count = await this.prisma.notification.count({
      where: {
        recipientId: user.id,
        deletedAt: null,
        isRead: false,
      },
    });

    return {
      count,
    };
  }

  // ==========================================================
  // 5. PREFERENCES
  // ==========================================================

  async getMyPreferences(user: AuthenticatedUser) {
    return this.getOrCreatePreferences(user.id);
  }

  async updateMyPreferences(
    user: AuthenticatedUser,
    dto: UpdateNotificationPreferencesDto,
  ) {
    await this.getOrCreatePreferences(user.id);

    return this.prisma.notificationPreference.update({
      where: {
        userId: user.id,
      },
      data: dto,
    });
  }

  // ==========================================================
  // 6. PUSH TOKEN REGISTRATION
  // ==========================================================

  async registerPushToken(user: AuthenticatedUser, dto: RegisterPushTokenDto) {
    return this.prisma.pushDeviceToken.upsert({
      where: {
        token: dto.token,
      },
      update: {
        userId: user.id,
        platform: dto.platform,
        deviceId: dto.deviceId,
        deviceName: dto.deviceName,
        isActive: true,
        lastUsedAt: new Date(),
      },
      create: {
        userId: user.id,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
        deviceName: dto.deviceName,
        isActive: true,
        lastUsedAt: new Date(),
      },
    });
  }

  async deactivatePushToken(user: AuthenticatedUser, token: string) {
    await this.prisma.pushDeviceToken.updateMany({
      where: {
        userId: user.id,
        token,
      },
      data: {
        isActive: false,
      },
    });

    return {
      success: true,
    };
  }

  // ==========================================================
  // 7. ADMIN RECIPIENTS
  // ==========================================================

  private async getAdminUsers() {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        role: {
          in: [
            Role.ADMIN,
            Role.SUPER_ADMIN,
            Role.SUPPORT,
            Role.DISPATCHER,
            Role.ACCOUNTANT,
          ],
        },
      },
    });
  }

  async notifyAdmins(payload: Omit<NotifyPayload, 'recipientId'>) {
    const admins = await this.getAdminUsers();

    const notifications: any[] = [];

    for (const admin of admins) {
      const notification = await this.notify({
        ...payload,
        recipientId: admin.id,
        channels: payload.channels || [
          NotificationChannel.IN_APP,
          NotificationChannel.ADMIN_REAL_TIME,
        ],
      });

      if (notification) {
        notifications.push(notification);
      }
    }

    return notifications;
  }

  // ==========================================================
  // 8. EVENT NOTIFICATION HELPERS
  // ==========================================================

  async notifyNewInterventionCreated(interventionId: number, actorId?: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        client: true,
        subService: true,
      },
    });

    if (!intervention) {
      return null;
    }

    return this.notifyAdmins({
      actorId,
      type: NotificationType.NEW_INTERVENTION_CREATED,
      priority: NotificationPriority.HIGH,
      title: 'Nouvelle intervention créée',
      message: `Nouvelle demande ${intervention.serviceType} à ${intervention.address}.`,
      entityType: 'INTERVENTION',
      entityId: intervention.id,
      data: {
        interventionId: intervention.id,
        serviceType: intervention.serviceType,
        subServiceName: intervention.subService?.name,
      },
    });
  }

  async notifyArtisanAssigned(
    interventionId: number,
    artisanId: number,
    actorId?: number,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        client: true,
        artisan: true,
      },
    });

    if (!intervention) {
      return null;
    }

    await this.notify({
      recipientId: artisanId,
      actorId,
      type: NotificationType.ARTISAN_ASSIGNED,
      priority: NotificationPriority.HIGH,
      title: 'Nouvelle mission assignée',
      message: `Une mission vous a été assignée: ${intervention.address}.`,
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });

    return this.notify({
      recipientId: intervention.clientId,
      actorId,
      type: NotificationType.ARTISAN_ASSIGNED,
      title: 'Artisan assigné',
      message: 'Un artisan a été assigné à votre intervention.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyArtisanAcceptedMission(
    interventionId: number,
    artisanId: number,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      return null;
    }

    await this.notifyAdmins({
      actorId: artisanId,
      type: NotificationType.ARTISAN_ACCEPTED_MISSION,
      title: 'Mission acceptée',
      message: `L’artisan a accepté la mission #${interventionId}.`,
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });

    return this.notify({
      recipientId: intervention.clientId,
      actorId: artisanId,
      type: NotificationType.ARTISAN_ACCEPTED_MISSION,
      title: 'Mission acceptée',
      message: 'L’artisan a accepté votre intervention.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyArtisanOnTheWay(interventionId: number, artisanId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      return null;
    }

    return this.notify({
      recipientId: intervention.clientId,
      actorId: artisanId,
      type: NotificationType.ARTISAN_ON_THE_WAY,
      title: 'Artisan en route',
      message: 'Votre artisan est en route.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyArtisanArrived(interventionId: number, artisanId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      return null;
    }

    return this.notify({
      recipientId: intervention.clientId,
      actorId: artisanId,
      type: NotificationType.ARTISAN_ARRIVED,
      title: 'Artisan arrivé',
      message: 'Votre artisan est arrivé sur place.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyWorkStarted(interventionId: number, artisanId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      return null;
    }

    return this.notify({
      recipientId: intervention.clientId,
      actorId: artisanId,
      type: NotificationType.WORK_STARTED,
      title: 'Travaux commencés',
      message: 'L’intervention a commencé.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyWorkCompleted(interventionId: number, artisanId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      return null;
    }

    await this.notifyAdmins({
      actorId: artisanId,
      type: NotificationType.WORK_COMPLETED,
      title: 'Travaux terminés',
      message: `L’intervention #${interventionId} est terminée.`,
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });

    return this.notify({
      recipientId: intervention.clientId,
      actorId: artisanId,
      type: NotificationType.WORK_COMPLETED,
      title: 'Intervention terminée',
      message: 'L’artisan a terminé l’intervention. Vous pouvez la valider.',
      entityType: 'INTERVENTION',
      entityId: interventionId,
    });
  }

  async notifyQuoteSent(quoteId: number, actorId?: number) {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: {
        intervention: true,
      },
    });

    if (!quote) {
      return null;
    }

    return this.notify({
      recipientId: quote.intervention.clientId,
      actorId,
      type: NotificationType.QUOTE_SENT,
      title: 'Devis reçu',
      message: `Un devis de ${quote.amountTTC} € TTC vous a été envoyé.`,
      entityType: 'QUOTE',
      entityId: quoteId,
      data: {
        quoteId,
        interventionId: quote.interventionId,
        amountTTC: quote.amountTTC,
      },
    });
  }

  async notifyQuoteAccepted(quoteId: number, actorId?: number) {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: {
        intervention: true,
      },
    });

    if (!quote) {
      return null;
    }

    return this.notifyAdmins({
      actorId,
      type: NotificationType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message: `Le client a accepté le devis #${quoteId}.`,
      entityType: 'QUOTE',
      entityId: quoteId,
      data: {
        quoteId,
        interventionId: quote.interventionId,
      },
    });
  }

  async notifyPaymentReceived(paymentId: number, actorId?: number) {
    const payment = await this.prisma.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: {
        intervention: true,
      },
    });

    if (!payment) {
      return null;
    }

    await this.notifyAdmins({
      actorId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: 'Paiement reçu',
      message: `Paiement de ${payment.amount} ${payment.currency} reçu.`,
      entityType: 'PAYMENT',
      entityId: paymentId,
    });

    return this.notify({
      recipientId: payment.intervention.clientId,
      actorId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: 'Paiement confirmé',
      message: `Votre paiement de ${payment.amount} ${payment.currency} a été confirmé.`,
      entityType: 'PAYMENT',
      entityId: paymentId,
    });
  }

  async notifyInvoiceReady(invoiceId: number, actorId?: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
      include: {
        intervention: true,
      },
    });

    if (!invoice) {
      return null;
    }

    return this.notify({
      recipientId: invoice.intervention.clientId,
      actorId,
      type: NotificationType.INVOICE_READY,
      title: 'Facture disponible',
      message: `Votre facture ${invoice.invoiceNumber} est disponible.`,
      entityType: 'INVOICE',
      entityId: invoiceId,
    });
  }

  async notifyComplaintOpened(complaintId: number, actorId?: number) {
    const complaint = await this.prisma.complaint.findUnique({
      where: {
        id: complaintId,
      },
      include: {
        intervention: true,
      },
    });

    if (!complaint) {
      return null;
    }

    return this.notifyAdmins({
      actorId,
      type: NotificationType.COMPLAINT_OPENED,
      priority: NotificationPriority.HIGH,
      title: 'Nouvelle réclamation',
      message: `Une réclamation a été ouverte: ${complaint.title}.`,
      entityType: 'COMPLAINT',
      entityId: complaintId,
    });
  }

  async notifyComplaintUpdated(
    complaintId: number,
    recipientId: number,
    actorId?: number,
  ) {
    const complaint = await this.prisma.complaint.findUnique({
      where: {
        id: complaintId,
      },
    });

    if (!complaint) {
      return null;
    }

    return this.notify({
      recipientId,
      actorId,
      type: NotificationType.COMPLAINT_UPDATED,
      title: 'Réclamation mise à jour',
      message: `Votre réclamation "${complaint.title}" a été mise à jour.`,
      entityType: 'COMPLAINT',
      entityId: complaintId,
    });
  }

  async notifyArtisanApplicationApproved(userId: number, actorId?: number) {
    return this.notify({
      recipientId: userId,
      actorId,
      type: NotificationType.ARTISAN_APPLICATION_APPROVED,
      title: 'Candidature artisan approuvée',
      message: 'Votre candidature artisan a été approuvée.',
      entityType: 'ARTISAN_APPLICATION',
    });
  }

  async notifyArtisanApplicationRejected(
    userId: number,
    reason?: string,
    actorId?: number,
  ) {
    return this.notify({
      recipientId: userId,
      actorId,
      type: NotificationType.ARTISAN_APPLICATION_REJECTED,
      title: 'Candidature artisan refusée',
      message:
        reason ||
        'Votre candidature artisan a été refusée. Vous pouvez contacter le support pour plus d’informations.',
      entityType: 'ARTISAN_APPLICATION',
    });
  }
}