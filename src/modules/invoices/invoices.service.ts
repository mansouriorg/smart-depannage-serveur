import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  InvoiceStatus,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  private generateInvoiceNumber() {
    const d = new Date();

    return `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(
      2,
      '0',
    )}-${Date.now()}`;
  }

  async createForIntervention(
    interventionId: number,
    adminId: number,
    dto: CreateInvoiceDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        quotes: {
          where: { status: 'ACCEPTED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        payments: {
          where: { status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        invoice: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.invoice) {
      throw new BadRequestException(
        'Une facture existe déjà pour cette intervention.',
      );
    }

    const quote = intervention.quotes[0];

    const amountHT = dto.amountHT ?? quote?.amountHT;
    const taxRate = dto.taxRate ?? quote?.taxRate ?? 20;

    if (!amountHT) {
      throw new BadRequestException('Montant HT introuvable.');
    }

    const taxAmount = Math.round(amountHT * (taxRate / 100) * 100) / 100;
    const amountTTC = Math.round((amountHT + taxAmount) * 100) / 100;

    const invoice = await this.prisma.invoice.create({
      data: {
        interventionId,
        invoiceNumber: dto.invoiceNumber || this.generateInvoiceNumber(),
        amountHT,
        taxRate,
        taxAmount,
        amountTTC,
        pdfUrl: dto.pdfUrl,
        notes: dto.notes,
        status: intervention.payments[0]
          ? InvoiceStatus.PAID
          : InvoiceStatus.ISSUED,
        issuedAt: new Date(),
        paidAt: intervention.payments[0] ? new Date() : undefined,
      },
    });

    await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.INVOICE_READY,
      },
    });

    await this.events.create({
      interventionId,
      type: InterventionEventType.INVOICE_READY,
      title: 'Facture disponible',
      message: 'La facture est prête au téléchargement.',
      createdById: adminId,
    });

    return invoice;
  }

  async findMine(clientId: number) {
    return this.prisma.invoice.findMany({
      where: {
        intervention: {
          clientId,
        },
      },
      include: {
        intervention: {
          select: {
            id: true,
            serviceType: true,
            address: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOneForClient(clientId: number, invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        intervention: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    if (invoice.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return invoice;
  }

  async downloadForClient(clientId: number, invoiceId: number) {
    const invoice = await this.findOneForClient(clientId, invoiceId);

    return {
      pdfUrl: invoice.pdfUrl,
      invoice,
      message: invoice.pdfUrl
        ? 'PDF disponible.'
        : 'Aucun PDF généré pour le moment. Vous pouvez générer le PDF côté frontend avec ces données.',
    };
  }
}