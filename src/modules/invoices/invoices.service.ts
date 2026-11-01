import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { NotificationsService } from '../notifications/notifications.service';
import { isDeliverableEmail } from '../notifications/delivery/contact';
import { currentInvoice, invoiceForArtisan, invoiceForClient } from '../../common/views/views';
import { totalsFromAmount, totalsFromItems } from '../../common/money/document-totals';
import { compareMoney, formatMoney, money, sumMoney, toMoneyString } from '../../common/money/money';
import { DEFAULT_LOCALE } from '../../common/i18n/i18n';
import { MESSAGES, localeOfUser, moneyIn, say } from '../../common/i18n/messages';
import { lockJob } from '../assignment/artisan-lock';
import { amountToPay, paymentFigures, syncFinancials } from '../payments/financials-ops';
import { jobIsInPaidPayout } from '../cash-ledger/cash-ledger-ops';
import { currencyCode, getLocale } from '../../common/locale/locale';
import { takeDocumentNumber } from './document-number';
import { creditNoteTotals } from './credit-note-totals';
import { assertConfiguredRate, isConfiguredRate, printedCompanyOf } from './invoice-legal';
import { settleInvoice } from './invoice-settlement';
import { serviceLabel } from './service-labels';
import { creditNotePdfFile, invoicePdfFile, type PdfFile } from './pdf/pdf-files';

