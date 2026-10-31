import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientInterventionDto } from './dto/create-client-intervention.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { StaffAlertsService } from '../interventions/staff-alerts.service';
import { buildTrackingUrl } from '../../common/links/tracking-url';
import { describeError } from '../notifications/delivery/delivery-error';
import { initialStatus } from '../intervention-workflow/intervention-status';
import { checkRequestedService } from '../service-catalog/catalog-check';
import { chatsOf, interventionForClient } from '../../common/views/views';
import { INVOICES_OF_JOB, INVOICES_OF_JOB_WITH_LINES } from '../invoices/invoice-includes';
import { transitionStatusDetailed } from '../intervention-workflow/transition-status';
import { cancelVisit } from '../assignment/appointment-release';
import { lockJob } from '../assignment/artisan-lock';
import {
  InterventionEventType,
  Status,
  UrgencyLevel,
} from '../../../generated/prisma/client';

@Injectable()
export class ClientInterventionsService {
  private readonly logger = new Logger(ClientInterventionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
    private readonly staffAlerts: StaffAlertsService,
  ) {}

  private hashToken(token: string): string {
    // A link that was not sent at all hashes like an empty one, which no job has: "not found", not a crash (P1-17).
    return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
  }

  private generateTrackingToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');

    return {
      rawToken,
      hashedToken: this.hashToken(rawToken),
    };
  }

  private async recordEvent(event: Parameters<InterventionEventsService['create']>[0]) {
    try {
      await this.events.create(event);
    } catch (error: any) {
      this.logger.warn(`Timeline line not written (${describeError(error)})`);
    }
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

    // The sub-service exists, is on offer and belongs to the trade asked for (P1-10). Its photos
    // cannot be required here: a picture can only be uploaded once the request exists, so the
    // answer says whether some are expected.
    const service = await checkRequestedService(this.prisma, {
      serviceType: dto.serviceType,
      subServiceId: dto.subServiceId,
    });

    const { rawToken, hashedToken } = this.generateTrackingToken();

    const intervention = await this.prisma.intervention.create({
      data: {
        clientId,
        serviceType: dto.serviceType,
        subServiceId: service.subServiceId ?? undefined,
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
        status: initialStatus() as Status,
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

    // The request exists: a timeline line that cannot be written must not stop the alert.
    await this.recordEvent({
      interventionId: intervention.id,
      type: InterventionEventType.REQUEST_CREATED,
      title: 'Demande créée',
      message: 'Votre demande a été enregistrée.',
      createdById: clientId,
    });

    await this.recordEvent({
      interventionId: intervention.id,
      type: InterventionEventType.ADMIN_REVIEWING,
      title: 'En attente de validation',
      message: 'Notre équipe va examiner votre demande.',
    });

    // The back office hears about it (live event, notifications, alert text). Never throws.
    await this.staffAlerts.newRequest(intervention);

    // The customer's copy of the job (no hash of the link, no column of the back office); the
    // link itself is the one thing that is given once, here.
    return {
      ...interventionForClient(intervention),
      photosRequired: service.photosRequired,
      rawTrackingToken: rawToken,
      trackingUrl: buildTrackingUrl(intervention.id, rawToken),
    };
  }

  async findMine(clientId: number) {
    const rows = await this.prisma.intervention.findMany({
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
          // The newest quote the customer has been sent: a draft is not theirs yet.
          where: { status: { not: 'DRAFT' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        invoices: INVOICES_OF_JOB,
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => interventionForClient(row));
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
        invoices: INVOICES_OF_JOB_WITH_LINES,
        complaints: {
          orderBy: { createdAt: 'desc' },
        },
        // The customer's two chats only (with the artisan, with the support), never the internal
        // one of the back office nor the one between the artisan and the support.
        messages: {
          where: { deletedAt: null, audience: { in: chatsOf('client') as any[] } },
          include: { sender: { select: { id: true, name: true, role: true } } },
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

    return interventionForClient(intervention);
  }

  async tracking(clientId: number, id: number) {
    return this.findOneMine(clientId, id);
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

    const { row, changed } = await this.cancelJobAndVisit(clientId, id);

    if (changed) {
      await this.events.create({
        interventionId: id,
        type: InterventionEventType.CANCELLED,
        title: 'Demande annulée',
        message: 'La demande a été annulée par le client.',
        createdById: clientId,
      });
    }

    return interventionForClient(row);
  }

  /**
   * Only a job that has not started can be cancelled by the customer (the table in intervention-status.ts says which statuses those
   * are). The job and its visit are cancelled together (P3-01): a visit left standing on a cancelled job kept the artisan's hour taken,
   * and its reminders waited for the job check alone. The lock of the job comes first: a request about the visit, an answer to one or a
   * reminder that is being decided waits for this cancellation, and sees the job cancelled when it goes on.
   */
  private cancelJobAndVisit(clientId: number, id: number) {
    return this.prisma.$transaction(async (tx) => {
      await lockJob(tx, id);

      const result = await transitionStatusDetailed(tx, {
        id,
        to: Status.CANCELLED,
        actor: { kind: 'client', userId: clientId },
        dataOnChange: { cancelledAt: new Date() },
      });

      // Also when the job was cancelled already (an earlier cancel that left the visit standing): the visit is freed on the next try.
      await cancelVisit(tx as any, id, 'La demande a été annulée par le client.');

      return result;
    });
  }
}
