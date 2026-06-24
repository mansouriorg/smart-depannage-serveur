import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  QuoteStatus,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  private async ensureInterventionExists(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  async createForIntervention(
    interventionId: number,
    createdById: number,
    dto: CreateQuoteDto,
  ) {
    await this.ensureInterventionExists(interventionId);

    const amountHT = dto.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0,
    );

    const taxRate = dto.taxRate ?? 20;
    const taxAmount = Math.round(amountHT * (taxRate / 100) * 100) / 100;
    const amountTTC = Math.round((amountHT + taxAmount) * 100) / 100;

    const quote = await this.prisma.quote.create({
      data: {
        interventionId,
        createdById,
        title: dto.title,
        description: dto.description,
        amountHT,
        taxRate,
        taxAmount,
        amountTTC,
        status: QuoteStatus.SENT,
        pdfUrl: dto.pdfUrl,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        items: {
          create: dto.items.map((item) => ({
            label: item.label,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: Math.round(item.quantity * item.unitPrice * 100) / 100,
          })),
        },
      },
      include: {
        items: true,
      },
    });

    await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.QUOTE_SENT,
      },
    });

    await this.events.create({
      interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message: `Un devis de ${amountTTC} € TTC a été envoyé au client.`,
      createdById,
    });

    return quote;
  }

  async findForClient(clientId: number, interventionId: number) {
    const intervention = await this.ensureInterventionExists(interventionId);

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.quote.findMany({
      where: { interventionId },
      include: {
        items: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async accept(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        intervention: true,
        items: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    if (quote.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const updated = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.ACCEPTED,
        clientNote: dto.note,
      },
      include: {
        items: true,
      },
    });

    await this.prisma.intervention.update({
      where: { id: quote.interventionId },
      data: {
        status: Status.QUOTE_ACCEPTED,
      },
    });

    await this.events.create({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message: 'Le client a accepté le devis.',
      createdById: clientId,
    });

    return updated;
  }

  async reject(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        intervention: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    if (quote.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const updated = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.REJECTED,
        clientNote: dto.note,
      },
    });

    await this.events.create({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_REJECTED,
      title: 'Devis refusé',
      message: dto.note || 'Le client a refusé le devis.',
      createdById: clientId,
    });

    return updated;
  }

  async requestModification(
    clientId: number,
    quoteId: number,
    dto: ClientQuoteActionDto,
  ) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        intervention: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    if (quote.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const updated = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.MODIFICATION_REQUESTED,
        clientNote: dto.note,
      },
    });

    await this.events.create({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Modification du devis demandée',
      message: dto.note || 'Le client demande une modification du devis.',
      createdById: clientId,
    });

    return updated;
  }

  async downloadForClient(clientId: number, quoteId: number) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        intervention: true,
        items: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    if (quote.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return {
      pdfUrl: quote.pdfUrl,
      quote,
      message: quote.pdfUrl
        ? 'PDF disponible.'
        : 'Aucun PDF généré pour le moment. Utilisez les données du devis pour afficher/imprimer le devis côté frontend.',
    };
  }
}