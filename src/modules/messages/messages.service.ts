import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { describeError } from '../notifications/delivery/delivery-error';

import { CreateMessageDto } from './dto/create-message.dto';
import { messageForParties } from '../../common/views/views';

import {
  AdminNoteTargetType,
  MessageAudience,
  Prisma,
  Role,
} from '../../../generated/prisma/client';
import { Permission, can } from '../../common/auth/permissions';

type AdminInternalNoteDto = {
  content: string;
};

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private isStaff(role: Role): boolean {
    return can(role, Permission.BACK_OFFICE_ACCESS);
  }

  /**
   * A message as the person who asked may read it. The back office reads the row as it is; the
   * customer and the artisan get the message without the address of the writer, without the ids of
   * the other readers and without the job's people (P1-08).
   */
  private forReader(userId: number, role: Role, message: any) {
    return this.isStaff(role) ? message : messageForParties(message, userId);
  }

  private getAllowedAudiencesForUser(role: Role): MessageAudience[] {
    if (role === Role.CLIENT) {
      return [
        MessageAudience.CLIENT_ARTISAN,
        MessageAudience.CLIENT_SUPPORT,
      ];
    }

    if (role === Role.ARTISAN) {
      return [
        MessageAudience.CLIENT_ARTISAN,
        MessageAudience.ARTISAN_SUPPORT,
      ];
    }

    if (this.isStaff(role)) {
      return [
        MessageAudience.CLIENT_ARTISAN,
        MessageAudience.CLIENT_SUPPORT,
        MessageAudience.ARTISAN_SUPPORT,
      ];
    }

    return [];
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
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
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

  private checkAudienceAccess(params: {
    userId: number;
    role: Role;
    intervention: {
      clientId: number;
      artisanId: number | null;
    };
    audience: MessageAudience;
  }) {
    const {
      userId,
      role,
      intervention,
      audience,
    } = params;

    if (audience === MessageAudience.INTERNAL_ADMIN) {
      throw new BadRequestException(
        'Les notes internes admin doivent utiliser AdminInternalNote, pas Message.',
      );
    }

    const isClient = intervention.clientId === userId;
    const isArtisan = intervention.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (audience === MessageAudience.CLIENT_ARTISAN) {
      if (isClient || isArtisan || isStaff) {
        return true;
      }

      throw new ForbiddenException('Accès refusé au chat client-artisan.');
    }

    if (audience === MessageAudience.CLIENT_SUPPORT) {
      if (isClient || isStaff) {
        return true;
      }

      throw new ForbiddenException('Accès refusé au chat client-admin.');
    }

    if (audience === MessageAudience.ARTISAN_SUPPORT) {
      if (isArtisan || isStaff) {
        return true;
      }

      throw new ForbiddenException('Accès refusé au chat artisan-admin.');
    }

    throw new ForbiddenException('Audience de message non autorisée.');
  }

  private ensureMessageHasContent(dto: CreateMessageDto) {
    const hasContent = Boolean(dto.content?.trim());
    const hasAttachments = Boolean(dto.attachments?.length);

    if (!hasContent && !hasAttachments) {
      throw new BadRequestException(
        'Le message doit contenir un texte ou au moins une pièce jointe.',
      );
    }
  }

  private normalizeAttachments(attachments?: string[]) {
    if (!attachments?.length) {
      return [];
    }

    return attachments
      .map((attachment) => attachment.trim())
      .filter(Boolean);
  }

  private async getMessageOrFail(messageId: number) {
    const message = await this.prisma.message.findUnique({
      where: {
        id: messageId,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
          },
        },
      },
    });

    if (!message || message.deletedAt) {
      throw new NotFoundException('Message introuvable.');
    }

    return message;
  }

  // ==========================================================
  // 2. CREATE MESSAGE
  // Public chat:
  // CLIENT_ARTISAN
  // CLIENT_SUPPORT
  // ARTISAN_SUPPORT
  // ==========================================================

  async create(
    userId: number,
    role: Role,
    interventionId: number,
    dto: CreateMessageDto,
  ) {
    this.ensureMessageHasContent(dto);

    const intervention = await this.checkInterventionAccess(
      userId,
      role,
      interventionId,
    );

    this.checkAudienceAccess({
      userId,
      role,
      intervention,
      audience: dto.audience,
    });

    const attachments = this.normalizeAttachments(dto.attachments);

    const message = await this.prisma.message.create({
      data: {
        interventionId,
        senderId: userId,
        audience: dto.audience,
        content: dto.content?.trim() || null,
        attachments,
        readByUserIds: [userId],
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
          },
        },
      },
    });

    // The message is saved: a socket or notification problem must not fail the request.
    try {
      await this.realtime.emitNewMessage(message.id);
    } catch (error: any) {
      this.logger.error(`Live delivery of message #${message.id} failed (${describeError(error)})`);
    }

    // One in-app notification for each person in this chat except the sender.
    await this.notifications.notifyNewMessage(message.id);

    return this.forReader(userId, role, message);
  }

  // ==========================================================
  // 3. GET MESSAGES BY INTERVENTION
  // Optional audience filter:
  // CLIENT_ARTISAN / CLIENT_SUPPORT / ARTISAN_SUPPORT
  // ==========================================================

  async findByIntervention(
    userId: number,
    role: Role,
    interventionId: number,
    audience?: MessageAudience,
  ) {
    const intervention = await this.checkInterventionAccess(
      userId,
      role,
      interventionId,
    );

    if (audience) {
      this.checkAudienceAccess({
        userId,
        role,
        intervention,
        audience,
      });
    }

    const allowedAudiences = audience
      ? [audience]
      : this.getAllowedAudiencesForUser(role);

    const messages = await this.prisma.message.findMany({
      where: {
        interventionId,
        audience: {
          in: allowedAudiences,
        },
        deletedAt: null,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return messages.map((message) => this.forReader(userId, role, message));
  }

  // ==========================================================
  // 4. GET ONE MESSAGE
  // ==========================================================

  async findOne(userId: number, role: Role, messageId: number) {
    const message = await this.getMessageOrFail(messageId);

    await this.checkInterventionAccess(
      userId,
      role,
      message.interventionId,
    );

    this.checkAudienceAccess({
      userId,
      role,
      intervention: message.intervention,
      audience: message.audience,
    });

    return this.forReader(userId, role, message);
  }

  // ==========================================================
  // 5. MARK MESSAGE AS READ
  // Real read tracking with readByUserIds
  // ==========================================================

  async markAsRead(userId: number, role: Role, messageId: number) {
    const message = await this.getMessageOrFail(messageId);

    await this.checkInterventionAccess(
      userId,
      role,
      message.interventionId,
    );

    this.checkAudienceAccess({
      userId,
      role,
      intervention: message.intervention,
      audience: message.audience,
    });

    if (message.readByUserIds.includes(userId)) {
      return this.forReader(userId, role, message);
    }

    const readByUserIds = [
      ...message.readByUserIds,
      userId,
    ];

    const updated = await this.prisma.message.update({
      where: {
        id: messageId,
      },
      data: {
        readByUserIds,
        isRead: true,
        readAt: new Date(),
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
          },
        },
      },
    });

    return this.forReader(userId, role, updated);
  }

  // ==========================================================
  // 6. MARK ALL INTERVENTION MESSAGES AS READ
  // ==========================================================

  async markInterventionAsRead(
    userId: number,
    role: Role,
    interventionId: number,
    audience?: MessageAudience,
  ) {
    const intervention = await this.checkInterventionAccess(
      userId,
      role,
      interventionId,
    );

    if (audience) {
      this.checkAudienceAccess({
        userId,
        role,
        intervention,
        audience,
      });
    }

    const allowedAudiences = audience
      ? [audience]
      : this.getAllowedAudiencesForUser(role);

    const unreadMessages = await this.prisma.message.findMany({
      where: {
        interventionId,
        audience: {
          in: allowedAudiences,
        },
        senderId: {
          not: userId,
        },
        deletedAt: null,
        NOT: {
          readByUserIds: {
            has: userId,
          },
        },
      },
    });

    for (const message of unreadMessages) {
      await this.prisma.message.update({
        where: {
          id: message.id,
        },
        data: {
          readByUserIds: [
            ...message.readByUserIds,
            userId,
          ],
          isRead: true,
          readAt: new Date(),
        },
      });
    }

    return {
      success: true,
      interventionId,
      markedAsRead: unreadMessages.length,
    };
  }

  // ==========================================================
  // 7. UNREAD COUNTERS
  // ==========================================================

  private unreadBaseWhere(
    userId: number,
    role: Role,
    interventionId?: number,
  ): Prisma.MessageWhereInput {
    const allowedAudiences = this.getAllowedAudiencesForUser(role);

    const baseWhere: Prisma.MessageWhereInput = {
      deletedAt: null,
      senderId: {
        not: userId,
      },
      audience: {
        in: allowedAudiences,
      },
      NOT: {
        readByUserIds: {
          has: userId,
        },
      },
      ...(interventionId ? { interventionId } : {}),
    };

    if (this.isStaff(role)) {
      return baseWhere;
    }

    if (role === Role.CLIENT) {
      return {
        ...baseWhere,
        intervention: {
          clientId: userId,
        },
      };
    }

    if (role === Role.ARTISAN) {
      return {
        ...baseWhere,
        intervention: {
          artisanId: userId,
        },
      };
    }

    return {
      id: -1,
    };
  }

  async countUnread(userId: number, role: Role) {
    const allowed = this.getAllowedAudiencesForUser(role);

    const total = await this.prisma.message.count({
      where: this.unreadBaseWhere(userId, role),
    });

    // Only the chats this role is part of are counted. A count for another chat
    // (support messages for the artisan, say) would still tell the reader that
    // such messages exist, so it is a flat 0 and no query is made.
    const countFor = async (audience: MessageAudience) =>
      allowed.includes(audience)
        ? this.prisma.message.count({
            where: {
              ...this.unreadBaseWhere(userId, role),
              audience,
            },
          })
        : 0;

    return {
      total,
      byAudience: {
        CLIENT_ARTISAN: await countFor(MessageAudience.CLIENT_ARTISAN),
        CLIENT_SUPPORT: await countFor(MessageAudience.CLIENT_SUPPORT),
        ARTISAN_SUPPORT: await countFor(MessageAudience.ARTISAN_SUPPORT),
      },
    };
  }

  async countUnreadForIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    const total = await this.prisma.message.count({
      where: this.unreadBaseWhere(userId, role, interventionId),
    });

    return {
      interventionId,
      total,
    };
  }

  // ==========================================================
  // 8. DELETE MESSAGE
  // Soft delete
  // ==========================================================

  async remove(userId: number, role: Role, messageId: number) {
    const message = await this.getMessageOrFail(messageId);

    const isSender = message.senderId === userId;
    const isStaff = this.isStaff(role);

    if (!isSender && !isStaff) {
      throw new ForbiddenException(
        'Vous ne pouvez supprimer que vos propres messages.',
      );
    }

    const removed = await this.prisma.message.update({
      where: {
        id: messageId,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return this.forReader(userId, role, removed);
  }

  async deleteMessage(userId: number, role: Role, messageId: number) {
    return this.remove(userId, role, messageId);
  }

  // ==========================================================
  // 9. ADMIN INTERNAL NOTES
  // Separate from public chat
  // Never visible in public message routes
  // ==========================================================

  async createInternalNote(
    userId: number,
    role: Role,
    interventionId: number,
    dto: AdminInternalNoteDto,
  ) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException(
        'Seule l’administration peut créer une note interne.',
      );
    }

    await this.getInterventionOrFail(interventionId);

    if (!dto.content?.trim()) {
      throw new BadRequestException('La note interne ne peut pas être vide.');
    }

    return this.prisma.adminInternalNote.create({
      data: {
        targetType: AdminNoteTargetType.INTERVENTION,
        targetId: interventionId,
        authorId: userId,
        content: dto.content.trim(),
      },
    });
  }

  async findInternalNotesByIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException(
        'Seule l’administration peut consulter les notes internes.',
      );
    }

    await this.getInterventionOrFail(interventionId);

    return this.prisma.adminInternalNote.findMany({
      where: {
        targetType: AdminNoteTargetType.INTERVENTION,
        targetId: interventionId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async deleteInternalNote(userId: number, role: Role, noteId: number) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException(
        'Seule l’administration peut supprimer une note interne.',
      );
    }

    const note = await this.prisma.adminInternalNote.findUnique({
      where: {
        id: noteId,
      },
    });

    if (!note || note.deletedAt) {
      throw new NotFoundException('Note interne introuvable.');
    }

    return this.prisma.adminInternalNote.update({
      where: {
        id: noteId,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
