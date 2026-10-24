import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { CancelPaymentDto, ConfirmPaymentDto, FailPaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { claimOpenPayment, leftToPay, refreshOpenPayment } from './open-payment';
import { ensureJobTakesPayment, ensureMethodOffered } from './payment-options';
import { settleInvoice } from '../invoices/invoice-settlement';
import { amountToPay, isLiveInvoice, liveInvoiceOf, paymentFigures, settleComplaintRefund, syncFinancials } from './financials-ops';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { NotificationsService } from '../notifications/notifications.service';
import { lockJob } from '../assignment/artisan-lock';
import { paymentPosition, reverseCollectionsOfPayment, settleCashOnConfirm } from '../cash-ledger/cash-ledger-ops';

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
import { pick } from '../../common/views/pick';
import { paymentForArtisan, paymentForClient } from '../../common/views/views';
import { compareMoney, formatMoney, money, subtractMoney, sumMoney } from '../../common/money/money';
import { currencyCode } from '../../common/locale/locale';
import { businessYearMonth } from '../../common/locale/business-time';

/** The listed keys of a person (a name and a number, an address only where it is the reader's own). */
function pickPerson(person: any, keys: string[]) {
  return person ? pick(person, keys) : person;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
    private readonly notifications: NotificationsService,
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

  private generateReceiptNumber(paymentId: number, date: Date = new Date()): string {
    const { year } = businessYearMonth(date);
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
        invoices: true,
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
        invoices: true,
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

  private ensurePaymentCanFail(payment: any) {
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

    // A cancelled payment is over: failing it would make it one that can be confirmed again.
    if (payment.status === PaymentStatus.CANCELLED) {
      throw new BadRequestException(
        'Un paiement annulé ne peut pas être marqué comme échoué.',
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

  /** The invoice of the job when it asks something of the customer (not cancelled, not a draft). */
  private async liveInvoiceOf(interventionId: number) {
    return (await liveInvoiceOf(this.prisma, interventionId)) ?? undefined;
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

    // Only a way of paying the company offers: the settings are the company's, whichever way the customer comes in (P2-06).
    await ensureMethodOffered(this.prisma, dto.method);
    ensureJobTakesPayment(intervention.status);

    const acceptedQuote = intervention.quotes[0];

    const invoiceId = this.getOptionalNumber(dto, 'invoiceId');
    const amountFromDto = this.getOptionalNumber(dto, 'amount');
    const named = await this.validateLinkedInvoice(interventionId, invoiceId);

    // A customer pays an invoice that is out: a draft is not theirs yet and a cancelled one asks nothing.
    if (named && !isLiveInvoice(named)) {
      throw new NotFoundException('Facture introuvable.');
    }

    // Nothing named and nothing typed: the invoice that is out is what is asked, as for a visitor of the tracking page (the two
    // ways in ask the same amount, and a payment is linked to the invoice it pays).
    const invoice = named ?? (amountFromDto === undefined ? await this.liveInvoiceOf(interventionId) : undefined);
    const asked = money(amountFromDto ?? (invoice ? amountToPay(invoice) : undefined) ?? acceptedQuote?.amountTTC ?? 0);
    // The currency is the one of the document that is paid, else the one of the company: never one typed by the payer.
    const currency = invoice?.currency ?? acceptedQuote?.currency ?? currencyCode();

    if (!asked || asked <= 0) {
      throw new BadRequestException(
        'Montant introuvable. Acceptez un devis, liez une facture ou envoyez un montant.',
      );
    }

    const providerFromDto = this.getOptionalString(dto, 'provider') as
      | PaymentProvider
      | undefined;

    const { payment, reused } = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, interventionId);

      // No amount typed: what is left to pay (a deposit that was paid is not asked for twice).
      const amount = amountFromDto !== undefined ? asked : await leftToPay(tx, interventionId, asked, currency);

      // One open payment per job: the same request again is answered with the open payment, another one is refused.
      const open = await claimOpenPayment(tx, { interventionId, method: dto.method, amount, derived: amountFromDto === undefined, clientId });

      if (open) {
        // The reference of the transfer, sent after it was made, is kept on the open payment.
        await refreshOpenPayment(tx, open, { reference: dto.reference, clientNote: dto.clientNote });

        // A request made during the work and asked for again when the work is done moves the job then (it does nothing when
        // the job is already waiting for payment, or still being worked on).
        await transitionStatus(tx, {
          id: interventionId,
          to: Status.PAYMENT_PENDING,
          actor: { kind: 'client', userId: clientId },
          dataOnChange: { paymentPendingAt: new Date() },
          soft: true,
        });

        return { payment: (await tx.payment.findUnique({ where: { id: open.id }, include: this.paymentInclude })) as any, reused: true };
      }

      const created = await tx.payment.create({
        data: {
          interventionId,
          quoteId: acceptedQuote?.id,
          invoiceId: invoice?.id,
          method: dto.method,
          provider: providerFromDto || this.providerFromMethod(dto.method),
          status: this.initialStatusFromMethod(dto.method),
          amount,
          amountRefunded: 0,
          currency,
          reference: dto.reference,
          clientNote: dto.clientNote,
          createdById: clientId,
        },
        include: this.paymentInclude,
      });

      // The payment request is recorded whatever the job status is; the job only moves to PAYMENT_PENDING when the work is
      // done (never while it is in progress, and the date of the request is written only when it moves).
      await transitionStatus(tx, {
        id: interventionId,
        to: Status.PAYMENT_PENDING,
        actor: { kind: 'client', userId: clientId },
        dataOnChange: { paymentPendingAt: new Date() },
        soft: true,
      });

      return { payment: created as any, reused: false };
    });

    if (reused) {
      return {
        ...paymentForClient(payment),
        instructions: this.getPaymentInstructions(dto.method),
        replayed: true,
      };
    }

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
        amount: money(payment.amount),
        currency: payment.currency,
        quoteId: payment.quoteId,
        invoiceId: payment.invoiceId,
      },
    });

    return {
      ...paymentForClient(payment),
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

    const payments = await this.prisma.payment.findMany({
      where: {
        interventionId,
      },
      include: this.paymentInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });

    return payments.map((payment) => paymentForClient(payment));
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
    dto: ConfirmPaymentDto,
  ) {
    const payment = await this.getPaymentOrFail(paymentId);

    // A second click on a payment that is already confirmed is answered with the payment as it is: one confirmation.
    if (payment.status === PaymentStatus.PAID) {
      return payment;
    }

    this.ensurePaymentCanBeConfirmed(payment);

    const reference = this.getOptionalString(dto, 'reference');
    const receiptNumber =
      payment.receiptNumber || this.generateReceiptNumber(payment.id);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: a cancel or a fail may have come in between, or another click on confirm.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      if (current.status === PaymentStatus.PAID) {
        return { replayed: true, confirmed: await tx.payment.findUnique({ where: { id: paymentId }, include: this.paymentInclude }) };
      }

      this.ensurePaymentCanBeConfirmed(current);

      // Nothing is confirmed above what the job has to pay: the figures of the job are worked out from what was confirmed.
      await this.ensureRoomLeft(tx, current);

      // A cash payment is in the artisan's ledger once it is confirmed: the cash they declared stays (or counts again, when
      // the payment had failed), and cash nobody declared is written now. Before the payment is marked as paid, so that what
      // it brings is not counted twice when the room left on the job is worked out.
      await settleCashOnConfirm(tx, current, { userId: adminId });

      const confirmedPayment = await tx.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          status: PaymentStatus.PAID,
          confirmedAt: new Date(),
          confirmedById: adminId,
          // What is found under the lock, not what was read before it: the customer may have sent the reference of the
          // transfer meanwhile.
          reference: reference || current.reference,
          adminNote: dto.adminNote,
          receiptNumber: current.receiptNumber || receiptNumber,
          receiptGeneratedAt: current.receiptGeneratedAt || new Date(),
        },
        include: this.paymentInclude,
      });

      // The job is paid when what was confirmed covers what it asks for: a part payment (30 in cash on a job of 100) leaves it as it is.
      const position = await paymentPosition(tx, payment.interventionId);

      if (this.coversDocument(position.payments, position.document)) {
        await transitionStatus(tx, {
          id: payment.interventionId,
          to: Status.PAID,
          actor: { kind: 'staff', userId: adminId },
          data: { paidAt: new Date() },
          soft: true,
        });
      }

      // The invoice follows the payments by its own rule (P2-07): paid when what was kept covers what is to be paid on it; a
      // cancelled invoice stays cancelled.
      await settleInvoice(tx, payment.interventionId);

      // What the job brought in, the commission and the artisan's share follow the payments.
      await syncFinancials(tx, payment.interventionId, { userId: adminId });

      return { replayed: false, confirmed: confirmedPayment };
    });

    if (outcome.replayed) {
      return outcome.confirmed;
    }

    const updated = outcome.confirmed as NonNullable<typeof outcome.confirmed>;

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.PAYMENT_CONFIRMED,
      title: 'Paiement confirmé',
      message: `Le paiement de ${formatMoney(updated.amount, { currency: updated.currency })} a été confirmé.`,
      createdById: adminId,
      metadata: {
        paymentId,
        amount: money(updated.amount),
        currency: updated.currency,
        method: updated.method,
        provider: updated.provider,
        reference: updated.reference,
        receiptNumber: updated.receiptNumber,
      },
    });

    // One notification for the customer and one for each accountant/admin
    // (the admin who confirmed it is not told about their own click). Never throws.
    await this.notifications.notifyPaymentReceived(paymentId, adminId);

    return updated;
  }

  /**
   * A payment that is not cash cannot be confirmed above what is left to pay on the job (the invoice, else the accepted quote,
   * less what was received and the cash that artisans declared). Cash has its own check, which also counts the cash the artisan
   * declared for this very payment. A job with no document, or money in another currency than the company's, has nothing to
   * compare with.
   */
  private async ensureRoomLeft(tx: any, payment: any) {
    if (String(payment.method) === PaymentMethod.CASH) return;

    if (payment.currency && String(payment.currency) !== currencyCode()) return;

    const position = await paymentPosition(tx, payment.interventionId);

    if (position.document?.currency && String(position.document.currency) !== currencyCode()) return;

    if (position.remaining !== null && compareMoney(money(payment.amount), position.remaining) > 0) {
      throw new ConflictException('Ce paiement dépasse ce qu’il reste à payer sur cette mission.');
    }
  }

  /** Whether what was received covers the document that is paid (the invoice, else the accepted quote). No document: yes. */
  private coversDocument(payments: any[], document: any): boolean {
    if (!document) return true;

    // The sums are in the currency of the company: a document in another one cannot be compared, a confirmation settles it.
    if (document.currency && String(document.currency) !== currencyCode()) return true;

    return compareMoney(paymentFigures(payments).kept, amountToPay(document)) >= 0;
  }

  // ==========================================================
  // Admin marks payment as failed
  // ==========================================================

  async fail(paymentId: number, adminId: number, dto: FailPaymentDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    // A second click on a payment that already failed is answered with it as it is: the reason, the date and the timeline stay.
    if (payment.status === PaymentStatus.FAILED) {
      return payment;
    }

    this.ensurePaymentCanFail(payment);

    const reason =
      this.getOptionalString(dto, 'reason') ||
      dto.adminNote ||
      'Le paiement a échoué.';

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: the payment may have been confirmed in the meantime.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      if (current.status === PaymentStatus.FAILED) {
        return { replayed: true, failed: await tx.payment.findUnique({ where: { id: paymentId }, include: this.paymentInclude }) };
      }

      this.ensurePaymentCanFail(current);

      const failed = await tx.payment.update({
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

      // The cash an artisan declared for this payment was not taken after all: it leaves their ledger.
      await reverseCollectionsOfPayment(tx, paymentId, { userId: adminId, reason: 'Paiement marqué comme échoué.' });

      return { replayed: false, failed };
    });

    if (outcome.replayed) {
      return outcome.failed;
    }

    const updated = outcome.failed as NonNullable<typeof outcome.failed>;

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Paiement échoué',
      // The timeline is read by the customer and the artisan: what the back office wrote for itself
      // stays on the payment (and here in the data, which only the back office reads).
      message: 'Le paiement a échoué.',
      createdById: adminId,
      metadata: {
        paymentId,
        reason,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin cancels payment
  // ==========================================================

  async cancel(paymentId: number, adminId: number, dto: CancelPaymentDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    this.ensurePaymentCanBeCancelled(payment);

    const reason =
      this.getOptionalString(dto, 'reason') ||
      dto.adminNote ||
      'Le paiement a été annulé.';

    const updated = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: the payment may have been confirmed in the meantime.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      this.ensurePaymentCanBeCancelled(current);

      const cancelled = await tx.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          status: PaymentStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason,
          adminNote: dto.adminNote,
        },
        include: this.paymentInclude,
      });

      // The cash an artisan declared for this payment was not taken after all: it leaves their ledger.
      await reverseCollectionsOfPayment(tx, paymentId, { userId: adminId, reason: 'Paiement annulé.' });

      return cancelled;
    });

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.CANCELLED,
      title: 'Paiement annulé',
      message: 'Le paiement a été annulé.',
      createdById: adminId,
      metadata: {
        paymentId,
        reason,
      },
    });

    return updated;
  }

  // ==========================================================
  // Admin refund / partial refund
  // ==========================================================

  /**
   * Gives money back on a paid payment, in full or in part (no amount: what is left of it). In one step, under the lock of the
   * job: the payment (amount refunded, status), the financials of the job (refund, revenue) and the complaints of the job that
   * were waiting for a refund (decided). The customer is told afterwards.
   */
  async refund(paymentId: number, adminId: number, dto: RefundPaymentDto) {
    const payment = await this.getPaymentOrFail(paymentId);

    this.ensurePaymentCanBeRefunded(payment);

    const amountFromDto = this.getOptionalNumber(dto, 'amount');

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: another refund may have been made in the meantime, and the total can never go above the payment.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      this.ensurePaymentCanBeRefunded(current);

      const left = subtractMoney(money(current.amount), money(current.amountRefunded));
      const refundAmount = money(amountFromDto ?? left);

      if (refundAmount <= 0) {
        throw new BadRequestException(
          'Le montant du remboursement doit être supérieur à 0.',
        );
      }

      const newRefundedTotal = sumMoney(current.amountRefunded, refundAmount);

      if (compareMoney(newRefundedTotal, current.amount) > 0) {
        throw new BadRequestException(
          'Le montant total remboursé ne peut pas dépasser le montant du paiement.',
        );
      }

      const isFullRefund = compareMoney(newRefundedTotal, current.amount) === 0;

      const reason =
        this.getOptionalString(dto, 'reason') ||
        dto.adminNote ||
        `Remboursement de ${formatMoney(refundAmount, { currency: current.currency })}.`;

      const refunded = await tx.payment.update({
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

      // The financials follow the payments, and the complaints that asked for this refund are decided.
      await syncFinancials(tx, payment.interventionId, { userId: adminId });

      // An invoice that the payments no longer cover asks for the rest again, until a credit note matches the refund (P2-07).
      await settleInvoice(tx, payment.interventionId);

      const figures = paymentFigures(await tx.payment.findMany({ where: { interventionId: payment.interventionId } }));
      const complaints = await settleComplaintRefund(tx, payment.interventionId, { userId: adminId }, figures);

      return { refunded, refundAmount, newRefundedTotal, isFullRefund, reason, complaints };
    });

    const { refunded, refundAmount, newRefundedTotal, isFullRefund, reason, complaints } = outcome;

    await this.createEvent({
      interventionId: payment.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: isFullRefund
        ? 'Remboursement enregistré'
        : 'Remboursement partiel enregistré',
      message: `Remboursement de ${formatMoney(refundAmount, { currency: payment.currency })}.`,
      createdById: adminId,
      metadata: {
        paymentId,
        reason,
        refundAmount,
        totalRefunded: newRefundedTotal,
        isFullRefund,
        complaintsDecided: complaints,
      },
    });

    // The customer is told what went back to them. Never throws.
    await this.notifications.notifyPaymentRefunded(paymentId, refundAmount, adminId);

    return refunded;
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

    // The back office reads the rows as they are. The customer and the artisan get the payment in
    // their own copy, and each the other's name and number, not the other's e-mail.
    const side = isOwnerClient ? 'client' : isAssignedArtisan ? 'artisan' : null;
    const shownPayment =
      side === 'client'
        ? paymentForClient(payment)
        : side === 'artisan'
          ? paymentForArtisan(payment)
          : payment;
    const shownClient = side
      ? pickPerson(payment.intervention.client, ['id', 'name', 'email', 'phone'])
      : payment.intervention.client;
    const shownArtisan =
      side === 'client'
        ? pickPerson(payment.intervention.artisan, ['id', 'name', 'phone'])
        : side === 'artisan'
          ? pickPerson(payment.intervention.artisan, ['id', 'name', 'email', 'phone'])
          : payment.intervention.artisan;

    return {
      receiptNumber,
      receiptUrl: payment.receiptUrl,
      generatedAt: receiptDate,
      payment: shownPayment,
      receipt: {
        number: receiptNumber,
        date: receiptDate,
        amount: money(payment.amount),
        amountRefunded: money(payment.amountRefunded),
        currency: payment.currency,
        // How the customer paid is for the customer and the back office, not for the artisan.
        ...(side === 'artisan'
          ? {}
          : { method: payment.method, provider: payment.provider, reference: payment.reference }),
        interventionId: payment.interventionId,
        quoteId: payment.quoteId,
        invoiceId: payment.invoiceId,
        client: shownClient,
        artisan: shownArtisan,
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

    // A payment goes to the invoice that is out: the one that was cancelled (credited in full, or replaced) asks nothing any more.
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException('Cette facture est annulée : le paiement se rattache à la facture qui la remplace.');
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

    // As for the customer and for `linkToInvoice`: a payment goes to the invoice that is out. One that was cancelled (credited in
    // full, or replaced) asks nothing any more, and a draft is not out yet; a payment recorded on either would never settle anything.
    if (invoice && !isLiveInvoice(invoice)) {
      throw new BadRequestException('Cette facture est annulée ou n’est pas encore émise : le paiement se rattache à la facture en cours.');
    }

    const amountFromDto = this.getOptionalNumber(dto, 'amount');
    const asked = money(amountFromDto ?? (invoice ? amountToPay(invoice) : undefined) ?? acceptedQuote?.amountTTC ?? 0);
    // The currency is the one of the document that is paid, else the one of the company: never one typed by the payer.
    const currency = invoice?.currency ?? acceptedQuote?.currency ?? currencyCode();

    if (!asked || asked <= 0) {
      throw new BadRequestException(
        'Montant introuvable. Envoyez un montant, liez une facture ou utilisez un devis accepté.',
      );
    }

    const { payment, reused } = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, interventionId);

      // No amount typed: what is left to pay (a deposit that was paid is not asked for twice).
      const amount = amountFromDto !== undefined ? asked : await leftToPay(tx, interventionId, asked, currency);

      // One open payment per job: the same request again is answered with the open payment, another one is refused.
      const open = await claimOpenPayment(tx, { interventionId, method: dto.method, amount });

      if (open) {
        await refreshOpenPayment(tx, open, { reference: dto.reference, clientNote: dto.clientNote, adminNote: this.getOptionalString(dto, 'adminNote') });

        return { payment: (await tx.payment.findUnique({ where: { id: open.id }, include: this.paymentInclude })) as any, reused: true };
      }

      const created = await tx.payment.create({
        data: {
          interventionId,
          quoteId: acceptedQuote?.id,
          invoiceId,
          method: dto.method,
          provider: this.providerFromMethod(dto.method),
          status: this.initialStatusFromMethod(dto.method),
          amount,
          amountRefunded: 0,
          currency,
          reference: dto.reference,
          clientNote: dto.clientNote,
          adminNote: this.getOptionalString(dto, 'adminNote'),
          createdById: adminId,
        },
        include: this.paymentInclude,
      });

      return { payment: created as any, reused: false };
    });

    if (reused) {
      return payment;
    }

    await this.createEvent({
      interventionId,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement créé par l’administration',
      message: `Un paiement de ${formatMoney(payment.amount, { currency: payment.currency })} a été créé par l’administration.`,
      createdById: adminId,
      metadata: {
        paymentId: payment.id,
        method: payment.method,
        amount: money(payment.amount),
        currency: payment.currency,
      },
    });

    return payment;
  }
}
