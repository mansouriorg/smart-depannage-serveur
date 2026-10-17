import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { NotificationsService } from '../notifications/notifications.service';

import {
  InterventionEventType,
  MessageAudience,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';
import { isBackOffice, isTicketStaff } from '../../common/auth/role-policy';

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private quoteInclude = {
    items: {
      orderBy: {
        id: 'asc' as const,
      },
    },
    createdBy: {
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      },
    },
    intervention: {
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
        subService: true,
      },
    },
  };

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private calculateTotals(items: CreateQuoteDto['items'], taxRate = 20) {
    if (!items?.length) {
      throw new BadRequestException(
        'Le devis doit contenir au moins une ligne.',
      );
    }

    const normalizedItems = items.map((item) => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);

      if (!item.label?.trim()) {
        throw new BadRequestException(
          'Chaque ligne du devis doit avoir un libellé.',
        );
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(
          'La quantité doit être supérieure à 0.',
        );
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new BadRequestException(
          'Le prix unitaire doit être supérieur ou égal à 0.',
        );
      }

      const total = this.roundMoney(quantity * unitPrice);

      return {
        label: item.label,
        description: item.description,
        quantity,
        unitPrice,
        total,
      };
    });

    const amountHT = this.roundMoney(
      normalizedItems.reduce((sum, item) => sum + item.total, 0),
    );

    const normalizedTaxRate = Number(taxRate);

    if (!Number.isFinite(normalizedTaxRate) || normalizedTaxRate < 0) {
      throw new BadRequestException(
        'Le taux de TVA doit être supérieur ou égal à 0.',
      );
    }

    const taxAmount = this.roundMoney(amountHT * (normalizedTaxRate / 100));
    const amountTTC = this.roundMoney(amountHT + taxAmount);

    return {
      items: normalizedItems,
      amountHT,
      taxRate: normalizedTaxRate,
      taxAmount,
      amountTTC,
    };
  }

  /**
   * P0-06: who may create, edit, send, cancel a quote of an intervention.
   * Ticket staff: any intervention. Artisan: only the one assigned to them.
   * Before, any artisan could write quotes on any intervention.
   */
  private async assertCanManageQuotesOf(
    actorId: number,
    interventionId: number,
  ): Promise<void> {
    const [actor, intervention] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: actorId },
        select: { role: true },
      }),
      this.prisma.intervention.findUnique({
        where: { id: interventionId },
        select: { artisanId: true },
      }),
    ]);

    if (!actor || !intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (isTicketStaff(actor.role)) {
      return;
    }

    if (actor.role === Role.ARTISAN && intervention.artisanId === actorId) {
      return;
    }

    throw new ForbiddenException(
      'Vous ne pouvez gérer que les devis de vos propres missions.',
    );
  }

  private async ensureInterventionExists(interventionId: number) {
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
        subService: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private async getQuoteOrFail(quoteId: number) {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: this.quoteInclude,
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    return quote;
  }

  private ensureClientOwnsQuote(clientId: number, quote: any) {
    if (quote.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }
  }

  private ensureQuoteIsSent(quote: any) {
    if (quote.status !== QuoteStatus.SENT) {
      throw new BadRequestException(
        'Cette action est possible uniquement sur un devis envoyé.',
      );
    }
  }

  private ensureQuoteNotExpired(quote: any) {
    if (quote.expiresAt && quote.expiresAt < new Date()) {
      throw new BadRequestException('Ce devis a expiré.');
    }
  }

  private ensureQuoteEditable(quote: any) {
    const editableStatuses: QuoteStatus[] = [
      QuoteStatus.DRAFT,
      QuoteStatus.SENT,
      QuoteStatus.MODIFICATION_REQUESTED,
    ];

    if (!editableStatuses.includes(quote.status)) {
      throw new BadRequestException(
        `Ce devis ne peut pas être modifié car son statut est ${quote.status}.`,
      );
    }
  }

  private async createEvent(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.events.create(data);
  }

  // ==========================================================
  // Admin / Artisan: create quote for intervention
  // Keeps your existing method name
  // ==========================================================

  async createForIntervention(
    interventionId: number,
    createdById: number,
    dto: CreateQuoteDto,
  ) {
    await this.assertCanManageQuotesOf(createdById, interventionId);
    await this.ensureInterventionExists(interventionId);

    const totals = this.calculateTotals(dto.items, dto.taxRate ?? 20);

    const quote = await this.prisma.quote.create({
      data: {
        interventionId,
        createdById,
        title: dto.title,
        description: dto.description,
        amountHT: totals.amountHT,
        taxRate: totals.taxRate,
        taxAmount: totals.taxAmount,
        amountTTC: totals.amountTTC,
        status: QuoteStatus.SENT,
        pdfUrl: dto.pdfUrl,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        sentAt: new Date(),
        items: {
          create: totals.items,
        },
      },
      include: this.quoteInclude,
    });

    await transitionStatus(this.prisma, {
      id: interventionId,
      to: Status.QUOTE_SENT,
      actor: { kind: 'system' },
      data: { quoteSentAt: new Date() },
      soft: true,
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message: `Un devis de ${totals.amountTTC} € TTC a été envoyé au client.`,
      createdById,
      metadata: {
        quoteId: quote.id,
        amountHT: totals.amountHT,
        taxRate: totals.taxRate,
        taxAmount: totals.taxAmount,
        amountTTC: totals.amountTTC,
      },
    });

    // In-app notification to the customer (never throws).
    await this.notifications.notifyQuoteSent(quote.id, createdById);

    return quote;
  }

  // ==========================================================
  // Admin / Artisan: create draft quote
  // Useful if you want to create before sending
  // ==========================================================

  async createDraftForIntervention(
    interventionId: number,
    createdById: number,
    dto: CreateQuoteDto,
  ) {
    await this.assertCanManageQuotesOf(createdById, interventionId);
    await this.ensureInterventionExists(interventionId);

    const totals = this.calculateTotals(dto.items, dto.taxRate ?? 20);

    return this.prisma.quote.create({
      data: {
        interventionId,
        createdById,
        title: dto.title,
        description: dto.description,
        amountHT: totals.amountHT,
        taxRate: totals.taxRate,
        taxAmount: totals.taxAmount,
        amountTTC: totals.amountTTC,
        status: QuoteStatus.DRAFT,
        pdfUrl: dto.pdfUrl,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        items: {
          create: totals.items,
        },
      },
      include: this.quoteInclude,
    });
  }

  // ==========================================================
  // Admin / Artisan: update quote
  // ==========================================================

  async updateQuote(
    quoteId: number,
    updatedById: number,
    dto: Partial<CreateQuoteDto>,
  ) {
    const quote = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(updatedById, quote.interventionId);

    this.ensureQuoteEditable(quote);

    if (dto.items?.length) {
      const totals = this.calculateTotals(dto.items, dto.taxRate ?? quote.taxRate);

      return this.prisma.$transaction(async (tx) => {
        await tx.quoteItem.deleteMany({
          where: {
            quoteId,
          },
        });

        const updated = await tx.quote.update({
          where: {
            id: quoteId,
          },
          data: {
            title: dto.title,
            description: dto.description,
            amountHT: totals.amountHT,
            taxRate: totals.taxRate,
            taxAmount: totals.taxAmount,
            amountTTC: totals.amountTTC,
            pdfUrl: dto.pdfUrl,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : quote.expiresAt,
            items: {
              create: totals.items,
            },
          },
          include: this.quoteInclude,
        });

        return updated;
      });
    }

    const updated = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        title: dto.title,
        description: dto.description,
        taxRate: dto.taxRate,
        pdfUrl: dto.pdfUrl,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
      include: this.quoteInclude,
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Devis mis à jour',
      message: 'Le devis a été mis à jour.',
      createdById: updatedById,
      metadata: {
        quoteId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin / Artisan: send existing draft quote
  // ==========================================================

  async sendQuote(quoteId: number, sentById: number) {
    const quote = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(sentById, quote.interventionId);

    const sendableStatuses: QuoteStatus[] = [
      QuoteStatus.DRAFT,
      QuoteStatus.MODIFICATION_REQUESTED,
    ];

    if (!sendableStatuses.includes(quote.status)) {
      throw new BadRequestException(
        'Seuls les devis brouillons ou à modifier peuvent être envoyés.',
      );
    }

    this.ensureQuoteNotExpired(quote);

    const updated = await this.prisma.$transaction(async (tx) => {
      const sentQuote = await tx.quote.update({
        where: {
          id: quoteId,
        },
        data: {
          status: QuoteStatus.SENT,
          sentAt: new Date(),
        },
        include: this.quoteInclude,
      });

      await transitionStatus(tx, {
        id: quote.interventionId,
        to: Status.QUOTE_SENT,
        actor: { kind: 'system' },
        data: { quoteSentAt: new Date() },
        soft: true,
      });

      return sentQuote;
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message: `Un devis de ${quote.amountTTC} € TTC a été envoyé au client.`,
      createdById: sentById,
      metadata: {
        quoteId,
        amountHT: quote.amountHT,
        taxRate: quote.taxRate,
        taxAmount: quote.taxAmount,
        amountTTC: quote.amountTTC,
      },
    });

    // In-app notification to the customer (never throws).
    await this.notifications.notifyQuoteSent(quoteId, sentById);

    return updated;
  }

  // ==========================================================
  // Client: view quotes for an intervention
  // Keeps your existing method name
  // ==========================================================

  async findForClient(clientId: number, interventionId: number) {
    const intervention = await this.ensureInterventionExists(interventionId);

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return this.prisma.quote.findMany({
      where: {
        interventionId,
      },
      include: {
        items: {
          orderBy: {
            id: 'asc',
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ==========================================================
  // Client/Admin/Artisan: quote detail
  // ==========================================================

  async findOne(quoteId: number, actor?: { id: number; role: Role }) {
    const quote = await this.getQuoteOrFail(quoteId);

    // P0-06: back office sees every quote; an artisan only the quotes of
    // their own missions. Anyone else gets the same 404 as an unknown id.
    if (actor && !isBackOffice(actor.role)) {
      const isAssignedArtisan =
        actor.role === Role.ARTISAN &&
        quote.intervention?.artisanId === actor.id;

      if (!isAssignedArtisan) {
        throw new NotFoundException('Devis introuvable.');
      }
    }

    return quote;
  }

  // ==========================================================
  // Client: accept quote
  // Keeps your existing method name
  // ==========================================================

  async accept(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);
    this.ensureQuoteIsSent(quote);
    this.ensureQuoteNotExpired(quote);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.quote.updateMany({
        where: {
          interventionId: quote.interventionId,
          id: {
            not: quoteId,
          },
          status: {
            in: [
              QuoteStatus.DRAFT,
              QuoteStatus.SENT,
              QuoteStatus.MODIFICATION_REQUESTED,
            ],
          },
        },
        data: {
          status: QuoteStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      const acceptedQuote = await tx.quote.update({
        where: {
          id: quoteId,
        },
        data: {
          status: QuoteStatus.ACCEPTED,
          clientNote: dto.note,
          acceptedAt: new Date(),
        },
        include: this.quoteInclude,
      });

      await transitionStatus(tx, {
        id: quote.interventionId,
        to: Status.QUOTE_ACCEPTED,
        actor: { kind: 'client', userId: clientId },
        data: { quoteAcceptedAt: new Date() },
        soft: true,
      });

      return acceptedQuote;
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message:
        dto.note ||
        `Le client a accepté le devis de ${quote.amountTTC} € TTC.`,
      createdById: clientId,
      metadata: {
        quoteId,
        amountTTC: quote.amountTTC,
      },
    });

    // The back office is told once each, with their own read state (never throws).
    await this.notifications.notifyQuoteAccepted(quoteId, clientId);

    return updated;
  }

  // ==========================================================
  // Client: reject quote
  // Keeps your existing method name
  // ==========================================================

  async reject(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);
    this.ensureQuoteIsSent(quote);

    const updated = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        status: QuoteStatus.REJECTED,
        clientNote: dto.note,
        rejectedAt: new Date(),
      },
      include: this.quoteInclude,
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_REJECTED,
      title: 'Devis refusé',
      message: dto.note || 'Le client a refusé le devis.',
      createdById: clientId,
      metadata: {
        quoteId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Client: ask question / request modification
  // Keeps your existing method name
  // ==========================================================

  async requestModification(
    clientId: number,
    quoteId: number,
    dto: ClientQuoteActionDto,
  ) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    const modificationRequestAllowedStatuses: QuoteStatus[] = [
      QuoteStatus.SENT,
      QuoteStatus.MODIFICATION_REQUESTED,
    ];

    if (!modificationRequestAllowedStatuses.includes(quote.status)) {
      throw new BadRequestException(
        'Vous pouvez demander une modification uniquement sur un devis envoyé.',
      );
    }

    const updated = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        status: QuoteStatus.MODIFICATION_REQUESTED,
        clientNote: dto.note,
      },
      include: this.quoteInclude,
    });

    await this.prisma.message.create({
      data: {
        interventionId: quote.interventionId,
        senderId: clientId,
        audience: MessageAudience.CLIENT_SUPPORT,
        content: `Question / demande sur le devis #${quoteId}: ${
          dto.note || 'Le client demande des précisions sur le devis.'
        }`,
        attachments: [],
      },
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Question ou modification du devis demandée',
      message:
        dto.note ||
        'Le client demande une précision ou une modification du devis.',
      createdById: clientId,
      metadata: {
        quoteId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Alias: client asks question about quote
  // ==========================================================

  async askQuestion(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    return this.requestModification(clientId, quoteId, dto);
  }

  // ==========================================================
  // Admin / Artisan: cancel quote
  // ==========================================================

  async cancelQuote(
    quoteId: number,
    cancelledById: number,
    dto?: ClientQuoteActionDto,
  ) {
    const quote = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(cancelledById, quote.interventionId);

    const nonCancellableStatuses: QuoteStatus[] = [
      QuoteStatus.ACCEPTED,
      QuoteStatus.CANCELLED,
    ];

    if (nonCancellableStatuses.includes(quote.status)) {
      throw new BadRequestException('Ce devis ne peut plus être annulé.');
    }

    const updated = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        status: QuoteStatus.CANCELLED,
        clientNote: dto?.note || quote.clientNote,
        cancelledAt: new Date(),
      },
      include: this.quoteInclude,
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.CANCELLED,
      title: 'Devis annulé',
      message: dto?.note || 'Le devis a été annulé.',
      createdById: cancelledById,
      metadata: {
        quoteId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin / Cron: expire quote
  // ==========================================================

  async expireQuote(quoteId: number, expiredById?: number) {
    const quote = await this.getQuoteOrFail(quoteId);

    const nonExpirableStatuses: QuoteStatus[] = [
      QuoteStatus.ACCEPTED,
      QuoteStatus.REJECTED,
      QuoteStatus.EXPIRED,
      QuoteStatus.CANCELLED,
    ];

    if (nonExpirableStatuses.includes(quote.status)) {
      throw new BadRequestException(
        'Ce devis ne peut pas être marqué comme expiré.',
      );
    }

    const updated = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        status: QuoteStatus.EXPIRED,
        expiredAt: new Date(),
      },
      include: this.quoteInclude,
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Devis expiré',
      message: 'Le devis a expiré.',
      createdById: expiredById,
      metadata: {
        quoteId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin / Artisan: attach or update PDF URL
  // ==========================================================

  async setPdfUrl(quoteId: number, pdfUrl: string, actorId?: number) {
    const quote = await this.getQuoteOrFail(quoteId);

    if (actorId !== undefined) {
      await this.assertCanManageQuotesOf(actorId, quote.interventionId);
    }

    return this.prisma.quote.update({
      where: {
        id: quote.id,
      },
      data: {
        pdfUrl,
      },
      include: this.quoteInclude,
    });
  }

  // ==========================================================
  // Client: download quote PDF
  // Keeps your existing method name
  // ==========================================================

  async downloadForClient(clientId: number, quoteId: number) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    return {
      quoteId: quote.id,
      pdfUrl: quote.pdfUrl,
      quote,
      message: quote.pdfUrl
        ? 'PDF disponible.'
        : 'Aucun PDF généré pour le moment. Utilisez les données du devis pour afficher/imprimer le devis côté frontend.',
    };
  }

  // ==========================================================
  // Admin / System: list expired sent quotes
  // Useful for a future cron job
  // ==========================================================

  async findExpiredQuotes() {
    return this.prisma.quote.findMany({
      where: {
        status: {
          in: [QuoteStatus.SENT, QuoteStatus.MODIFICATION_REQUESTED],
        },
        expiresAt: {
          lt: new Date(),
        },
      },
      include: this.quoteInclude,
      orderBy: {
        expiresAt: 'asc',
      },
    });
  }
}
