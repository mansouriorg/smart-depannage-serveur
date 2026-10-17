import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { AdminPaymentActionDto } from './dto/admin-payment-action.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { transitionStatus } from '../intervention-workflow/transition-status';

import {
  InterventionEventType,
  InvoiceStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  Role,
  Status,
} from '../../../generated/prisma/client';
import { isBackOffice } from '../../common/auth/role-policy';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private paymentInclude = {
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
    quote: {
      include: {
        items: {
          orderBy: {
            id: 'asc' as const,
          },
        },
      },
    },
    invoice: true,
  };

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private generateReceiptNumber(paymentId: number, date: Date = new Date()): string {
    const year = date.getFullYear();
    return `RCPT-${year}-${String(paymentId).padStart(6, '0')}`;
  }

  private getOptionalNumber(dto: any, key: string): number | undefined {
    const value = dto?.[key];

    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const numberValue = Number(value);

    if (!Number.isFinite(numberValue)) {
      return undefined;
    }

    return numberValue;
  }

  private getOptionalString(dto: any, key: string): string | undefined {
    const value = dto?.[key];

    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return String(value);
  }

  private providerFromMethod(method: PaymentMethod): PaymentProvider {
    switch (method) {
      case PaymentMethod.CASH:
        return PaymentProvider.CASH;

      case PaymentMethod.BANK_TRANSFER:
        return PaymentProvider.BANK_TRANSFER;

      case PaymentMethod.ONLINE:
      case PaymentMethod.ONLINE_CARD:
      default:
        return PaymentProvider.MANUAL;
    }
  }

  private initialStatusFromMethod(method: PaymentMethod): PaymentStatus {
    switch (method) {
      case PaymentMethod.CASH:
      case PaymentMethod.BANK_TRANSFER:
        return PaymentStatus.AWAITING_CONFIRMATION;

      case PaymentMethod.ONLINE:
      case PaymentMethod.ONLINE_CARD:
      default:
        return PaymentStatus.PENDING;
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

  private async getPaymentOrFail(paymentId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: this.paymentInclude,
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return payment;
  }

  private async getClientIntervention(clientId: number, interventionId: number) {
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
        quotes: {
          where: {
            status: 'ACCEPTED',
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
        invoice: true,
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

  private async getInterventionOrFail(interventionId: number) {
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
        quotes: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        invoice: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private ensurePaymentCanBeConfirmed(payment: any) {
    const confirmableStatuses: PaymentStatus[] = [
      PaymentStatus.PENDING,
      PaymentStatus.AWAITING_CONFIRMATION,
      PaymentStatus.FAILED,
    ];

    if (!confirmableStatuses.includes(payment.status)) {
      throw new BadRequestException(
        `Ce paiement ne peut pas être confirmé car son statut est ${payment.status}.`,
      );
    }
  }

  private ensurePaymentCanBeCancelled(payment: any) {
    const cancellableStatuses: PaymentStatus[] = [
      PaymentStatus.PENDING,
      PaymentStatus.AWAITING_CONFIRMATION,
      PaymentStatus.FAILED,
    ];

    if (!cancellableStatuses.includes(payment.status)) {
      throw new BadRequestException(
        `Ce paiement ne peut pas être annulé car son statut est ${payment.status}.`,
      );
    }
  }

  private ensurePaymentCanBeRefunded(payment: any) {
    const refundableStatuses: PaymentStatus[] = [
      PaymentStatus.PAID,
      PaymentStatus.PARTIALLY_REFUNDED,
    ];

    if (!refundableStatuses.includes(payment.status)) {
      throw new BadRequestException(
        'Seuls les paiements payés peuvent être remboursés.',
      );
    }
  }

  private async validateLinkedInvoice(
    interventionId: number,
    invoiceId?: number,
  ) {
    if (!invoiceId) {
      return undefined;
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    if (invoice.interventionId !== interventionId) {
      throw new BadRequestException(
        'La facture ne correspond pas à cette intervention.',
      );
    }

    return invoice;
  }

  // ==========================================================
  // Client creates payment request
  // Cash / bank transfer / online placeholder
  // ==========================================================

  async createClientPaymentRequest(
    clientId: number,
    interventionId: number,
    dto: CreateManualPaymentDto,
  ) {
    const intervention = await this.getClientIntervention(
      clientId,
      interventionId,
    );

    const acceptedQuote = intervention.quotes[0];

    const invoiceId = this.getOptionalNumber(dto, 'invoiceId');
    const invoice = await this.validateLinkedInvoice(interventionId, invoiceId);

    const amountFromDto = this.getOptionalNumber(dto, 'amount');
    const amount = this.roundMoney(
      amountFromDto ?? invoice?.amountTTC ?? acceptedQuote?.amountTTC ?? 0,
    );

    if (!amount || amount <= 0) {
      throw new BadRequestException(
        'Montant introuvable. Acceptez un devis, liez une facture ou envoyez un montant.',
      );
    }

    const providerFromDto = this.getOptionalString(dto, 'provider') as
      | PaymentProvider
      | undefined;

    const payment = await this.prisma.payment.create({
      data: {
        interventionId,
        quoteId: acceptedQuote?.id,
        invoiceId,
        method: dto.method,
        provider: providerFromDto || this.providerFromMethod(dto.method),
        status: this.initialStatusFromMethod(dto.method),
        amount,
        amountRefunded: 0,
        currency: this.getOptionalString(dto, 'currency') || 'EUR',
        reference: dto.reference,
        clientNote: dto.clientNote,
        createdById: clientId,
      },
      include: this.paymentInclude,
    });

    // The payment request is recorded whatever the job status is; the job only
    // moves to PAYMENT_PENDING when the work is done (never while it is in progress).
    await transitionStatus(this.prisma, {
      id: interventionId,
      to: Status.PAYMENT_PENDING,
      actor: { kind: 'client', userId: clientId },
      data: { paymentPendingAt: new Date() },
      soft: true,
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement en attente',
      message:
        dto.method === PaymentMethod.ONLINE ||
        dto.method === PaymentMethod.ONLINE_CARD
          ? 'Le paiement en ligne est enregistré comme demande en attente. Aucun prestataire externe n’est encore connecté.'
          : `Paiement ${dto.method} en attente de confirmation.`,
      createdById: clientId,
      metadata: {
        paymentId: payment.id,
        method: payment.method,
        provider: payment.provider,
        amount: payment.amount,
        currency: payment.currency,
        quoteId: payment.quoteId,
        invoiceId: payment.invoiceId,
      },
    });

    return {
      ...payment,
      instructions: this.getPaymentInstructions(dto.method),
    };
  }

  getPaymentInstructions(method: PaymentMethod) {
    if (method === PaymentMethod.CASH) {
      return 'Paiement en espèces à remettre à l’artisan ou à confirmer par l’administrateur.';
    }

    if (method === PaymentMethod.BANK_TRANSFER) {
      return 'Effectuez le virement bancaire puis envoyez la référence du virement. Confirmation manuelle par l’administrateur.';
    }

    if (method === PaymentMethod.ONLINE_CARD) {
      return 'Paiement par carte non connecté pour le moment. Cette demande reste en attente jusqu’à intégration d’un prestataire.';
    }

    return 'Paiement en ligne non connecté pour le moment. Cette demande reste en attente jusqu’à intégration d’un prestataire.';
  }

  // ==========================================================
  // Client payments for one intervention
  // ==========================================================

  async findForClient(clientId: number, interventionId: number) {
    await this.getClientIntervention(clientId, interventionId);

    return this.prisma.payment.findMany({
      where: {
        interventionId,
      },
      include: this.paymentInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ==========================================================
  // Admin / accounting list
  // ==========================================================

  async findAllAdmin(params?: {
    status?: PaymentStatus;
    method?: PaymentMethod;
    interventionId?: number;
  }) {
    const where: Prisma.PaymentWhereInput = {};

    if (params?.status) {
      where.status = params.status;
    }

    if (params?.method) {
      where.method = params.method;
    }

    if (params?.interventionId) {
      where.interventionId = params.interventionId;
    }

    return this.prisma.payment.findMany({
      where,
      include: this.paymentInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(paymentId: number) {
    return this.getPaymentOrFail(paymentId);
  }

  // ==========================================================
  // Admin manual confirmation
  // ==========================================================

  async confirm(
    paymentId: number,
    adminId: number,
    dto: AdminPaymentActionDto,
  ) {
    const payment = await this.getPaymentOrFail(paymentId);

    this.ensurePaymentCanBeConfirmed(payment);

    const reference = this.getOptionalString(dto, 'reference');
    const receiptNumber =
      payment.receiptNumber || this.generateReceiptNumber(payment.id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const confirmedPayment = await tx.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          status: PaymentStatus.PAID,
          confirmedAt: new Date(),
          confirmedById: adminId,
          reference: reference || payment.reference,
          adminNote: dto.adminNote,
          receiptNumber,
          receiptGeneratedAt: payment.receiptGeneratedAt || new Date(),
        },
        include: this.paymentInclude,
      });

      await transitionStatus(tx, {
        id: payment.interventionId,
        to: Status.PAID,
        actor: { kind: 'staff', userId: adminId },
        data: { paidAt: new Date() },
        soft: true,
      });

      if (payment.invoiceId) {
        await tx.invoice.update({
          where: {
            id: payment.invoiceId,
          },
          data: {
            status: InvoiceStatus.PAID,
            paidAt: new Date(),
          },
        });
      }

      return confirmedPayment;
    });

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.PAYMENT_CONFIRMED,
      title: 'Paiement confirmé',
      message: `Le paiement de ${payment.amount} ${payment.currency} a été confirmé.`,
      createdById: adminId,
      metadata: {
        paymentId,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        provider: payment.provider,
        reference: updated.reference,
        receiptNumber: updated.receiptNumber,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin marks payment as failed
  // ==========================================================

  async fail(paymentId: number, adminId: number, dto: AdminPaymentActionDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    const statusesThatCannotFail: PaymentStatus[] = [
      PaymentStatus.PAID,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
    ];

    if (statusesThatCannotFail.includes(payment.status)) {
      throw new BadRequestException(
        'Un paiement payé ou remboursé ne peut pas être marqué comme échoué.',
      );
    }

    const reason =
      this.getOptionalString(dto, 'reason') ||
      dto.adminNote ||
      'Le paiement a échoué.';

    const updated = await this.prisma.payment.update({
      where: {
        id: paymentId,
      },
      data: {
        status: PaymentStatus.FAILED,
        failedAt: new Date(),
        failureReason: reason,
        adminNote: dto.adminNote,
      },
      include: this.paymentInclude,
    });

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Paiement échoué',
      message: reason,
      createdById: adminId,
      metadata: {
        paymentId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin cancels payment
  // ==========================================================

  async cancel(paymentId: number, adminId: number, dto: AdminPaymentActionDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    this.ensurePaymentCanBeCancelled(payment);

    const reason =
      this.getOptionalString(dto, 'reason') ||
      dto.adminNote ||
      'Le paiement a été annulé.';

    const updated = await this.prisma.payment.update({
      where: {
        id: paymentId,
      },
      data: {
        status: PaymentStatus.CANCELLED,
        cancelledAt: new Date(),
        adminNote: dto.adminNote,
      },
      include: this.paymentInclude,
    });

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.CANCELLED,
      title: 'Paiement annulé',
      message: reason,
      createdById: adminId,
      metadata: {
        paymentId,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin refund / partial refund
  // ==========================================================

  async refund(paymentId: number, adminId: number, dto: AdminPaymentActionDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    this.ensurePaymentCanBeRefunded(payment);

    const amountFromDto = this.getOptionalNumber(dto, 'amount');
    const refundAmount = this.roundMoney(amountFromDto ?? payment.amount);

    if (refundAmount <= 0) {
      throw new BadRequestException(
        'Le montant du remboursement doit être supérieur à 0.',
      );
    }

    const alreadyRefunded = payment.amountRefunded || 0;
    const newRefundedTotal = this.roundMoney(alreadyRefunded + refundAmount);

    if (newRefundedTotal > payment.amount) {
      throw new BadRequestException(
        'Le montant total remboursé ne peut pas dépasser le montant du paiement.',
      );
    }

    const isFullRefund = newRefundedTotal === payment.amount;

    const reason =
      this.getOptionalString(dto, 'reason') ||
      dto.adminNote ||
      `Remboursement de ${refundAmount} ${payment.currency}.`;

    const updated = await this.prisma.payment.update({
      where: {
        id: paymentId,
      },
      data: {
        status: isFullRefund
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED,
        amountRefunded: newRefundedTotal,
        refundedAt: new Date(),
        refundedById: adminId,
        refundReason: reason,
        adminNote: dto.adminNote,
      },
      include: this.paymentInclude,
    });

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: isFullRefund
        ? 'Remboursement enregistré'
        : 'Remboursement partiel enregistré',
      message: reason,
      createdById: adminId,
      metadata: {
        paymentId,
        refundAmount,
        totalRefunded: newRefundedTotal,
        isFullRefund,
      },
    });

    return updated;
  }

  // ==========================================================
  // Generate receipt data
  // No external PDF generator for now
  // ==========================================================

  async generateReceipt(
    paymentId: number,
    user: { id: number; role: Role },
  ) {
    const payment = await this.getPaymentOrFail(paymentId);

    // P0-06: a receipt shows the names, e-mails and phones of both parties.
    // Only back-office staff, the client who paid and the artisan of the job
    // may read it. Anyone else gets the same 404 as for an unknown id.
    const intervention = payment.intervention;

    const isOwnerClient =
      user.role === Role.CLIENT && intervention.clientId === user.id;
    const isAssignedArtisan =
      user.role === Role.ARTISAN && intervention.artisanId === user.id;

    if (!isBackOffice(user.role) && !isOwnerClient && !isAssignedArtisan) {
      throw new NotFoundException('Paiement introuvable.');
    }

    if (payment.status !== PaymentStatus.PAID) {
      throw new BadRequestException(
        'Un reçu peut être généré uniquement pour un paiement payé.',
      );
    }

    // P0-06: reading a receipt must not write to the database. The number and
    // date are assigned when the payment is confirmed (see confirm()); for
    // older rows without them we derive the same values from existing data.
    const receiptNumber =
      payment.receiptNumber ||
      this.generateReceiptNumber(
        payment.id,
        payment.confirmedAt ?? payment.createdAt,
      );
    const receiptDate =
      payment.receiptGeneratedAt ?? payment.confirmedAt ?? payment.createdAt;

    return {
      receiptNumber,
      receiptUrl: payment.receiptUrl,
      generatedAt: receiptDate,
      payment,
      receipt: {
        number: receiptNumber,
        date: receiptDate,
        amount: payment.amount,
        amountRefunded: payment.amountRefunded,
        currency: payment.currency,
        method: payment.method,
        provider: payment.provider,
        reference: payment.reference,
        interventionId: payment.interventionId,
        quoteId: payment.quoteId,
        invoiceId: payment.invoiceId,
        client: payment.intervention.client,
        artisan: payment.intervention.artisan,
      },
      message:
        'Reçu généré côté backend. Vous pouvez utiliser ces données pour afficher ou imprimer le reçu côté frontend.',
    };
  }

  // ==========================================================
  // Attach receipt PDF URL later
  // ==========================================================

  async setReceiptUrl(paymentId: number, receiptUrl: string) {
    const payment = await this.getPaymentOrFail(paymentId);

    return this.prisma.payment.update({
      where: {
        id: paymentId,
      },
      data: {
        receiptUrl,
        receiptNumber:
          payment.receiptNumber ||
          this.generateReceiptNumber(
            payment.id,
            payment.confirmedAt ?? payment.createdAt,
          ),
        receiptGeneratedAt: payment.receiptGeneratedAt || new Date(),
      },
      include: this.paymentInclude,
    });
  }

  // ==========================================================
  // Link payment to invoice
  // ==========================================================

  async linkToInvoice(paymentId: number, invoiceId: number) {
    const payment = await this.getPaymentOrFail(paymentId);

    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    if (invoice.interventionId !== payment.interventionId) {
      throw new BadRequestException(
        'La facture ne correspond pas à l’intervention du paiement.',
      );
    }

    return this.prisma.payment.update({
      where: {
        id: paymentId,
      },
      data: {
        invoiceId,
      },
      include: this.paymentInclude,
    });
  }

  // ==========================================================
  // Admin creates manual payment directly
  // Useful for cash/bank transfer recorded from dashboard
  // ==========================================================

  async createAdminManualPayment(
    adminId: number,
    interventionId: number,
    dto: CreateManualPaymentDto,
  ) {
    const intervention = await this.getInterventionOrFail(interventionId);

    const acceptedQuote = intervention.quotes.find(
      (quote) => quote.status === 'ACCEPTED',
    );

    const invoiceId = this.getOptionalNumber(dto, 'invoiceId');
    const invoice = await this.validateLinkedInvoice(interventionId, invoiceId);

    const amountFromDto = this.getOptionalNumber(dto, 'amount');
    const amount = this.roundMoney(
      amountFromDto ?? invoice?.amountTTC ?? acceptedQuote?.amountTTC ?? 0,
    );

    if (!amount || amount <= 0) {
      throw new BadRequestException(
        'Montant introuvable. Envoyez un montant, liez une facture ou utilisez un devis accepté.',
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        interventionId,
        quoteId: acceptedQuote?.id,
        invoiceId,
        method: dto.method,
        provider: this.providerFromMethod(dto.method),
        status: this.initialStatusFromMethod(dto.method),
        amount,
        amountRefunded: 0,
        currency: this.getOptionalString(dto, 'currency') || 'EUR',
        reference: dto.reference,
        clientNote: dto.clientNote,
        adminNote: this.getOptionalString(dto, 'adminNote'),
        createdById: adminId,
      },
      include: this.paymentInclude,
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement créé par l’administration',
      message: `Un paiement de ${payment.amount} ${payment.currency} a été créé par l’administration.`,
      createdById: adminId,
      metadata: {
        paymentId: payment.id,
        method: payment.method,
        amount: payment.amount,
        currency: payment.currency,
      },
    });

    return payment;
  }
}
