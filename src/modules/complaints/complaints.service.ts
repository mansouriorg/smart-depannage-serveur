import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  async create(
    clientId: number,
    interventionId: number,
    dto: CreateComplaintDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const complaint = await this.prisma.complaint.create({
      data: {
        interventionId,
        userId: clientId,
        title: dto.title,
        description: dto.description,
        refundRequested: dto.refundRequested || false,
        attachments: dto.attachments || [],
      },
    });

    await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        hasIssue: true,
        status: Status.DISPUTED,
      },
    });

    await this.events.create({
      interventionId,
      type: InterventionEventType.COMPLAINT_OPENED,
      title: 'Réclamation ouverte',
      message: dto.title,
      createdById: clientId,
    });

    return complaint;
  }

  async findMine(clientId: number) {
    return this.prisma.complaint.findMany({
      where: { userId: clientId },
      include: {
        intervention: {
          select: {
            id: true,
            serviceType: true,
            address: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findAllAdmin(status?: string) {
    return this.prisma.complaint.findMany({
      where: status ? { status: status as any } : {},
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        intervention: {
          select: {
            id: true,
            serviceType: true,
            address: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async updateStatus(id: number, dto: UpdateComplaintStatusDto) {
    return this.prisma.complaint.update({
      where: { id },
      data: {
        status: dto.status,
        adminNotes: dto.adminNotes,
      },
    });
  }
}