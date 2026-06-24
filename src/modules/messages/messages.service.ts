import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';

import { Role } from '../../../generated/prisma/client';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private isStaff(role: Role): boolean {
    const staffRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
    ];

    return staffRoles.includes(role);
  }

  private async checkInterventionAccess(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const isClient = intervention.clientId === userId;
    const isArtisan = intervention.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  // ==========================================================
  // 2. CREATE MESSAGE
  // Chat client/artisan/support/admin
  // ==========================================================

  async create(
    userId: number,
    role: Role,
    interventionId: number,
    dto: CreateMessageDto,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    return this.prisma.message.create({
      data: {
        interventionId,
        senderId: userId,
        audience: dto.audience,
        content: dto.content,
        attachments: dto.attachments || [],
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
    });
  }

  // ==========================================================
  // 3. GET MESSAGES BY INTERVENTION
  // ==========================================================

  async findByIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    return this.prisma.message.findMany({
      where: {
        interventionId,
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
  }

  // ==========================================================
  // 4. MARK MESSAGE AS READ
  // Optional but useful for chat
  // ==========================================================

  async markAsRead(userId: number, role: Role, messageId: number) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        intervention: true,
      },
    });

    if (!message) {
      throw new NotFoundException('Message introuvable.');
    }

    await this.checkInterventionAccess(
      userId,
      role,
      message.interventionId,
    );

    return this.prisma.message.update({
      where: { id: messageId },
      data: {
        isRead: true,
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
    });
  }
}