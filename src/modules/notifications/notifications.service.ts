import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';

import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import {
  RegisterPushTokenDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
import { messageRecipients } from '../messages/message-audience';
import { OutboxService } from './delivery/outbox.service';
import { MessageTemplatesService } from './delivery/message-templates.service';
import { flattenVars } from './delivery/render-template';
import { isDeliverableEmail } from './delivery/contact';
import { describeError } from './delivery/delivery-error';

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

const ALL_ADMIN_ROLES: Role[] = [
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.SUPPORT,
  Role.DISPATCHER,
  Role.ACCOUNTANT,
];

/** Who handles what: money for the accountant, disputes and chats for support. */
const MONEY_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT];
const SUPPORT_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT];
const DISPATCH_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER, Role.SUPPORT];

/** The only roles that may look at, list or edit other people's notifications. */
const AUDIT_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN];

/** What the callers of sendSms / sendEmail / sendPush can add. */
export type SendOptions = {
  userId?: number;
  /**
   * Wording kept in the NotificationTemplate table. The text given by the
   * caller is the fallback when no active template exists for the key.
   */
  template?: {
    key: string;
    vars?: Record<string, string | number | boolean | null | undefined>;
  };
  /**
   * How long the message is still worth sending (a code or link that expires
   * in 10 minutes is no use after 10 minutes, e.g. when the gateway was down).
   */
  validForMs?: number;
  /**
   * A newer message with the same key cancels the older ones that have not
   * left yet (asking three times for a code results in one SMS, not three).
   */
  replaces?: string;
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

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,

    // Required on purpose: while this was @Optional() and the gateway was not
    // provided, no notification ever reached a socket and nothing said so.
    private readonly gateway: NotificationsGateway,

    // E-mail, SMS and push leave through the outbox (P1-03).
    private readonly outbox: OutboxService,
    private readonly templates: MessageTemplatesService,
  ) {}

  // ==========================================================
  // Includes
  // ==========================================================

  // Back office view (admin / super admin): who it went to, how it was delivered.
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

  // What the person a notification is for gets to see: no recipient record, no
  // delivery log (destinations, provider errors), and no e-mail address of the
  // person who triggered it (a client must not receive a staff member's e-mail).
  private recipientInclude: Prisma.NotificationInclude = {
    actor: {
      select: {
        id: true,
        name: true,
        role: true,
      },
    },
  };

  private forRecipient(notification: any) {
    const { recipient, deliveries, actor, ...rest } = notification;

    return {
      ...rest,
      actor: actor ? { id: actor.id, name: actor.name, role: actor.role } : null,
    };
  }

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
    // upsert, not find-then-create: two notifications for a user who has no
    // preferences yet (a payment confirmed while a message arrives) used to
    // race on the unique userId, and the loser's notification was lost.
    return this.prisma.notificationPreference.upsert({
      where: {
        userId,
      },
      update: {},
      create: {
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

  /**
   * Reading: the recipient, or an admin / super admin. The text of a
   * notification can quote a chat (a message preview), so the other back-office
   * roles do not get to browse other people's notifications by id.
   */
  private checkNotificationOwner(
    user: AuthenticatedUser,
    notification: { recipientId: number },
  ) {
    if (notification.recipientId !== user.id && !AUDIT_ROLES.includes(user.role)) {
      throw new ForbiddenException('Accès refusé.');
    }
  }

  /**
   * Changing: only the recipient. Every admin has their own copy of a
   * notification with their own read state, so one admin cannot mark another
   * admin's copy as read or delete it.
   */
  private checkNotificationRecipient(
    user: AuthenticatedUser,
    notification: { recipientId: number },
  ) {
    if (notification.recipientId !== user.id) {
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

  async create(createNotificationDto: CreateNotificationDto, user: AuthenticatedUser) {
    const dto = createNotificationDto;

    const notification = await this.createNotification({
      recipientId: dto.recipientId,
      // Always the caller: the body cannot make a notification look like it
      // came from somebody else (or from a user id that does not exist).
      actorId: user.id,
      type: dto.type,
      priority: dto.priority,
      title: dto.title,
      message: dto.message,
      channels: dto.channels,
      entityType: dto.entityType,
      entityId: dto.entityId,
      data: dto.data as Prisma.InputJsonValue | undefined,
    });

    // notify() answers null when the recipient is unknown or inactive, or has
    // turned every channel of this kind off. Say so instead of returning an empty 201.
    if (!notification) {
      throw new NotFoundException(
        'Notification non créée: destinataire introuvable ou inactif, ou notifications désactivées.',
      );
    }

    return notification;
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
      // Back-office overview: the most recent ones, not the whole history.
      take: 500,
    });
  }

  async findOneById(id: number) {
    return this.getNotificationOrFail(id);
  }

  /**
   * Correcting a notification: the admin who sent it, or a super admin. The
   * read state belongs to the recipient, so nobody else can change it here.
   */
  async update(
    user: AuthenticatedUser,
    id: number,
    updateNotificationDto: UpdateNotificationDto,
  ) {
    const existing = await this.getNotificationOrFail(id);

    if (existing.actorId !== user.id && user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Accès refusé.');
    }

    const dto = updateNotificationDto;

    if (dto.isRead !== undefined && existing.recipientId !== user.id) {
      throw new ForbiddenException(
        "Seul le destinataire peut changer l'état de lecture.",
      );
    }

    return this.prisma.notification.update({
      where: {
        id,
      },
      data: {
        title: dto.title,
        message: dto.message,
        priority: dto.priority,
        channels: dto.channels,
        entityType: dto.entityType,
        entityId: dto.entityId,
        data: dto.data as Prisma.InputJsonValue | undefined,
        isRead: dto.isRead,
        readAt: dto.isRead === true ? new Date() : dto.isRead === false ? null : undefined,
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
  // 2. DELIVERY CHANNELS (P1-03)
  // Each call writes a row in the outbox and returns: the worker sends it and
  // retries. A message can carry a one-time code or link, so its text is never
  // logged and is erased from the outbox once sent (see OutboxService).
  // ==========================================================

  /** True while no mail server is configured: flows that need the user to receive a link hand it to staff instead. */
  isEmailSimulated(): boolean {
    return !this.outbox.isEmailConfigured();
  }

  isSmsSimulated(): boolean {
    return !this.outbox.isSmsConfigured();
  }

  /** Never throws: a message problem must not break (or reveal anything about) the request that caused it. */
  private async queue(
    channel: 'EMAIL' | 'SMS' | 'PUSH',
    input: {
      recipient?: string;
      subject?: string;
      body: string;
      data?: unknown;
      userId?: number;
      notificationId?: number;
      deliveryLogId?: number;
      expiresAt?: Date;
      supersedeKey?: string;
    },
  ) {
    try {
      const row = await this.outbox.enqueue({ channel, ...input });

      return {
        queued: true,
        outboxId: row.id,
        provider: this.outbox.providerName(channel),
      };
    } catch (error: any) {
      // Only the kind of error: a database error can repeat the message it failed to store.
      this.logger.error(`${channel} message could not be queued (${describeError(error)})`);

      return { queued: false, outboxId: undefined, provider: this.outbox.providerName(channel) };
    }
  }

  async sendSms(phoneNumber: string, message: string, options?: SendOptions) {
    const rendered = options?.template
      ? await this.templates.render(options.template.key, 'SMS', options.template.vars ?? {}, {
          content: message,
        })
      : { content: message };

    return this.queue('SMS', {
      recipient: phoneNumber,
      body: rendered.content,
      userId: options?.userId,
      ...this.lifetime(options),
    });
  }

  async sendEmail(email: string, subject: string, content: string, options?: SendOptions) {
    const rendered = options?.template
      ? await this.templates.render(options.template.key, 'EMAIL', options.template.vars ?? {}, {
          subject,
          content,
        })
      : { subject, content };

    return this.queue('EMAIL', {
      recipient: email,
      subject: rendered.subject ?? subject,
      body: rendered.content,
      userId: options?.userId,
      ...this.lifetime(options),
    });
  }

  /**
   * Admin check: one test message to the caller's own address, number or
   * devices. Says plainly when the channel is not set up.
   */
  async testDelivery(user: AuthenticatedUser, channel: 'EMAIL' | 'SMS' | 'PUSH') {
    const me = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { email: true, phone: true },
    });

    if (!me) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    const text = "Smart Dépannage: message de test. Si vous le lisez, cette voie d'envoi fonctionne.";

    if (channel === 'EMAIL') {
      if (this.isEmailSimulated()) {
        throw new BadRequestException("L'envoi d'e-mails n'est pas configuré sur le serveur (SMTP_HOST).");
      }

      if (!isDeliverableEmail(me.email)) {
        throw new BadRequestException("Votre compte n'a pas d'adresse e-mail valide.");
      }

      return this.queue('EMAIL', {
        recipient: me.email,
        subject: 'Smart Dépannage: message de test',
        body: text,
        userId: user.id,
      });
    }

    if (channel === 'SMS') {
      if (this.isSmsSimulated()) {
        throw new BadRequestException("L'envoi de SMS n'est pas configuré sur le serveur (SMS_PROVIDER).");
      }

      if (!me.phone) {
        throw new BadRequestException("Votre compte n'a pas de numéro de téléphone.");
      }

      return this.queue('SMS', { recipient: me.phone, body: text, userId: user.id });
    }

    if (!this.outbox.isPushConfigured()) {
      throw new BadRequestException("L'envoi de notifications push n'est pas configuré sur le serveur (PUSH_PROVIDER).");
    }

    return this.queue('PUSH', { userId: user.id, subject: 'Smart Dépannage', body: text });
  }

  /** What became of a queued message. Never the text, never the address. */
  async outboxStatus(outboxId: number) {
    const row = await this.prisma.notificationOutbox.findUnique({
      where: { id: outboxId },
      select: {
        id: true,
        channel: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        nextAttemptAt: true,
        expiresAt: true,
        provider: true,
        providerMessageId: true,
        lastError: true,
        sentAt: true,
        createdAt: true,
      },
    });

    if (!row) {
      throw new NotFoundException('Message introuvable.');
    }

    return row;
  }

  private lifetime(options?: SendOptions) {
    return {
      ...(options?.validForMs ? { expiresAt: new Date(Date.now() + options.validForMs) } : {}),
      ...(options?.replaces ? { supersedeKey: options.replaces } : {}),
    };
  }

  /** After an admin edits or deletes a message template, the next message uses the new wording at once. */
  clearTemplateCache() {
    this.templates.clearCache();
  }

  async sendPush(
    userId: number,
    title: string,
    message: string,
    data?: Prisma.InputJsonValue,
  ) {
    return this.queue('PUSH', { userId, subject: title, body: message, data });
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
    const channels = notification.channels as NotificationChannel[];

    // The live (socket) copy goes to the recipient's own room, once, even when
    // both IN_APP and ADMIN_REAL_TIME are asked for. Each admin has their own
    // notification row, so each admin gets exactly one event for their own copy.
    let liveSent = false;

    const emitLive = () => {
      if (liveSent) return;
      liveSent = true;

      try {
        this.gateway?.emitToUser(notification.recipientId, 'notification.new', {
          notification: this.forRecipient(notification),
        });
      } catch (error: any) {
        this.logger.warn(
          `Live delivery of notification #${notification.id} failed (${describeError(error)})`,
        );
      }
    };

    for (const channel of channels) {
      try {
        if (channel === NotificationChannel.IN_APP) {
          emitLive();

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
          emitLive();

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

        if (
          channel === NotificationChannel.EMAIL ||
          channel === NotificationChannel.SMS ||
          channel === NotificationChannel.PUSH
        ) {
          await this.queueNotificationChannel(notification, channel);

          continue;
        }
      } catch (error: any) {
        await this.logDelivery({
          notificationId: notification.id,
          userId: notification.recipientId,
          channel,
          status: NotificationDeliveryStatus.FAILED,
          provider: 'INTERNAL',
          // Kind of error only: it can come from a failed write that repeats the message.
          error: `Notification delivery failed (${describeError(error)}).`,
        });
      }
    }
  }

  /**
   * E-mail, SMS and push of a notification: the wording comes from the
   * NotificationTemplate "<TYPE>.<CHANNEL>" when there is one, the delivery log
   * starts as PENDING, and the outbox updates it when the message is sent.
   */
  private async queueNotificationChannel(
    notification: any,
    channel: 'EMAIL' | 'SMS' | 'PUSH',
  ) {
    const recipient = notification.recipient;

    const destination =
      channel === NotificationChannel.EMAIL
        ? recipient?.email
        : channel === NotificationChannel.SMS
          ? recipient?.phone
          : undefined;

    if (channel !== NotificationChannel.PUSH && !destination) {
      await this.logDelivery({
        notificationId: notification.id,
        userId: notification.recipientId,
        channel,
        status: NotificationDeliveryStatus.SKIPPED,
        provider: 'OUTBOX',
        error: channel === NotificationChannel.EMAIL ? 'No email address.' : 'No phone number.',
      });

      return;
    }

    // A guest has no mailbox: the table needs an address, so one is made up
    // ("guest_<id>@guest.smart-depannage.local"). Mail to it can only bounce.
    if (channel === NotificationChannel.EMAIL && !isDeliverableEmail(destination)) {
      await this.logDelivery({
        notificationId: notification.id,
        userId: notification.recipientId,
        channel,
        status: NotificationDeliveryStatus.SKIPPED,
        provider: 'OUTBOX',
        error: 'This address cannot receive e-mail (placeholder address).',
      });

      await this.fallbackToSms(notification);

      return;
    }

    const rendered = await this.templates.render(
      `${notification.type}.${channel}`,
      channel,
      {
        title: notification.title,
        message: notification.message,
        recipientName: recipient?.name,
        entityType: notification.entityType,
        entityId: notification.entityId,
        ...flattenVars(notification.data),
      },
      { subject: notification.title, content: notification.message },
    );

    const log = await this.logDelivery({
      notificationId: notification.id,
      userId: notification.recipientId,
      channel,
      status: NotificationDeliveryStatus.PENDING,
      destination: destination ?? undefined,
      provider: 'OUTBOX',
    });

    try {
      await this.outbox.enqueue({
        channel,
        userId: notification.recipientId,
        recipient: destination ?? undefined,
        subject: rendered.subject ?? notification.title,
        body: rendered.content,
        data: channel === NotificationChannel.PUSH ? notification.data : undefined,
        notificationId: notification.id,
        deliveryLogId: log.id,
      });
    } catch (error: any) {
      // Nothing was queued, so nothing will ever update this log: close it now
      // instead of leaving a PENDING row that looks like a message in flight.
      this.logger.error(
        `${channel} of notification #${notification.id} could not be queued (${describeError(error)})`,
      );

      try {
        await this.prisma.notificationDeliveryLog.update({
          where: { id: log.id },
          data: {
            status: NotificationDeliveryStatus.FAILED,
            error: `Could not be queued (${describeError(error)}).`,
          },
        });
      } catch {
        // The database is having a bad moment; the error is in the log above.
      }
    }
  }

  /**
   * The e-mail of a notification had nowhere to go (a guest). If the person
   * has a phone, and neither they nor the notification say no to SMS, the text
   * goes there instead, so a guest still hears about their quote.
   */
  private async fallbackToSms(notification: any) {
    const channels = (notification.channels ?? []) as NotificationChannel[];

    if (channels.includes(NotificationChannel.SMS) || !notification.recipient?.phone) {
      return;
    }

    const preferences = await this.getOrCreatePreferences(notification.recipientId);

    if (!this.channelAllowed(preferences, NotificationChannel.SMS)) {
      return;
    }

    await this.queueNotificationChannel(notification, NotificationChannel.SMS as 'SMS');
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
      // No delivery logs here: they hold provider errors and destinations that
      // the person reading their notifications has no use for.
      orderBy: {
        createdAt: 'desc',
      },
      take: 200,
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
      orderBy: {
        readAt: 'desc',
      },
      take: 200,
    });
  }

  async findOne(user: AuthenticatedUser, notificationId: number) {
    const notification = await this.getNotificationOrFail(notificationId);

    this.checkNotificationOwner(user, notification);

    // An admin looking at someone else's notification gets the back office view
    // (recipient, delivery log); everybody else gets their own plain view.
    return notification.recipientId !== user.id ? notification : this.forRecipient(notification);
  }

  async markAsRead(user: AuthenticatedUser, notificationId: number) {
    const notification = await this.getNotificationOrFail(notificationId);

    this.checkNotificationRecipient(user, notification);

    return this.prisma.notification.update({
      where: {
        id: notificationId,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
      include: this.recipientInclude,
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

    this.checkNotificationRecipient(user, notification);

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

  private async getAdminUsers(roles: Role[] = ALL_ADMIN_ROLES) {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        role: {
          in: roles,
        },
      },
      select: {
        id: true,
        role: true,
      },
    });
  }

  /**
   * One notification per admin, each with its own id and read state, sent live
   * to that admin only. `roles` narrows who is concerned (payments go to the
   * accountant, complaints to support...). The person who did the action is
   * not told about it. One admin failing does not stop the others.
   */
  async notifyAdmins(
    payload: Omit<NotifyPayload, 'recipientId'> & { roles?: Role[] },
  ) {
    const { roles, ...rest } = payload;
    const admins = await this.getAdminUsers(roles);

    // All admins at once: the request that caused this waits for the slowest
    // one, not for the sum of them.
    const results = await Promise.all(
      admins
        .filter((admin) => rest.actorId === undefined || admin.id !== rest.actorId)
        .map(async (admin) => {
          try {
            return await this.notify({
              ...rest,
              recipientId: admin.id,
              channels: rest.channels || [
                NotificationChannel.IN_APP,
                NotificationChannel.ADMIN_REAL_TIME,
              ],
            });
          } catch (error: any) {
            this.logger.error(
              `Notification for admin #${admin.id} failed (${describeError(error)})`,
            );
            return null;
          }
        }),
    );

    return results.filter((notification) => notification !== null);
  }

  /** A notification problem must never undo or break the action that caused it. */
  private async guarded<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error: any) {
      // Kind of error only: a failed write can repeat the text it was saving.
      this.logger.error(`Notification "${label}" failed (${describeError(error)})`);
      return null;
    }
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

  async notifyQuoteSent(
    quoteId: number,
    actorId?: number,
    channels?: NotificationChannel[],
  ) {
    return this.guarded('quote sent', async () => {
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
        channels,
        entityType: 'QUOTE',
        entityId: quoteId,
        data: {
          quoteId,
          interventionId: quote.interventionId,
          amountTTC: quote.amountTTC,
        },
      });
    });
  }

  async notifyQuoteAccepted(quoteId: number, actorId?: number) {
    return this.guarded('quote accepted', async () => {
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

      const payload = {
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
      };

      const notifications: any[] = await this.notifyAdmins({
        ...payload,
        roles: DISPATCH_ROLES,
      });

      // The artisan on the job is waiting for exactly this answer.
      const artisanId = quote.intervention?.artisanId;

      if (artisanId && artisanId !== actorId) {
        const toArtisan = await this.notify({ ...payload, recipientId: artisanId });

        if (toArtisan) {
          notifications.push(toArtisan);
        }
      }

      return notifications;
    });
  }

  async notifyPaymentReceived(paymentId: number, actorId?: number) {
    return this.guarded('payment received', async () => {
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
        roles: MONEY_ROLES,
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Paiement reçu',
        message: `Paiement de ${payment.amount} ${payment.currency} reçu.`,
        entityType: 'PAYMENT',
        entityId: paymentId,
        data: {
          paymentId,
          interventionId: payment.interventionId,
        },
      });

      return this.notify({
        recipientId: payment.intervention.clientId,
        actorId,
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Paiement confirmé',
        message: `Votre paiement de ${payment.amount} ${payment.currency} a été confirmé.`,
        entityType: 'PAYMENT',
        entityId: paymentId,
        data: {
          paymentId,
          interventionId: payment.interventionId,
        },
      });
    });
  }

  async notifyInvoiceReady(invoiceId: number, actorId?: number) {
    return this.guarded('invoice ready', async () => {
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
        data: {
          invoiceId,
          interventionId: invoice.interventionId,
        },
      });
    });
  }

  async notifyComplaintOpened(complaintId: number, actorId?: number) {
    return this.guarded('complaint opened', async () => {
      const complaint = await this.prisma.complaint.findUnique({
        where: {
          id: complaintId,
        },
      });

      if (!complaint) {
        return null;
      }

      return this.notifyAdmins({
        actorId,
        roles: SUPPORT_ROLES,
        type: NotificationType.COMPLAINT_OPENED,
        priority: NotificationPriority.HIGH,
        title: 'Nouvelle réclamation',
        message: `Une réclamation a été ouverte: ${complaint.title}.`,
        entityType: 'COMPLAINT',
        entityId: complaintId,
        data: {
          complaintId,
          interventionId: complaint.interventionId,
        },
      });
    });
  }

  /** The back office moved a complaint forward: tell the person who filed it. */
  async notifyComplaintUpdated(
    complaintId: number,
    recipientId: number,
    actorId?: number,
  ) {
    return this.guarded('complaint updated', async () => {
      const complaint = await this.prisma.complaint.findUnique({
        where: {
          id: complaintId,
        },
      });

      if (!complaint || recipientId === actorId) {
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
        data: {
          complaintId,
          interventionId: complaint.interventionId,
        },
      });
    });
  }

  /** The customer or the artisan wrote on a complaint: tell whoever handles it. */
  async notifyComplaintReply(complaintId: number, actorId?: number) {
    return this.guarded('complaint reply', async () => {
      const complaint = await this.prisma.complaint.findUnique({
        where: {
          id: complaintId,
        },
        include: {
          intervention: {
            select: {
              artisanId: true,
            },
          },
        },
      });

      if (!complaint) {
        return null;
      }

      const payload = {
        actorId,
        type: NotificationType.COMPLAINT_UPDATED,
        title: 'Nouveau message sur une réclamation',
        message: `Nouveau message sur la réclamation "${complaint.title}".`,
        entityType: 'COMPLAINT',
        entityId: complaintId,
        data: {
          complaintId,
          interventionId: complaint.interventionId,
        },
      };

      const notifications: any[] = [];

      // The other side of the dispute is waiting for this answer: the customer
      // wrote, so the artisan is told, and the other way round.
      const artisanId = complaint.intervention?.artisanId ?? null;
      const otherSide =
        actorId !== undefined && actorId === complaint.userId
          ? artisanId
          : actorId !== undefined && actorId === artisanId
            ? complaint.userId
            : null;

      if (otherSide) {
        const toOtherSide = await this.notify({ ...payload, recipientId: otherSide });

        if (toOtherSide) {
          notifications.push(toOtherSide);
        }
      }

      // The back office: the person it is assigned to (if they are still
      // active), or the whole support team when nobody has it.
      const assignee = complaint.assignedToId
        ? await this.prisma.user.findUnique({
            where: { id: complaint.assignedToId },
            select: { isActive: true },
          })
        : null;

      if (complaint.assignedToId && assignee?.isActive) {
        if (complaint.assignedToId !== actorId) {
          const assigned = await this.notify({
            ...payload,
            recipientId: complaint.assignedToId,
            channels: [NotificationChannel.IN_APP, NotificationChannel.ADMIN_REAL_TIME],
          });

          if (assigned) {
            notifications.push(assigned);
          }
        }

        return notifications;
      }

      notifications.push(...(await this.notifyAdmins({ ...payload, roles: SUPPORT_ROLES })));

      return notifications;
    });
  }

  async notifyComplaintAssigned(
    complaintId: number,
    assigneeId: number,
    actorId?: number,
  ) {
    return this.guarded('complaint assigned', async () => {
      const complaint = await this.prisma.complaint.findUnique({
        where: {
          id: complaintId,
        },
      });

      if (!complaint || assigneeId === actorId) {
        return null;
      }

      return this.notify({
        recipientId: assigneeId,
        actorId,
        type: NotificationType.COMPLAINT_UPDATED,
        priority: NotificationPriority.HIGH,
        title: 'Réclamation assignée',
        message: `La réclamation "${complaint.title}" vous a été assignée.`,
        entityType: 'COMPLAINT',
        entityId: complaintId,
        data: {
          complaintId,
          interventionId: complaint.interventionId,
        },
        channels: [NotificationChannel.IN_APP, NotificationChannel.ADMIN_REAL_TIME],
      });
    });
  }

  /**
   * A new chat message: one in-app notification for each person in that chat
   * except the sender (see message-audience.ts for who is in which chat).
   */
  async notifyNewMessage(messageId: number) {
    return this.guarded('new message', async () => {
      const message = await this.prisma.message.findUnique({
        where: {
          id: messageId,
        },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              role: true,
            },
          },
          intervention: {
            select: {
              id: true,
              clientId: true,
              artisanId: true,
            },
          },
        },
      });

      if (!message || message.deletedAt) {
        return [];
      }

      const targets = messageRecipients({
        audience: message.audience,
        senderId: message.senderId,
        senderIsSupport: this.isAdminRole(message.sender.role),
        clientId: message.intervention.clientId,
        artisanId: message.intervention.artisanId,
      });

      const text = (message.content ?? '').trim().slice(0, 140) || 'Pièce jointe';
      const from = message.sender.name ? `${message.sender.name}: ` : '';

      const base = {
        actorId: message.senderId,
        type: NotificationType.GENERAL,
        title: `Nouveau message (demande #${message.interventionId})`,
        message: `${from}${text}`,
        entityType: 'MESSAGE',
        entityId: message.id,
        data: {
          messageId: message.id,
          interventionId: message.interventionId,
          audience: message.audience,
        },
      };

      const created: any[] = [];

      for (const recipientId of [targets.clientId, targets.artisanId]) {
        if (recipientId === null) continue;

        const notification = await this.notify({
          ...base,
          recipientId,
          channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        });

        if (notification) created.push(notification);
      }

      if (targets.support) {
        created.push(...(await this.notifyAdmins({ ...base, roles: SUPPORT_ROLES })));
      }

      return created;
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
