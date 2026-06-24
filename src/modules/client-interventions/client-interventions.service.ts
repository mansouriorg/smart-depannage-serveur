import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientInterventionDto } from './dto/create-client-intervention.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  Status,
  UrgencyLevel,
} from '../../../generated/prisma/client';

@Injectable()
export class ClientInterventionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateTrackingToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');

    return {
      rawToken,
      hashedToken: this.hashToken(rawToken),
    };
  }

  async create(clientId: number, dto: CreateClientInterventionDto) {
    if (dto.savedAddressId) {
      const savedAddress = await this.prisma.clientAddress.findUnique({
        where: { id: dto.savedAddressId },
      });

      if (!savedAddress || savedAddress.clientId !== clientId) {
        throw new ForbiddenException('Adresse sauvegardée invalide.');
      }
    }

    const { rawToken, hashedToken } = this.generateTrackingToken();

    const intervention = await this.prisma.intervention.create({
      data: {
        clientId,
        serviceType: dto.serviceType,
        subServiceId: dto.subServiceId,
        description: dto.description,
        urgency: dto.urgency || UrgencyLevel.NORMAL,
        address: dto.address,
        savedAddressId: dto.savedAddressId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        photos: dto.photos || [],
        preferredDate: dto.preferredDate
          ? new Date(dto.preferredDate)
          : undefined,
        preferredStartTime: dto.preferredStartTime,
        preferredEndTime: dto.preferredEndTime,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        accessInstructions: dto.accessInstructions,
        buildingInfo: dto.buildingInfo,
        floor: dto.floor,
        apartmentCode: dto.apartmentCode,
        status: Status.PENDING,
        trackingToken: hashedToken,
      },
      include: {
        subService: true,
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.REQUEST_CREATED,
      title: 'Demande créée',
      message: 'Votre demande a été enregistrée.',
      createdById: clientId,
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.ADMIN_REVIEWING,
      title: 'En attente de validation',
      message: 'Notre équipe va examiner votre demande.',
    });

    return {
      ...intervention,
      rawTrackingToken: rawToken,
      trackingUrl: `/tracking/${intervention.id}?token=${rawToken}`,
    };
  }

  async findMine(clientId: number) {
    return this.prisma.intervention.findMany({
      where: { clientId },
      include: {
        subService: true,
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        quotes: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        invoice: true,
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneMine(clientId: number, id: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id },
      include: {
        subService: true,
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
        },
        quotes: {
          include: { items: true },
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        invoice: true,
        complaints: {
          orderBy: { createdAt: 'desc' },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  async tracking(clientId: number, id: number) {
    return this.findOneMine(clientId, id);
  }

  async publicTracking(id: number, rawToken: string) {
    const intervention = await this.prisma.intervention.findFirst({
      where: {
        id,
        trackingToken: this.hashToken(rawToken),
      },
      include: {
        subService: true,
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
        },
        quotes: {
          where: {
            status: {
              in: ['SENT', 'ACCEPTED', 'MODIFICATION_REQUESTED'],
            },
          },
          include: { items: true },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        invoice: true,
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Lien de suivi invalide.');
    }

    return intervention;
  }

  async cancel(clientId: number, id: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const updated = await this.prisma.intervention.update({
      where: { id },
      data: {
        status: Status.CANCELLED,
      },
    });

    await this.events.create({
      interventionId: id,
      type: InterventionEventType.CANCELLED,
      title: 'Demande annulée',
      message: 'La demande a été annulée par le client.',
      createdById: clientId,
    });

    return updated;
  }
}