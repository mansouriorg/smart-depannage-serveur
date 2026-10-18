import {
  BadRequestException,
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
import { invoiceForArtisan, invoiceForClient } from '../../common/views/views';

import {
  InterventionEventType,
  InvoiceStatus,
  PaymentStatus,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';

type InvoiceEmailDto = {
  email?: string;
  message?: string;
};

type CancelInvoiceDto = {
  reason?: string;
};

type ExportInvoicesQuery = {
  status?: InvoiceStatus;
  paymentStatus?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
  format?: 'json' | 'csv';
};

type SetInvoicePdfDto = {
  pdfUrl: string;
};

type AuthenticatedUser = {
  id: number;
  role: Role;
};

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
    const adminRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return adminRoles.includes(role);
  }

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private generateInvoiceNumber(): string {
    const d = new Date();

    return `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(
      2,
      '0',
    )}-${Date.now()}`;
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
        invoice: true,
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
        payments: {
          where: {
            status: PaymentStatus.PAID,
          },
          orderBy: {
            createdAt: 'desc',
          },
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

  private calculateTotalsFromAmount(amountHT: number, taxRate = 20) {
    if (!Number.isFinite(amountHT) || amountHT <= 0) {
      throw new BadRequestException('Montant HT invalide.');
    }

    if (!Number.isFinite(taxRate) || taxRate < 0) {
      throw new BadRequestException('Taux de TVA invalide.');
    }

    const taxAmount = this.roundMoney(amountHT * (taxRate / 100));
    const amountTTC = this.roundMoney(amountHT + taxAmount);

    return {
      amountHT: this.roundMoney(amountHT),
      taxRate,
      taxAmount,
      amountTTC,
    };
  }

  private calculateTotalsFromItems(
    items: {
      label: string;
      description?: string | null;
      quantity: number;
      unitPrice: number;
    }[],
    taxRate = 20,
  ) {
    if (!items?.length) {
      throw new BadRequestException(
        'La facture doit contenir au moins une ligne.',
      );
    }

    const normalizedItems = items.map((item) => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);

      if (!item.label?.trim()) {
        throw new BadRequestException(
          'Chaque ligne de facture doit avoir un libellé.',
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

      return {
        label: item.label,
        description: item.description || undefined,
        quantity,
        unitPrice,
        total: this.roundMoney(quantity * unitPrice),
      };
    });

    const amountHT = this.roundMoney(
      normalizedItems.reduce((sum, item) => sum + item.total, 0),
    );

    const totals = this.calculateTotalsFromAmount(amountHT, taxRate);

    return {
      ...totals,
      items: normalizedItems,
    };
  }

  private getInvoiceItemsFromQuote(quote: any) {
    return quote.items.map((item) => ({
      label: item.label,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
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
      amountHT: invoice.amountHT,
      taxRate: invoice.taxRate,
      taxAmount: invoice.taxAmount,
      amountTTC: invoice.amountTTC,
      issuedAt: invoice.issuedAt,
      sentAt: invoice.sentAt,
      paidAt: invoice.paidAt,
      cancelledAt: invoice.cancelledAt,
      createdAt: invoice.createdAt,
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

    if (
      intervention.invoice &&
      intervention.invoice.status !== InvoiceStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Une facture existe déjà pour cette intervention.',
      );
    }

    const company = await this.getCompanySettings();

    const quote = intervention.quotes[0];
    const paidPayment = intervention.payments[0];

    const amountHT = dto.amountHT ?? quote?.amountHT;
    const taxRate = dto.taxRate ?? quote?.taxRate ?? company?.defaultTaxRate ?? 20;

    if (!amountHT) {
      throw new BadRequestException(
        'Montant HT introuvable. Utilisez un devis accepté ou envoyez un montant HT.',
      );
    }

    const totals = this.calculateTotalsFromAmount(amountHT, taxRate);

    const invoiceItems = quote?.items?.length
      ? this.getInvoiceItemsFromQuote(quote)
      : [
          {
            label:
              intervention.subService?.name ||
              String(intervention.serviceType),
            description: intervention.description,
            quantity: 1,
            unitPrice: totals.amountHT,
            total: totals.amountHT,
          },
        ];

    const invoice = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          interventionId,
          invoiceNumber: dto.invoiceNumber || this.generateInvoiceNumber(),

          status: paidPayment ? InvoiceStatus.PAID : InvoiceStatus.ISSUED,
          paymentStatus: paidPayment
            ? PaymentStatus.PAID
            : PaymentStatus.PENDING,

          companyName: company?.companyName,
          companyPhone: company?.companyPhone,
          companyEmail: company?.companyEmail,
          companyAddress: undefined,
          companyTaxId: undefined,
          companyWebsite: undefined,

          clientName: intervention.contactName || intervention.client.name,
          clientEmail: intervention.contactEmail || intervention.client.email,
          clientPhone: intervention.contactPhone || intervention.client.phone,
          clientAddress: intervention.address,

          interventionDescription: intervention.description,
          interventionAddress: intervention.address,
          serviceType: intervention.serviceType,
          subServiceName: intervention.subService?.name,

          amountHT: totals.amountHT,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          amountTTC: totals.amountTTC,

          pdfUrl: dto.pdfUrl,
          notes: dto.notes,
          issuedAt: new Date(),
          paidAt: paidPayment ? new Date() : undefined,

          items: {
            create: invoiceItems,
          },
        },
        include: this.invoiceInclude,
      });

      if (paidPayment) {
        await tx.payment.update({
          where: {
            id: paidPayment.id,
          },
          data: {
            invoiceId: created.id,
          },
        });
      }

      await transitionStatus(tx, {
        id: interventionId,
        to: Status.INVOICE_SENT,
        actor: { kind: 'system' },
        data: { invoiceSentAt: new Date() },
        soft: true,
      });

      return created;
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
        amountTTC: invoice.amountTTC,
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
    const invoice = await this.prisma.invoice.findUnique({
      where: {
        interventionId,
      },
      include: this.invoiceInclude,
    });

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
      message: invoice.pdfUrl
        ? 'PDF disponible.'
        : 'Aucun PDF généré pour le moment. Vous pouvez générer le PDF côté frontend avec ces données.',
    };
  }

  // ==========================================================
  // General download for admin/client/artisan
  // ==========================================================

  async downloadInvoice(user: AuthenticatedUser, invoiceId: number) {
    const invoice = await this.findOne(user, invoiceId);

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      pdfUrl: invoice.pdfUrl,
      invoice,
      message: invoice.pdfUrl
        ? 'PDF disponible.'
        : 'Aucun PDF généré pour le moment. Utilisez les données de la facture pour afficher ou imprimer la facture côté frontend.',
    };
  }

  // ==========================================================
  // Admin: set PDF URL
  // ==========================================================

  async setPdfUrl(
    user: AuthenticatedUser,
    invoiceId: number,
    dto: SetInvoicePdfDto,
  ) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }

    await this.getInvoiceOrFail(invoiceId);

    return this.prisma.invoice.update({
      where: {
        id: invoiceId,
      },
      data: {
        pdfUrl: dto.pdfUrl,
      },
      include: this.invoiceInclude,
    });
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

    const message =
      dto.message ||
      `Bonjour,

Votre facture ${invoice.invoiceNumber} d’un montant de ${invoice.amountTTC} € TTC est disponible.

${invoice.pdfUrl ? `Lien PDF : ${invoice.pdfUrl}` : 'Le PDF sera disponible prochainement.'}

Cordialement.`;

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
      `Votre facture ${invoice.invoiceNumber}`,
      message,
    );

    if (!queued.queued) {
      throw new ServiceUnavailableException(
        "L'e-mail n'a pas pu être préparé pour l'envoi. Réessayez dans un instant.",
      );
    }

    const updated = await this.prisma.invoice.update({
      where: {
        id: invoiceId,
      },
      data: {
        status:
          invoice.status === InvoiceStatus.PAID
            ? InvoiceStatus.PAID
            : InvoiceStatus.SENT,
        sentAt: new Date(),
        emailedTo: email,
      },
      include: this.invoiceInclude,
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

    if (invoice.status === InvoiceStatus.PAID) {
      throw new BadRequestException(
        'Une facture payée ne peut pas être annulée sans remboursement ou avoir.',
      );
    }

    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException('Cette facture est déjà annulée.');
    }

    const updated = await this.prisma.invoice.update({
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