import {
  InterventionEventType,
  InvoiceStatus,
  PaymentStatus,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';
import { Permission, can } from '../../common/auth/permissions';

type InvoiceEmailDto = {
  email?: string;
  message?: string;
};

type CancelInvoiceDto = {
  reason?: string;
};

type CreditNoteDto = {
  reason?: string;
  amountTTC?: number;
};

type ExportInvoicesQuery = {
  status?: InvoiceStatus;
  paymentStatus?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
  format?: 'json' | 'csv';
};

type AuthenticatedUser = {
  id: number;
  role: Role;
};

const ALREADY_INVOICED = 'Une facture existe déjà pour cette intervention.';

/** The reason of a credit note is printed on it. */
const CREDIT_REASON_MAX = 500;
/** A credit note that repeats the one just made (same amount, same reason) within this time is a double click, not a second credit note. */
const CREDIT_NOTE_REPEAT_MS = 60_000;

/** Where the PDF of an invoice is read (the route of the invoices): drawn from the invoice as it was issued, so it is the same every time. */
const pdfPathOf = (invoiceId: number) => `/invoices/${invoiceId}/pdf`;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private invoiceInclude: Prisma.InvoiceInclude = {
    items: {
      orderBy: {
        id: 'asc',
      },
    },
    creditNotes: {
      orderBy: {
        id: 'asc',
      },
    },
    payments: {
      orderBy: {
        createdAt: 'desc',
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
            address: true,
            taxId: true,
            website: true,
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

  private isAdminRole(role: Role): boolean {
    return can(role, Permission.BACK_OFFICE_ACCESS);
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

  private async getCompanySettings() {
    return this.prisma.companySettings.findFirst({
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  private async getInvoiceOrFail(invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
      include: this.invoiceInclude,
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    return invoice;
  }

  private async getInterventionForInvoice(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        client: true,
        artisan: true,
        subService: true,
        invoices: true,
        quotes: {
          where: {
            status: QuoteStatus.ACCEPTED,
          },
          include: {
            items: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private checkCanAccessInvoice(user: AuthenticatedUser, invoice: any) {
    const isAdmin = this.isAdminRole(user.role);
    const isClient = invoice.intervention.clientId === user.id;
    const isArtisan = invoice.intervention.artisanId === user.id;

    if (!isAdmin && !isClient && !isArtisan) {
      throw new ForbiddenException('Accès refusé à cette facture.');
    }
  }

  /**
   * The invoice as this reader may read it. The back office gets the row; the customer gets the
   * invoice once it is out of draft, with their own details; the artisan gets it without the
   * customer's details on it. Neither has the record of where it was e-mailed, nor why it was
   * cancelled.
   */
  private forReader(user: AuthenticatedUser, invoice: any) {
    if (this.isAdminRole(user.role)) return invoice;

    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new NotFoundException('Facture introuvable.');
    }

    return invoice.intervention.clientId === user.id
      ? invoiceForClient(invoice)
      : invoiceForArtisan(invoice);
  }

  /**
   * Who may have the PDF: the back office and the customer. The artisan sees that there is an invoice and what it says, not the
   * customer's details, and the PDF is the invoice with those details on it. A draft is not the customer's yet.
   */
  private canReadPdf(user: AuthenticatedUser, invoice: any): boolean {
    if (this.isAdminRole(user.role)) return true;

    return invoice.status !== InvoiceStatus.DRAFT && invoice.intervention.clientId === user.id;
  }

  private checkCanReadPdf(user: AuthenticatedUser, invoice: any) {
    if (this.isAdminRole(user.role)) return;

    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new NotFoundException('Facture introuvable.');
    }

    if (!this.canReadPdf(user, invoice)) {
      throw new ForbiddenException('Le PDF de la facture est réservé au client et à l’administration.');
    }
  }

  private calculateTotalsFromAmount(amountHT: unknown, taxRate?: unknown) {
    return totalsFromAmount(amountHT, taxRate ?? getLocale().defaultTaxRate);
  }

  private calculateTotalsFromItems(
    items: {
      label: string;
      description?: string | null;
      quantity: number;
      unitPrice: number;
    }[],
    taxRate?: unknown,
  ) {
    const totals = totalsFromItems('invoice', items, taxRate ?? getLocale().defaultTaxRate, 'Taux de TVA invalide.');

    return {
      ...totals,
      items: totals.items.map((item) => ({ ...item, description: item.description || undefined })),
    };
  }

  private getInvoiceItemsFromQuote(quote: any) {
    return quote.items.map((item) => ({
      label: item.label,
      description: item.description,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
      total: money(item.total),
    }));
  }

  private buildCsv(rows: Record<string, any>[]) {
    if (!rows.length) {
      return '';
    }

    const headers = Object.keys(rows[0]);

    const escapeCsv = (value: any) => {
      if (value === null || value === undefined) {
        return '';
      }

      const stringValue = String(value).replace(/"/g, '""');

      if (
        stringValue.includes(',') ||
        stringValue.includes('\n') ||
        stringValue.includes('"')
      ) {
        return `"${stringValue}"`;
      }

      return stringValue;
    };

    return [
      headers.join(','),
      ...rows.map((row) =>
        headers.map((header) => escapeCsv(row[header])).join(','),
      ),
    ].join('\n');
  }

  private toExportRow(invoice: any) {
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      paymentStatus: invoice.paymentStatus,
      clientName: invoice.clientName,
      clientEmail: invoice.clientEmail,
      interventionId: invoice.interventionId,
      interventionAddress: invoice.interventionAddress,
      serviceType: invoice.serviceType,
      amountHT: toMoneyString(invoice.amountHT),
      taxRate: money(invoice.taxRate),
      taxAmount: toMoneyString(invoice.taxAmount),
      amountTTC: toMoneyString(invoice.amountTTC),
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      sentAt: invoice.sentAt,
      paidAt: invoice.paidAt,
      cancelledAt: invoice.cancelledAt,
      createdAt: invoice.createdAt,
      // The columns of P2-07 come after the others: a file read by position keeps reading the same columns.
      stampDuty: toMoneyString(invoice.stampDuty ?? 0),
      creditedAmount: toMoneyString(invoice.creditedAmount ?? 0),
      mentionsConfirmed: Boolean(invoice.mentionsConfirmed),
    };
  }

  // ==========================================================
  // Admin: create / generate invoice for intervention
  // Keeps your existing method name
  // ==========================================================

  async createForIntervention(
    interventionId: number,
    adminId: number,
    dto: CreateInvoiceDto,
  ) {
    const intervention = await this.getInterventionForInvoice(interventionId);

    // A job has one invoice at a time. A new one replaces one that was cancelled (an invoice credited in full is cancelled): the
    // number of the cancelled one stays in the series, and the payments received move to the new one.
    if (intervention.invoices.some((invoice) => invoice.status !== InvoiceStatus.CANCELLED)) {
      throw new BadRequestException(ALREADY_INVOICED);
    }

    const company = await this.getCompanySettings();
    const printed = printedCompanyOf(company);

    const quote = intervention.quotes[0];

    // A rate typed by the back office is one of the rates of the company (the ones the accountant confirmed).
    if (dto.taxRate !== undefined && dto.taxRate !== null) assertConfiguredRate(dto.taxRate);

    const amountHT = dto.amountHT ?? quote?.amountHT;
    const taxRate = dto.taxRate ?? quote?.taxRate ?? company?.defaultTaxRate ?? getLocale().defaultTaxRate;

    if (!amountHT || money(amountHT) === 0) {
      throw new BadRequestException(
        'Montant HT introuvable. Utilisez un devis accepté ou envoyez un montant HT.',
      );
    }

    // An invoice made from the accepted quote, with no amount or rate sent, is that quote: the same amounts to the millime
    // (a quote written before the millime columns may carry a tax rounded to the cent, which the customer accepted) and the
    // currency it was written in. An amount or a rate sent by the administrator is worked out again.
    const fromQuote = Boolean(quote) && dto.amountHT === undefined && dto.taxRate === undefined;
    const totals = fromQuote
      ? { amountHT: money(quote.amountHT), taxRate: money(quote.taxRate), taxAmount: money(quote.taxAmount), amountTTC: money(quote.amountTTC) }
      : this.calculateTotalsFromAmount(amountHT, taxRate);
    const currency = quote?.currency ?? currencyCode();

    // The lines of the quote go with the quote's amount: an amount sent by the back office is not the sum of those lines, so the invoice
    // then has the one line for the service (lines that add up to something else than the invoice would be printed on it).
    const invoiceItems = quote?.items?.length && money(totals.amountHT) === money(quote.amountHT)
      ? this.getInvoiceItemsFromQuote(quote)
      : [
          {
            label:
              intervention.subService?.name ||
              serviceLabel(intervention.serviceType),
            description: intervention.description,
            quantity: 1,
            unitPrice: totals.amountHT,
            total: totals.amountHT,
          },
        ];

    const invoice = await this.prisma.$transaction(async (tx) => {
      // The payments are read again under the lock of the job: a confirmation that comes in between pays the invoice that exists
      // then, and this one is made with what was received at that moment.
      await lockJob(tx, interventionId);

      // Read again under the lock: another invoice may have been made in the meantime.
      const open = await tx.invoice.findFirst({ where: { interventionId, status: { not: InvoiceStatus.CANCELLED } }, select: { id: true } });

      if (open) throw new BadRequestException(ALREADY_INVOICED);

      // The number is taken last, with the date of the invoice: nothing below can fail without taking the number back with it.
      const given = await takeDocumentNumber(tx, 'INVOICE');

      const created = await tx.invoice.create({
        data: {
          interventionId,
          invoiceNumber: given.number,
          numberYear: given.year,
          sequence: given.sequence,

          status: InvoiceStatus.ISSUED,
          paymentStatus: PaymentStatus.PENDING,

          // What is printed, as it is today: the invoice reads the same later, whatever the settings become.
          companyName: printed.companyName,
          companyPhone: printed.companyPhone,
          companyEmail: printed.companyEmail,
          companyAddress: printed.companyAddress,
          companyTaxId: printed.companyTaxId,
          companyRegistre: printed.companyRegistre,
          companyRib: printed.companyRib,
          companyWebsite: undefined,
          legalMentions: printed.legalMentions,
          paymentTerms: printed.paymentTerms,
          stampDuty: printed.stampDuty,
          // The accountant confirmed the rates of the company: an invoice at another rate (a quote written before the list changed) does not claim it.
          mentionsConfirmed: printed.mentionsConfirmed && isConfiguredRate(totals.taxRate),

          clientName: intervention.contactName || intervention.client.name,
          clientEmail: intervention.contactEmail || intervention.client.email,
          clientPhone: intervention.contactPhone || intervention.client.phone,
          clientAddress: intervention.address,
          clientTaxId: intervention.client.taxId?.trim() || null,

          interventionDescription: intervention.description,
          interventionAddress: intervention.address,
          serviceType: intervention.serviceType,
          subServiceName: intervention.subService?.name,

          currency,
          amountHT: totals.amountHT,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          amountTTC: totals.amountTTC,

          notes: dto.notes,
          issuedAt: given.issuedAt,

          items: {
            create: invoiceItems,
          },
        },
      });

      // What the customer kept on the job pays this invoice (the money of an invoice that was cancelled moves to the one that
      // replaces it). A payment that was given back in full paid nothing: it stays with the invoice it was made for.
      const received = await tx.payment.findMany({
        where: { interventionId, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } },
        select: { id: true, invoiceId: true },
      });
      const moving = received.filter((payment) => payment.invoiceId !== created.id).map((payment) => payment.id);

      if (moving.length > 0) await tx.payment.updateMany({ where: { id: { in: moving } }, data: { invoiceId: created.id } });

      // Paid when what the customer kept covers it, not when a payment of some part of it was confirmed (a deposit).
      await settleInvoice(tx, interventionId, given.issuedAt);

      // The invoice is now what the job asks for: the price in its financials follows it (the payments may be above it). Not
      // when a payout that was paid already took the figures of the job: the platform gave the artisan that share.
      if (!(await jobIsInPaidPayout(tx, interventionId))) await syncFinancials(tx, interventionId, { userId: adminId });

      await transitionStatus(tx, {
        id: interventionId,
        to: Status.INVOICE_SENT,
        actor: { kind: 'system' },
        data: { invoiceSentAt: new Date() },
        soft: true,
      });

      const settled = await tx.invoice.findUnique({ where: { id: created.id }, include: this.invoiceInclude });

      if (!settled) throw new NotFoundException('Facture introuvable.');

      return settled;
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.INVOICE_READY,
      title: 'Facture disponible',
      message: `La facture ${invoice.invoiceNumber} est prête au téléchargement.`,
      createdById: adminId,
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amountTTC: money(invoice.amountTTC),
      },
    });

    // In-app notification to the customer (never throws).
    await this.notifications.notifyInvoiceReady(invoice.id, adminId);

    return invoice;
  }

  // ==========================================================
  // Alias for future controllers: generateInvoice()
  // ==========================================================

  async generateInvoice(
    user: AuthenticatedUser,
    dto: CreateInvoiceDto & { interventionId: number },
  ) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    return this.createForIntervention(dto.interventionId, user.id, dto);
  }

  // ==========================================================
  // Client: list my invoices
  // Keeps your existing method name
  // ==========================================================

  async findMine(clientId: number) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        // A draft is the back office's work in progress; the customer's invoice starts when it is issued.
        status: { not: InvoiceStatus.DRAFT },
        intervention: {
          clientId,
        },
      },
      include: {
        items: {
          orderBy: {
            id: 'asc',
          },
        },
        creditNotes: {
          orderBy: {
            id: 'asc',
          },
        },
        payments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        intervention: {
          select: {
            id: true,
            serviceType: true,
            address: true,
            createdAt: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return invoices.map((invoice) => invoiceForClient(invoice));
  }

  // ==========================================================
  // Client: invoice detail
  // Keeps your existing method name
  // ==========================================================

  async findOneForClient(clientId: number, invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
      include: this.invoiceInclude,
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    if (invoice.intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new NotFoundException('Facture introuvable.');
    }

    return invoiceForClient(invoice);
  }

  // ==========================================================
  // General invoice detail for admin/client/artisan
  // ==========================================================

  async findOne(user: AuthenticatedUser, invoiceId: number) {
    const invoice = await this.getInvoiceOrFail(invoiceId);

    this.checkCanAccessInvoice(user, invoice);

    return this.forReader(user, invoice);
  }

  // ==========================================================
  // Invoice by intervention
  // ==========================================================

  async findByIntervention(user: AuthenticatedUser, interventionId: number) {
    // The invoice the job shows: the latest that is not cancelled (a job can have had several).
    const invoice = currentInvoice(
      await this.prisma.invoice.findMany({
        where: {
          interventionId,
        },
        include: this.invoiceInclude,
        orderBy: {
          id: 'desc',
        },
      }),
    );

    if (!invoice) {
      throw new NotFoundException('Aucune facture pour cette intervention.');
    }

    this.checkCanAccessInvoice(user, invoice);

    return this.forReader(user, invoice);
  }

  // ==========================================================
  // Client download
  // Keeps your existing method name
  // ==========================================================

  async downloadForClient(clientId: number, invoiceId: number) {
    const invoice = await this.findOneForClient(clientId, invoiceId);

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      pdfUrl: invoice.pdfUrl,
      invoice,
      pdfPath: pdfPathOf(invoice.id),
      message: 'Le PDF de la facture est disponible à l’adresse pdfPath.',
    };
  }

  // ==========================================================
  // General download for admin/client/artisan
  // ==========================================================

  async downloadInvoice(user: AuthenticatedUser, invoiceId: number) {
    const row = await this.getInvoiceOrFail(invoiceId);

    this.checkCanAccessInvoice(user, row);

    const invoice = this.forReader(user, row);
    const readsPdf = this.canReadPdf(user, row);

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      pdfUrl: invoice.pdfUrl,
      invoice,
      // The artisan is not given a link they could not open.
      pdfPath: readsPdf ? pdfPathOf(invoice.id) : null,
      message: readsPdf ? 'Le PDF de la facture est disponible à l’adresse pdfPath.' : 'Le PDF de la facture est réservé au client et à l’administration.',
    };
  }

  // ==========================================================
  // The PDF of an invoice, and of a credit note (P2-07)
  // Drawn when it is asked for, from the document as it was issued: nothing to store, nothing that can drift from the invoice.
  // ==========================================================

  async pdfOfInvoice(user: AuthenticatedUser, invoiceId: number): Promise<PdfFile> {
    const invoice = await this.getInvoiceOrFail(invoiceId);

    this.checkCanAccessInvoice(user, invoice);
    this.checkCanReadPdf(user, invoice);

    return invoicePdfFile(invoice);
  }

  async pdfOfCreditNote(user: AuthenticatedUser, creditNoteId: number): Promise<PdfFile> {
    const creditNote = await this.prisma.creditNote.findUnique({
      where: { id: creditNoteId },
      include: { invoice: { include: this.invoiceInclude } },
    });

    if (!creditNote) {
      throw new NotFoundException('Avoir introuvable.');
    }

    this.checkCanAccessInvoice(user, creditNote.invoice);
    this.checkCanReadPdf(user, creditNote.invoice);

    return creditNotePdfFile(creditNote, creditNote.invoice);
  }

  // ==========================================================
  // Admin: send invoice by email
  // Uses NotificationsService.sendEmail()
  // ==========================================================

  async sendInvoiceByEmail(
    user: AuthenticatedUser,
    invoiceId: number,
    dto: InvoiceEmailDto,
  ) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    const invoice = await this.getInvoiceOrFail(invoiceId);

    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException(
        'Impossible d’envoyer une facture annulée.',
      );
    }

    const email = dto.email || invoice.clientEmail;

    if (!email) {
      throw new BadRequestException(
        'Aucune adresse email client disponible pour envoyer la facture.',
      );
    }

    // What the back office wrote is sent as it is; the text proposed instead is in the customer's language.
    const locale = dto.message ? DEFAULT_LOCALE : await localeOfUser(this.prisma, invoice.intervention?.clientId ?? invoice.intervention?.client?.id);
    const stamped = money(invoice.stampDuty ?? 0) > 0;

    const message =
      dto.message ||
      say(stamped ? MESSAGES.invoice.email.bodyWithStamp : MESSAGES.invoice.email.body, locale, {
        number: invoice.invoiceNumber,
        amount: moneyIn(locale, amountToPay(invoice), invoice.currency),
      });

    // The invoice is only marked as sent when the e-mail really can leave:
    // otherwise the back office would believe a customer was billed.
    if (!isDeliverableEmail(email)) {
      throw new BadRequestException(
        'Cette adresse e-mail ne peut pas recevoir de courrier. Indiquez une adresse valide.',
      );
    }

    if (this.notifications.isEmailSimulated()) {
      throw new BadRequestException(
        "L'envoi d'e-mails n'est pas configuré sur le serveur (SMTP_HOST): la facture n'a pas été envoyée.",
      );
    }

    const queued = await this.notifications.sendEmail(
      email,
      say(MESSAGES.invoice.email.subject, locale, { number: invoice.invoiceNumber }),
      message,
    );

    if (!queued.queued) {
      throw new ServiceUnavailableException(
        "L'e-mail n'a pas pu être préparé pour l'envoi. Réessayez dans un instant.",
      );
    }

    // The state of the invoice is read again under the lock of the job, after the e-mail left: while it was being queued the invoice may
    // have been paid or credited in full, and a state written from the first read would undo that.
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, invoice.interventionId);

      const now = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { status: true } });
      const kept = now?.status === InvoiceStatus.PAID || now?.status === InvoiceStatus.CANCELLED ? now.status : InvoiceStatus.SENT;

      return tx.invoice.update({
        where: {
          id: invoiceId,
        },
        data: {
          status: kept,
          sentAt: new Date(),
          emailedTo: email,
        },
        include: this.invoiceInclude,
      });
    });

    await transitionStatus(this.prisma, {
      id: invoice.interventionId,
      to: Status.INVOICE_SENT,
      actor: { kind: 'system', userId: user.id },
      data: { invoiceSentAt: new Date() },
      soft: true,
    });

    await this.createEvent({
      interventionId: invoice.interventionId,
      type: InterventionEventType.INVOICE_SENT,
      title: 'Facture envoyée',
      message: `La facture ${invoice.invoiceNumber} a été envoyée par email.`,
      createdById: user.id,
      metadata: {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        emailedTo: email,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin: cancel invoice
  // ==========================================================

  async cancelInvoice(
    user: AuthenticatedUser,
    invoiceId: number,
    dto: CancelInvoiceDto,
  ) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    const invoice = await this.getInvoiceOrFail(invoiceId);

    this.ensureCanBeCancelled(invoice);

    const updated = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, invoice.interventionId);

      // Read again under the lock: a payment may have paid it, or a credit note may have been issued, in the meantime.
      const current = await tx.invoice.findUnique({ where: { id: invoiceId } });

      if (!current) throw new NotFoundException('Facture introuvable.');

      this.ensureCanBeCancelled(current);

      const cancelled = await tx.invoice.update({
        where: {
          id: invoiceId,
        },
        data: {
          status: InvoiceStatus.CANCELLED,
          cancelReason: dto.reason,
          cancelledAt: new Date(),
        },
        include: this.invoiceInclude,
      });

      // The job asks for its accepted quote again: the figures of its financials follow (unless a payout took them).
      if (!(await jobIsInPaidPayout(tx, invoice.interventionId))) await syncFinancials(tx, invoice.interventionId, { userId: user.id });

      return cancelled;
    });

    await this.createEvent({
      interventionId: invoice.interventionId,
      type: InterventionEventType.CANCELLED,
      title: 'Facture annulée',
      // The reason the back office gives is kept on the invoice and here in the data, not in the
      // line that the customer reads.
      message: `La facture ${invoice.invoiceNumber} a été annulée.`,
      createdById: user.id,
      metadata: {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        reason: dto.reason,
      },
    });

    return updated;
  }

  /** An invoice that is paid, or has a credit note, is taken back by a credit note, not cancelled: its number and its amounts stay in the books. */
  private ensureCanBeCancelled(invoice: { status: unknown; creditedAmount?: unknown }) {
    if (invoice.status === InvoiceStatus.PAID) {
      throw new BadRequestException(
        'Une facture payée ne peut pas être annulée : émettez un avoir, puis remboursez le client si besoin.',
      );
    }

    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException('Cette facture est déjà annulée.');
    }

    if (compareMoney(money(invoice.creditedAmount as any), 0) > 0) {
      throw new BadRequestException('Cette facture a déjà un avoir : émettez un avoir pour le reste au lieu de l’annuler.');
    }
  }

  // ==========================================================
  // Admin: credit note (avoir)
  // ==========================================================

  /**
   * Takes back all or part of an invoice that was issued (P2-07), with a credit note of its own number. For an invoice that was
   * paid this is how it is corrected: the money that went back to the customer is a refund of the payment, made in the usual way;
   * the credit note is the document. An invoice that all its credit notes took back is cancelled (and a new one can be made for the
   * job). A part leaves the invoice, now for less: it is paid again when what the customer kept covers what is left.
   */
  async createCreditNote(user: AuthenticatedUser, invoiceId: number, dto: CreditNoteDto) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    const reason = typeof dto?.reason === 'string' ? dto.reason.trim() : '';

    if (!reason) throw new BadRequestException('Le motif de l’avoir est obligatoire : le client le lit sur le document.');
    if (reason.length > CREDIT_REASON_MAX) throw new BadRequestException(`Le motif de l’avoir est limité à ${CREDIT_REASON_MAX} caractères.`);

    const header = await this.getInvoiceOrFail(invoiceId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, header.interventionId);

      // Read again under the lock: a payment, a cancellation or another credit note may have come in.
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { creditNotes: true } });

      if (!invoice) throw new NotFoundException('Facture introuvable.');

      if (![InvoiceStatus.ISSUED, InvoiceStatus.SENT, InvoiceStatus.PAID].some((status) => status === invoice.status)) {
        throw new BadRequestException('Un avoir ne se fait que sur une facture émise : ni brouillon, ni annulée.');
      }

      const totals = creditNoteTotals(invoice, invoice.creditNotes, dto.amountTTC);

      // Two clicks on the button are two requests: the second finds the credit note of the first and does not make another (each one takes
      // a number of the series for good).
      const repeated = invoice.creditNotes.find(
        (earlier) =>
          earlier.reason === reason &&
          compareMoney(money(earlier.amountTTC), totals.amountTTC) === 0 &&
          Date.now() - new Date(earlier.issuedAt).getTime() < CREDIT_NOTE_REPEAT_MS,
      );

      if (repeated) {
        throw new ConflictException(`L’avoir ${repeated.creditNoteNumber} vient d’être émis avec le même montant et le même motif. Patientez une minute pour en émettre un autre identique.`);
      }

      const given = await takeDocumentNumber(tx, 'CREDIT_NOTE');

      const note = await tx.creditNote.create({
        data: {
          invoiceId,
          interventionId: invoice.interventionId,
          creditNoteNumber: given.number,
          numberYear: given.year,
          sequence: given.sequence,
          reason,
          currency: invoice.currency,
          amountHT: totals.amountHT,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          amountTTC: totals.amountTTC,
          stampDuty: totals.stampDuty,
          createdById: user.id,
          issuedAt: given.issuedAt,
        },
      });

      const creditedAmount = sumMoney(invoice.creditedAmount, totals.amountTTC, totals.stampDuty);

      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: totals.closes
          ? { creditedAmount, status: InvoiceStatus.CANCELLED, cancelledAt: given.issuedAt, cancelReason: `Avoir ${note.creditNoteNumber}` }
          : { creditedAmount },
      });

      // A part leaves the invoice for less: it follows the payments again (a deposit may now cover it).
      if (!totals.closes) await settleInvoice(tx, invoice.interventionId, given.issuedAt);

      if (!(await jobIsInPaidPayout(tx, invoice.interventionId))) await syncFinancials(tx, invoice.interventionId, { userId: user.id });

      // What the customer still holds above what they now owe: to be given back by a refund of the payment.
      const payments = await tx.payment.findMany({ where: { interventionId: invoice.interventionId } });
      const kept = paymentFigures(payments).kept;
      const owed = totals.closes ? 0 : amountToPay(updated);
      const refundToMake = compareMoney(kept, owed) > 0 ? money(kept - owed) : 0;

      return { note, invoiceNumber: invoice.invoiceNumber, closes: totals.closes, refundToMake };
    });

    await this.createEvent({
      interventionId: header.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Avoir émis',
      // The reason is printed on the credit note; the line of the timeline says that there is one.
      message: `L’avoir ${outcome.note.creditNoteNumber} de ${formatMoney(outcome.note.amountTTC, { currency: outcome.note.currency })} a été émis sur la facture ${outcome.invoiceNumber}.`,
      createdById: user.id,
      metadata: {
        invoiceId,
        creditNoteId: outcome.note.id,
        creditNoteNumber: outcome.note.creditNoteNumber,
        amountTTC: money(outcome.note.amountTTC),
        closesInvoice: outcome.closes,
      },
    });

    return { creditNote: outcome.note, invoice: await this.getInvoiceOrFail(invoiceId), refundToMake: outcome.refundToMake };
  }

  // ==========================================================
  // Admin: export invoices
  // JSON or CSV
  // ==========================================================

  async exportInvoices(user: AuthenticatedUser, query: ExportInvoicesQuery) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    const where: Prisma.InvoiceWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.paymentStatus) {
      where.paymentStatus = query.paymentStatus;
    }

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};

      if (query.dateFrom) {
        where.createdAt.gte = new Date(query.dateFrom);
      }

      if (query.dateTo) {
        where.createdAt.lte = new Date(query.dateTo);
      }
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: this.invoiceInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });

    const rows = invoices.map((invoice) => this.toExportRow(invoice));

    if (query.format === 'csv') {
      return {
        format: 'csv',
        filename: `invoices-export-${new Date().toISOString().slice(0, 10)}.csv`,
        content: this.buildCsv(rows),
      };
    }

    return {
      format: 'json',
      count: rows.length,
      rows,
    };
  }
}
