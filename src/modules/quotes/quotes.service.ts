import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/quote.dto';
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';
import { askAndTell, acceptQuote, readQuoteLocked, rejectQuote, requestChangeAndTell } from './quote-decisions';
import { lockJob } from '../assignment/artisan-lock';
import { linesOf, revisionOf, revisionsOf, sameContent, samePdf, saveRevision } from './quote-revisions';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { NotificationsService } from '../notifications/notifications.service';

import {
  InterventionEventType,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';
import { isBackOffice, isTicketStaff } from '../../common/auth/role-policy';
import { quoteForArtisan, quoteForClient, quoteRevisionsView } from '../../common/views/views';
import { DocumentItemInput, requestTaxRate, totalsFromItems } from '../../common/money/document-totals';
import { formatMoney, money, vatTotals } from '../../common/money/money';
import { currencyCode } from '../../common/locale/locale';

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

  /** The lines and the three amounts, exact to the millime (see common/money/document-totals). */
  private calculateTotals(items: DocumentItemInput[], taxRate?: unknown) {
    return totalsFromItems('quote', items, taxRate);
  }

  /**
   * P0-06: who may create, edit, send, cancel a quote of an intervention.
   * Ticket staff: any intervention. Artisan: only the one assigned to them.
   * Before, any artisan could write quotes on any intervention.
   */
  private async assertCanManageQuotesOf(
    actorId: number,
    interventionId: number,
    db: any = this.prisma,
  ): Promise<void> {
    const [actor, intervention] = await Promise.all([
      db.user.findUnique({
        where: { id: actorId },
        select: { role: true },
      }),
      db.intervention.findUnique({
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

    const totals = this.calculateTotals(dto.items, dto.taxRate);

    const quote = await this.prisma.$transaction(async (tx) => {
      // The right to write is asked again under the lock: the job may have been given to another artisan while this one waited.
      await lockJob(tx, interventionId);
      await this.assertCanManageQuotesOf(createdById, interventionId, tx);

      return tx.quote.create({
        data: {
          interventionId,
          createdById,
          title: dto.title,
          description: dto.description,
          currency: currencyCode(),
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
      message: `Un devis de ${formatMoney(totals.amountTTC)} TTC a été envoyé au client.`,
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

    const totals = this.calculateTotals(dto.items, dto.taxRate);

    return this.prisma.$transaction(async (tx) => {
      // The right to write is asked again under the lock: the job may have been given to another artisan while this one waited.
      await lockJob(tx, interventionId);
      await this.assertCanManageQuotesOf(createdById, interventionId, tx);

      return tx.quote.create({
        data: {
          interventionId,
          createdById,
          title: dto.title,
          description: dto.description,
          currency: currencyCode(),
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
    });
  }

  // ==========================================================
  // Admin / Artisan: update quote
  // ==========================================================

  /**
   * Edits a quote. The three amounts are always worked out from the lines and the rate (a new rate alone works them out again
   * from the lines already there), so they add up. An edit of the content of a quote that was sent keeps the version it
   * replaces and raises the revision (see quote-revisions); it is made under the lock of the job, so that an acceptance that
   * comes in at the same moment is seen by one or the other and never mixes the two.
   */
  async updateQuote(
    quoteId: number,
    updatedById: number,
    dto: UpdateQuoteDto,
  ) {
    const found = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(updatedById, found.interventionId);

    const { updated, revision, changed, seen } = await this.prisma.$transaction(async (tx) => {
      const quote = await readQuoteLocked(tx, quoteId, found.interventionId, this.quoteInclude);

      // The right to write is asked again under the lock: the job may have been given to another artisan while this one waited.
      await this.assertCanManageQuotesOf(updatedById, found.interventionId, tx);

      this.ensureQuoteEditable(quote);

      const rate = dto.taxRate === undefined || dto.taxRate === null ? money(quote.taxRate) : requestTaxRate(dto.taxRate, 'Le taux de TVA doit être supérieur ou égal à 0.');
      const given = dto.items === undefined || dto.items === null ? null : dto.items;
      const stored = linesOf(quote.items);

      // The lines given, else the lines already there; a quote with no line at all (older data) keeps its amount without tax.
      const totals = given !== null
        ? this.calculateTotals(given, rate)
        : stored.length > 0
          ? this.calculateTotals(stored, rate)
          : { ...vatTotals(quote.amountHT, rate), amountHT: money(quote.amountHT), taxRate: rate, items: [] as ReturnType<typeof linesOf> };

      const title = dto.title ?? quote.title;
      const description = dto.description === undefined ? quote.description ?? null : dto.description;
      const pdfUrl = dto.pdfUrl === undefined ? quote.pdfUrl ?? null : dto.pdfUrl;
      const lines = linesOf(totals.items);

      // The three amounts count as content: a quote whose amounts did not match its lines is put right, and the customer who read
      // the old price is told. The lines are written again when the ones given or the ones stored are not what the amounts say.
      const contentChanged = !sameContent(quote, { title, description, pdfUrl, taxRate: totals.taxRate, lines, amountHT: totals.amountHT, taxAmount: totals.taxAmount, amountTTC: totals.amountTTC });
      const rewrite = given !== null || (stored.length > 0 && JSON.stringify(lines) !== JSON.stringify(stored));

      // A draft was never seen by anyone: no version is kept. A quote that was sent keeps the version this edit replaces.
      const keeps = contentChanged && quote.status !== QuoteStatus.DRAFT;

      if (keeps) await saveRevision(tx, quote, { userId: updatedById });

      const next = keeps ? revisionOf(quote) + 1 : revisionOf(quote);

      if (rewrite) {
        await tx.quoteItem.deleteMany({ where: { quoteId } });
      }

      const saved = await tx.quote.update({
        where: { id: quoteId },
        data: {
          title: dto.title ?? undefined,
          description: dto.description,
          amountHT: totals.amountHT,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          amountTTC: totals.amountTTC,
          pdfUrl: dto.pdfUrl,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
          revision: next,
          ...(rewrite ? { items: { create: totals.items } } : {}),
        },
        include: this.quoteInclude,
      });

      return { updated: saved, revision: next, changed: contentChanged, seen: quote.status !== QuoteStatus.DRAFT };
    });

    // A draft is nobody's yet: the timeline, which the customer reads, does not say that it was edited.
    if (seen) {
      await this.createEvent({
        interventionId: found.interventionId,
        type: InterventionEventType.STATUS_CHANGED,
        title: 'Devis mis à jour',
        message: 'Le devis a été mis à jour.',
        createdById: updatedById,
        metadata: {
          quoteId,
          revision,
          contentChanged: changed,
          amountTTC: money(updated.amountTTC),
        },
      });
    }

    return updated;
  }

  // ==========================================================
  // Artisan / back office: the versions a quote went through
  // ==========================================================

  /**
   * The versions that edits replaced, the latest first, and the revision the quote is at. The assigned artisan and the back
   * office read them (the same people who read the quote itself); the back office also sees who made each edit.
   */
  async findRevisions(quoteId: number, actor: { id: number; role: Role }) {
    const quote = await this.findOne(quoteId, actor);
    const revisions = await revisionsOf(this.prisma, quoteId);

    return quoteRevisionsView(quote, revisions, isBackOffice(actor.role));
  }

  // ==========================================================
  // Admin / Artisan: send existing draft quote
  // ==========================================================

  async sendQuote(quoteId: number, sentById: number) {
    const found = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(sentById, found.interventionId);

    const { quote, updated } = await this.prisma.$transaction(async (tx) => {
      // Read again under the lock of the job: an answer of the customer or a cancellation may have come in meanwhile.
      const current = await readQuoteLocked(tx, quoteId, found.interventionId, this.quoteInclude);

      await this.assertCanManageQuotesOf(sentById, found.interventionId, tx);

      const sendableStatuses: QuoteStatus[] = [
        QuoteStatus.DRAFT,
        QuoteStatus.MODIFICATION_REQUESTED,
      ];

      if (!sendableStatuses.includes(current.status)) {
        throw new BadRequestException(
          'Seuls les devis brouillons ou à modifier peuvent être envoyés.',
        );
      }

      this.ensureQuoteNotExpired(current);

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
        id: current.interventionId,
        to: Status.QUOTE_SENT,
        actor: { kind: 'system' },
        data: { quoteSentAt: new Date() },
        soft: true,
      });

      return { quote: current, updated: sentQuote };
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message: `Un devis de ${formatMoney(quote.amountTTC, { currency: quote.currency })} TTC a été envoyé au client.`,
      createdById: sentById,
      metadata: {
        quoteId,
        amountHT: money(quote.amountHT),
        taxRate: money(quote.taxRate),
        taxAmount: money(quote.taxAmount),
        amountTTC: money(quote.amountTTC),
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

    // A draft is the artisan's or the back office's work in progress: the customer is shown a
    // quote once it is sent, and without the name or the address of who wrote it.
    const quotes = await this.prisma.quote.findMany({
      where: {
        interventionId,
        status: { not: QuoteStatus.DRAFT },
      },
      include: {
        items: {
          orderBy: {
            id: 'asc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return quotes.map((quote) => quoteForClient(quote));
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

      // A draft that somebody else wrote is not shown to the artisan (their own drafts are).
      if (quote.status === QuoteStatus.DRAFT && quote.createdById !== actor.id) {
        throw new NotFoundException('Devis introuvable.');
      }

      return quoteForArtisan(quote);
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

    const updated = await this.prisma.$transaction((tx) =>
      acceptQuote(tx, quoteId, quote.interventionId, {
        clientId,
        note: dto.note,
        revision: dto.revision,
        refusal: 'Ce devis ne peut plus être accepté.',
        include: this.quoteInclude,
      }),
    );

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message:
        dto.note ||
        `Le client a accepté le devis de ${formatMoney(updated.amountTTC, { currency: updated.currency })} TTC.`,
      createdById: clientId,
      metadata: {
        quoteId,
        revision: revisionOf(updated),
        amountTTC: money(updated.amountTTC),
      },
    });

    // The back office is told once each, with their own read state (never throws).
    await this.notifications.notifyQuoteAccepted(quoteId, clientId);

    return quoteForClient(updated);
  }

  // ==========================================================
  // Client: reject quote
  // Keeps your existing method name
  // ==========================================================

  async reject(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    const updated = await this.prisma.$transaction((tx) =>
      rejectQuote(tx, quoteId, quote.interventionId, {
        note: dto.note,
        revision: dto.revision,
        refusal: 'Ce devis ne peut plus être refusé.',
        include: this.quoteInclude,
      }),
    );

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

    return quoteForClient(updated);
  }

  // ==========================================================
  // Client: ask for the quote to be changed
  // Keeps your existing method name
  // ==========================================================

  async requestModification(
    clientId: number,
    quoteId: number,
    dto: ClientQuoteActionDto,
  ) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    // The words of the customer reach the support as a message, in the same transaction as the request.
    const updated = await this.prisma.$transaction((tx) =>
      requestChangeAndTell(tx, quoteId, quote.interventionId, {
        senderId: clientId,
        note: dto.note,
        revision: dto.revision,
        refusal: 'Vous pouvez demander une modification uniquement sur un devis envoyé.',
        include: this.quoteInclude,
      }),
    );

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Modification du devis demandée',
      message:
        dto.note ||
        'Le client demande une modification du devis.',
      createdById: clientId,
      metadata: {
        quoteId,
      },
    });

    return quoteForClient(updated);
  }

  // ==========================================================
  // Client: ask a question about the quote
  // The quote stays as it is: the customer can still accept it
  // ==========================================================

  async askQuestion(clientId: number, quoteId: number, dto: ClientQuoteActionDto) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    const updated = await this.prisma.$transaction((tx) =>
      askAndTell(tx, quoteId, quote.interventionId, {
        senderId: clientId,
        note: dto.note,
        refusal: 'Vous pouvez poser une question uniquement sur un devis envoyé.',
        include: this.quoteInclude,
      }),
    );

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Question sur le devis',
      message: dto.note || 'Le client pose une question sur le devis.',
      createdById: clientId,
      metadata: {
        quoteId,
        question: true,
      },
    });

    return quoteForClient(updated);
  }

  // ==========================================================
  // Admin / Artisan: cancel quote
  // ==========================================================

  async cancelQuote(
    quoteId: number,
    cancelledById: number,
    dto?: ClientQuoteActionDto,
  ) {
    const found = await this.getQuoteOrFail(quoteId);

    await this.assertCanManageQuotesOf(cancelledById, found.interventionId);

    const { quote, updated } = await this.prisma.$transaction(async (tx) => {
      // Read again under the lock of the job: the customer may have accepted the quote a moment ago.
      const current = await readQuoteLocked(tx, quoteId, found.interventionId, this.quoteInclude);

      await this.assertCanManageQuotesOf(cancelledById, found.interventionId, tx);

      const nonCancellableStatuses: QuoteStatus[] = [
        QuoteStatus.ACCEPTED,
        QuoteStatus.CANCELLED,
      ];

      if (nonCancellableStatuses.includes(current.status)) {
        throw new BadRequestException('Ce devis ne peut plus être annulé.');
      }

      const cancelled = await tx.quote.update({
        where: {
          id: quoteId,
        },
        data: {
          status: QuoteStatus.CANCELLED,
          clientNote: dto?.note || current.clientNote,
          cancelledAt: new Date(),
        },
        include: this.quoteInclude,
      });

      return { quote: current, updated: cancelled };
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
    const found = await this.getQuoteOrFail(quoteId);

    const { quote, updated } = await this.prisma.$transaction(async (tx) => {
      const current = await readQuoteLocked(tx, quoteId, found.interventionId, this.quoteInclude);

      const nonExpirableStatuses: QuoteStatus[] = [
        QuoteStatus.ACCEPTED,
        QuoteStatus.REJECTED,
        QuoteStatus.EXPIRED,
        QuoteStatus.CANCELLED,
      ];

      if (nonExpirableStatuses.includes(current.status)) {
        throw new BadRequestException(
          'Ce devis ne peut pas être marqué comme expiré.',
        );
      }

      const expired = await tx.quote.update({
        where: {
          id: quoteId,
        },
        data: {
          status: QuoteStatus.EXPIRED,
          expiredAt: new Date(),
        },
        include: this.quoteInclude,
      });

      return { quote: current, updated: expired };
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

  /**
   * The PDF is what the customer downloads: it is changed under the lock of the job, and only while the quote can still be edited.
   * Swapping it on a quote that was sent is an edit like the others: the version it replaces is kept (with its PDF) and the
   * revision is raised, so that a customer who read the quote with the old document cannot accept the new one by mistake.
   */
  async setPdfUrl(quoteId: number, pdfUrl: string, actorId?: number) {
    // The route does not validate its body: a request with no address is not "no PDF", it is a mistake.
    if (typeof pdfUrl !== 'string') {
      throw new BadRequestException('Indiquez l’adresse du PDF.');
    }

    const found = await this.getQuoteOrFail(quoteId);

    if (actorId !== undefined) {
      await this.assertCanManageQuotesOf(actorId, found.interventionId);
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await readQuoteLocked(tx, quoteId, found.interventionId, this.quoteInclude);

      if (actorId !== undefined) {
        await this.assertCanManageQuotesOf(actorId, found.interventionId, tx);
      }

      this.ensureQuoteEditable(current);

      const keeps = !samePdf(current.pdfUrl, pdfUrl) && current.status !== QuoteStatus.DRAFT;

      if (keeps) await saveRevision(tx, current, { userId: actorId ?? null });

      return tx.quote.update({
        where: {
          id: found.id,
        },
        data: {
          pdfUrl,
          ...(keeps ? { revision: revisionOf(current) + 1 } : {}),
        },
        include: this.quoteInclude,
      });
    });
  }

  // ==========================================================
  // Client: download quote PDF
  // Keeps your existing method name
  // ==========================================================

  async downloadForClient(clientId: number, quoteId: number) {
    const quote = await this.getQuoteOrFail(quoteId);

    this.ensureClientOwnsQuote(clientId, quote);

    if (quote.status === QuoteStatus.DRAFT) {
      throw new NotFoundException('Devis introuvable.');
    }

    return {
      quoteId: quote.id,
      pdfUrl: quote.pdfUrl,
      quote: quoteForClient(quote),
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
