import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { CancelPaymentDto, ConfirmPaymentDto, FailPaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { claimOpenPayment, leftToPay, refreshOpenPayment } from './open-payment';
import { canonicalStatus } from '../intervention-workflow/intervention-status';
import { ensureCardCurrency, ensureJobTakesPayment, ensureMethodOffered } from './payment-options';
import { PaymentGatewayService } from './gateway/payment-gateway.service';
import { GatewayError, GatewayNotificationRequest, GatewayStatus } from './gateway/payment-gateway';
import { CARD_WORDS, ONLINE_METHODS, isOnlineMethod, orderIdOf, startOnlinePayment } from './online-payment';
import { KEY_WORDS, asKeyConflict, readIdempotencyKey } from './idempotency';
import { describeError } from '../notifications/delivery/delivery-error';
import { StatusActor } from '../intervention-workflow/intervention-status';
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

/** What became of a payment when the provider was asked about it (P2-10). */
export type OnlineOutcome = 'CONFIRMED' | 'ALREADY' | 'UNCHANGED' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'REVIEW' | 'UNKNOWN';

/** The statuses of a payment whose money was received: nothing the provider says changes them. */
const RECEIVED_STATUSES = ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'];

/** A request to the provider that never got an answer is cancelled when nobody asked again after this long. */
const NOT_STARTED_AFTER_MS = 15 * 60_000;
/** A payment that waits at the provider is asked about at most this often by the timer (a little less than the round, so that every round asks). */
const CHECK_EVERY_MS = 50_000;
/** The calls of the provider are kept for the support this long. */
const WEBHOOK_LOG_KEPT_MS = 90 * 24 * 60 * 60_000;
/** A provider that cannot be reached for this long after the time of a payment does not keep it open any more. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** How many payments one round of the timer looks at. */
const SWEEP_BATCH = 50;
/** A call of the provider about a payment that was asked about this recently is answered without asking again (the page of a payment is public to its customer). */
const NOTIFICATION_GAP_MS = 5_000;
/** The same answer about the same payment is written in the log of the calls once in this time. */
const LOG_ONCE_MS = 10 * 60_000;
/** A payment closed here is still asked about for this long after its time: the customer may pay on the page the provider keeps. */
const CLOSED_WATCH_MS = 60 * 60_000;
/** ... and at most this often. */
const CLOSED_CHECK_EVERY_MS = 5 * 60_000;
/** A payment given up on (the provider could not be reached for a day) is still asked about for this long after it was given up, and at most this often: the money may be there. */
const GIVEN_UP_WATCH_MS = 7 * 24 * 60 * 60_000;
const GIVEN_UP_CHECK_EVERY_MS = 60 * 60_000;
/**
 * The payments given up on: cancelled because the provider could not be asked for a day, no money seen, within the week they are still
 * looked at (the key of the provider may have been put right, and the customer may have paid meanwhile).
 */
const givenUp = (now: Date) => ({
  status: PaymentStatus.CANCELLED,
  moneySeenAt: null,
  cancelReason: CARD_WORDS.gaveUp,
  cancelledAt: { gt: new Date(now.getTime() - GIVEN_UP_WATCH_MS) },
});
/** How the log of the calls is emptied: so many rows at a time, so many times in a round. */
const PURGE_BATCH = 1000;
const PURGE_ROUNDS = 20;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly gateway: PaymentGatewayService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
    private readonly notifications: NotificationsService,
    @Optional() gateway?: PaymentGatewayService,
  ) {
    // Without one handed in (a script, a spec) the gateway the environment describes: none, unless PAYMENT_PROVIDER is set.
    this.gateway = gateway ?? new PaymentGatewayService();
  }

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

    // A card payment that waits at the provider is confirmed by the provider's answer, not by a click: the customer may still pay,
    // and would pay a payment that was already counted.
    if (payment.status === PaymentStatus.PENDING && payment.providerPaymentId) {
      throw new ConflictException(CARD_WORDS.waitsAtProvider);
    }

    // A card payment the provider refused or that was closed without any money seen is not confirmed by hand either: nothing came, and
    // the page of the provider could still be paid later, which would be counted twice. (One that was put in front of the team because
    // money came is confirmed as usual.)
    if (payment.status === PaymentStatus.FAILED && payment.providerPaymentId && !payment.moneySeenAt) {
      throw new ConflictException(CARD_WORDS.failedAtProvider);
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
    idempotencyKey?: unknown,
  ) {
    const key = readIdempotencyKey(idempotencyKey, `c${clientId}`);

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

    // A card is paid in the currency of the company (see `ensureCardCurrency`).
    if (isOnlineMethod(dto.method) && this.gateway.connected()) ensureCardCurrency(currency);

    // A card payment of this job whose time is over is closed first (after one last look at the provider): it is not handed back with
    // a page that no longer takes payments, and it does not stand in the way of a new one. A card request is not answered with the old
    // page when the provider cannot say what became of it: the customer is told to try again in a moment.
    await this.closeLapsedCards(interventionId, new Date(), { required: isOnlineMethod(dto.method) });

    const { payment, reused } = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, interventionId);

      // The same key is the same request, answered with the payment it made (whatever became of it since): nothing is written.
      if (key) {
        const earlier = await tx.payment.findUnique({ where: { idempotencyKey: key }, include: this.paymentInclude });

        if (earlier) {
          if (!this.isSameKeyedRequest(earlier, { interventionId, method: dto.method, amount: amountFromDto === undefined ? undefined : asked, reference: dto.reference, invoiceId })) {
            throw new ConflictException(KEY_WORDS.used);
          }

          return { payment: earlier as any, reused: true };
        }
      }

      // No amount typed: what is left to pay (a deposit that was paid is not asked for twice). An amount typed for a card payment is
      // not more than that: the provider would charge it, and the difference could only be given back by hand.
      const left = isOnlineMethod(dto.method) || amountFromDto === undefined ? await leftToPay(tx, interventionId, asked, currency) : null;

      if (amountFromDto !== undefined && left !== null && compareMoney(asked, left) > 0) {
        throw new BadRequestException(`Le montant dépasse ce qu’il reste à payer sur cette mission (${formatMoney(left, { currency })}).`);
      }

      const amount = amountFromDto !== undefined ? asked : (left as number);

      // One open payment per job: the same request again is answered with the open payment, another one is refused.
      const open = await claimOpenPayment(tx, { interventionId, method: dto.method, amount, derived: amountFromDto === undefined, clientId, customer: true });

      if (open) {
        // The reference of the transfer, sent after it was made, is kept on the open payment.
        await refreshOpenPayment(tx, open, { reference: dto.reference, clientNote: dto.clientNote });

        // The key of this request is kept on the payment it was answered with, so that the same key asked again is the same request
        // (and not a new payment, if this one is cancelled meanwhile).
        if (key && !open.idempotencyKey) {
          await tx.payment.updateMany({ where: { id: open.id, idempotencyKey: null }, data: { idempotencyKey: key } }).catch((error: unknown) => {
            throw asKeyConflict(error);
          });
        }

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
          // Who takes the money is the server's business, never something the payer names: a card payment gets its provider once the
          // provider has taken it (`startOnlinePayment`).
          provider: this.providerFromMethod(dto.method),
          status: this.initialStatusFromMethod(dto.method),
          amount,
          amountRefunded: 0,
          currency,
          reference: dto.reference,
          clientNote: dto.clientNote,
          createdById: clientId,
          idempotencyKey: key ?? null,
        },
        include: this.paymentInclude,
      }).catch((error: unknown) => {
        throw asKeyConflict(error);
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

    if (!reused) {
      await this.createEvent({
        interventionId,
        type: InterventionEventType.PAYMENT_PENDING,
        title: 'Paiement en attente',
        message: isOnlineMethod(dto.method) ? this.onlineRequestWords() : `Paiement ${dto.method} en attente de confirmation.`,
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
    }

    // A card request goes to the provider once it is recorded (a retry of a request whose provider did not answer starts it again).
    const started = { ...payment, ...(await startOnlinePayment(this.prisma, this.gateway, payment)) };

    // Replaced by another request while the provider was being asked: the customer is not sent to a payment that was cancelled.
    if (isOnlineMethod(dto.method) && String(started.status) === PaymentStatus.CANCELLED && !reused) throw new ConflictException(CARD_WORDS.changed);

    return {
      ...paymentForClient(started),
      instructions: this.getPaymentInstructions(dto.method),
      ...(reused ? { replayed: true } : {}),
    };
  }

  /** The line of the timeline for a card request: with a provider the customer is sent to pay, without one the request only waits. */
  onlineRequestWords(): string {
    return this.gateway.connected()
      ? 'Demande de paiement par carte créée : le client est dirigé vers la page de paiement.'
      : 'Le paiement en ligne est enregistré comme demande en attente. Aucun prestataire externe n’est encore connecté.';
  }

  /** A payment found by its key is the one this request asks for: same job, same way of paying, and the same amount when one was typed. */
  private isSameKeyedRequest(payment: any, request: { interventionId: number; method: string; amount?: number; reference?: unknown; invoiceId?: number }): boolean {
    if (Number(payment.interventionId) !== request.interventionId || String(payment.method) !== String(request.method)) return false;

    // The invoice that was named is the invoice the payment is for.
    if (request.invoiceId !== undefined && Number(payment.invoiceId ?? 0) !== request.invoiceId) return false;

    // A reference of a transfer that the first request did not carry is something new, not the same request again: it is not answered
    // with the payment as if it had been written (the caller sends it under a key of its own).
    if (request.reference !== undefined && request.reference !== null && String(request.reference) !== '' && String(request.reference) !== String(payment.reference ?? '')) return false;

    return request.amount === undefined || compareMoney(money(payment.amount), request.amount) === 0;
  }

  getPaymentInstructions(method: PaymentMethod) {
    if (method === PaymentMethod.CASH) {
      return 'Paiement en espèces à remettre à l’artisan ou à confirmer par l’administrateur.';
    }

    if (method === PaymentMethod.BANK_TRANSFER) {
      return 'Effectuez le virement bancaire puis envoyez la référence du virement. Confirmation manuelle par l’administrateur.';
    }

    if (isOnlineMethod(method) && this.gateway.connected()) {
      return 'Réglez par carte sur la page du prestataire de paiement : la confirmation de votre paiement est automatique.';
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

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: a cancel or a fail may have come in between, or another click on confirm.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      if (current.status === PaymentStatus.PAID) {
        return { replayed: true, confirmed: await tx.payment.findUnique({ where: { id: paymentId }, include: this.paymentInclude }) };
      }

      this.ensurePaymentCanBeConfirmed(current);

      const confirmedPayment = await this.markPaid(tx, current, {
        userId: adminId,
        actor: { kind: 'staff', userId: adminId },
        reference,
        adminNote: dto.adminNote,
      });

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
   * The money of a payment was received: the payment is paid, the job follows (paid when what was kept covers it), then the invoice,
   * then the financials. In the transaction that holds the lock of the job, on the payment as it was read under that lock. Used by the
   * back office (a click on confirm) and by the provider (its answer says the money came); `by.userId` is null for the provider.
   */
  private async markPaid(tx: any, current: any, by: { userId: number | null; actor: StatusActor; reference?: string; adminNote?: string }) {
    // Nothing is confirmed above what the job has to pay: the figures of the job are worked out from what was confirmed.
    await this.ensureRoomLeft(tx, current);

    // A cash payment is in the artisan's ledger once it is confirmed: the cash they declared stays (or counts again, when
    // the payment had failed), and cash nobody declared is written now. Before the payment is marked as paid, so that what
    // it brings is not counted twice when the room left on the job is worked out.
    await settleCashOnConfirm(tx, current, { userId: by.userId });

    const confirmedPayment = await tx.payment.update({
      where: {
        id: current.id,
      },
      data: {
        status: PaymentStatus.PAID,
        confirmedAt: new Date(),
        confirmedById: by.userId,
        // What is found under the lock, not what was read before it: the customer may have sent the reference of the
        // transfer meanwhile.
        reference: by.reference || current.reference,
        // What the provider's answer put on a payment that the team confirms (the amount that really came, the reason it was held) stays
        // under the team's own words.
        adminNote: by.adminNote && current.moneySeenAt && current.adminNote ? `${by.adminNote}\n${current.adminNote}` : by.adminNote,
        receiptNumber: current.receiptNumber || this.generateReceiptNumber(current.id),
        receiptGeneratedAt: current.receiptGeneratedAt || new Date(),
        // A card payment is no longer waiting at the provider: its page is not kept.
        payUrl: null,
      },
      include: this.paymentInclude,
    });

    // The job is paid when what was confirmed covers what it asks for: a part payment (30 in cash on a job of 100) leaves it as it is.
    const position = await paymentPosition(tx, current.interventionId);

    if (this.coversDocument(position.payments, position.document)) {
      await transitionStatus(tx, {
        id: current.interventionId,
        to: Status.PAID,
        actor: by.actor,
        data: { paidAt: new Date() },
        soft: true,
      });
    }

    // The invoice follows the payments by its own rule (P2-07): paid when what was kept covers what is to be paid on it; a
    // cancelled invoice stays cancelled.
    await settleInvoice(tx, current.interventionId);

    // What the job brought in, the commission and the artisan's share follow the payments.
    await syncFinancials(tx, current.interventionId, { userId: by.userId });

    return confirmedPayment;
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
   * The refund a key already made: true when it is a refund of this payment (and, when an amount is named, for that amount); a refusal
   * (409) when the key was used for another payment or another amount; false when the key is new.
   */
  private async refundOfKey(db: any, key: string, paymentId: number, amount: number | undefined): Promise<boolean> {
    const earlier = await db.paymentRefund.findUnique({ where: { idempotencyKey: key } });

    if (!earlier) return false;

    if (Number(earlier.paymentId) !== paymentId || (amount !== undefined && compareMoney(money(earlier.amount), money(amount)) !== 0)) {
      throw new ConflictException(KEY_WORDS.used);
    }

    return true;
  }

  /**
   * Gives money back on a paid payment, in full or in part (no amount: what is left of it). In one step, under the lock of the
   * job: the payment (amount refunded, status), the financials of the job (refund, revenue) and the complaints of the job that
   * were waiting for a refund (decided). The customer is told afterwards.
   */
  async refund(paymentId: number, adminId: number, dto: RefundPaymentDto, idempotencyKey?: unknown) {
    const key = readIdempotencyKey(idempotencyKey, `r${paymentId}`);
    const payment = await this.getPaymentOrFail(paymentId);
    const amountFromDto = this.getOptionalNumber(dto, 'amount');

    // The same key is the same refund: it is answered with the payment as it is, once the money has gone back (a full refund leaves a
    // payment that can no longer be refunded, so this is looked at before the status is).
    if (key && (await this.refundOfKey(this.prisma, key, paymentId, amountFromDto))) {
      return { ...payment, replayed: true };
    }

    this.ensurePaymentCanBeRefunded(payment);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: another refund may have been made in the meantime, and the total can never go above the payment.
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (!current) throw new NotFoundException('Paiement introuvable.');

      // The same key arriving twice at the same moment: the second one finds the first one's refund here.
      if (key && (await this.refundOfKey(tx, key, paymentId, amountFromDto))) {
        return { replayed: true as const, refunded: await tx.payment.findUnique({ where: { id: paymentId }, include: this.paymentInclude }) };
      }

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

      // One row per refund, with the key it came with.
      await tx.paymentRefund.create({ data: { paymentId, amount: refundAmount, reason, idempotencyKey: key ?? null, createdById: adminId } });

      // The financials follow the payments, and the complaints that asked for this refund are decided.
      await syncFinancials(tx, payment.interventionId, { userId: adminId });

      // An invoice that the payments no longer cover asks for the rest again, until a credit note matches the refund (P2-07).
      await settleInvoice(tx, payment.interventionId);

      const figures = paymentFigures(await tx.payment.findMany({ where: { interventionId: payment.interventionId } }));
      const complaints = await settleComplaintRefund(tx, payment.interventionId, { userId: adminId }, figures);

      return { replayed: false as const, refunded, refundAmount, newRefundedTotal, isFullRefund, reason, complaints };
    });

    if (outcome.replayed) return { ...outcome.refunded, replayed: true };

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

  // ==========================================================
  // Card payments (P2-10)
  //
  // The provider's answer says whether money came; a webhook, the page the customer comes back to, a click of the team and the
  // timer only make us ask. Every way in ends in `applyProviderState`, which takes the lock of the job, reads the payment again
  // and decides from what it finds: so a webhook delivered twice, or two at the same moment, confirms the payment once.
  // ==========================================================

  /** Asks the provider what became of a card payment and acts on the answer. A provider that cannot be reached throws a `GatewayError`. */
  async syncFromProvider(paymentId: number): Promise<{ outcome: OnlineOutcome; payment: any | null }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment || !payment.providerPaymentId || !isOnlineMethod(payment.method) || String(payment.provider) !== this.gateway.provider()) {
      return { outcome: 'UNKNOWN', payment: payment ?? null };
    }

    // Money that came is not asked about again.
    if (RECEIVED_STATUSES.includes(String(payment.status))) return { outcome: 'ALREADY', payment };

    const verified = await this.gateway.status(payment.providerPaymentId);

    return this.applyProviderState(payment, verified);
  }

  /** Why what the provider says is not the payment we asked for, in words for the team; null when it is. */
  private verificationProblem(payment: any, verified: GatewayStatus): string | null {
    if (verified.amount === null) return 'Reçu en ligne, mais le prestataire n’a pas indiqué le montant : à vérifier.';

    if (compareMoney(verified.amount, money(payment.amount)) !== 0) {
      return `Reçu en ligne : ${formatMoney(verified.amount, { currency: payment.currency })} au lieu de ${formatMoney(money(payment.amount), { currency: payment.currency })} demandés : à vérifier.`;
    }

    if (verified.currency !== null && verified.currency !== String(payment.currency).toUpperCase()) return 'Reçu en ligne dans une autre devise que celle demandée : à vérifier.';
    if (verified.orderId !== null && verified.orderId !== orderIdOf(payment)) return 'Le prestataire indique une autre commande que celle de ce paiement : à vérifier.';

    return null;
  }

  /**
   * What the server does with the provider's answer, in one transaction under the lock of the job:
   *  - paid, and it is the payment we asked for, and it still waits (PENDING): confirmed, once;
   *  - paid, but not as asked (another amount, another order), or the payment is no longer waiting (cancelled, failed), or the job has
   *    no room left for it: the money is real, so the payment is put in front of the team (AWAITING_CONFIRMATION, with the reason),
   *    never lost and never confirmed by itself;
   *  - failed or expired at the provider: a payment that waits is failed or cancelled;
   *  - still waiting: only the date of the look is kept.
   * Money that was already received, and a payment already put in front of the team, are left as they are.
   */
  private async applyProviderState(payment: any, verified: GatewayStatus): Promise<{ outcome: OnlineOutcome; payment: any | null }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      // Read again under the lock: another call (a second delivery of the same webhook, the timer) may have decided already.
      const current = await tx.payment.findUnique({ where: { id: payment.id } });

      if (!current || !current.providerPaymentId || current.providerPaymentId !== verified.providerPaymentId) {
        return { outcome: 'UNKNOWN' as OnlineOutcome, payment: current ?? null, changed: false, reason: null as string | null };
      }

      const status = String(current.status);

      if (RECEIVED_STATUSES.includes(status)) return { outcome: 'ALREADY' as OnlineOutcome, payment: current, changed: false, reason: null };

      const put = async (reason: string) => {
        // What the team wrote on the payment (its note, why it closed it) stays under the new line: late money does not erase it.
        const kept = [
          current.cancelReason ? `Annulé : ${current.cancelReason}` : null,
          current.failureReason ? `Échoué : ${current.failureReason}` : null,
          current.adminNote && current.adminNote !== reason ? current.adminNote : null,
        ].filter((line) => line !== null);
        const note = [reason, ...kept].join('\n');

        const moved = await tx.payment.updateMany({
          where: { id: current.id, status: { in: ['PENDING', 'FAILED', 'CANCELLED'] } },
          data: {
            status: PaymentStatus.AWAITING_CONFIRMATION,
            adminNote: note,
            cancelledAt: null,
            cancelReason: null,
            failedAt: null,
            failureReason: null,
            providerCheckedAt: new Date(),
            moneySeenAt: current.moneySeenAt ?? new Date(),
          },
        });

        return { outcome: 'REVIEW' as OnlineOutcome, payment: await tx.payment.findUnique({ where: { id: current.id } }), changed: moved.count === 1, reason };
      };

      if (verified.state === 'PAID') {
        // Already in front of the team: a second delivery does not change that, and does not confirm it.
        if (status === PaymentStatus.AWAITING_CONFIRMATION) {
          await tx.payment.updateMany({ where: { id: current.id }, data: { providerCheckedAt: new Date() } });

          return { outcome: 'REVIEW' as OnlineOutcome, payment: current, changed: false, reason: null };
        }

        // The money of this payment was put in front of the team once and the team closed the payment (it deals with the money outside
        // of the system, at the provider): the same money seen again does not open it again, nor tells the team a second time.
        if ((status === PaymentStatus.CANCELLED || status === PaymentStatus.FAILED) && current.moneySeenAt) {
          await tx.payment.updateMany({ where: { id: current.id }, data: { providerCheckedAt: new Date() } });

          return { outcome: 'UNCHANGED' as OnlineOutcome, payment: current, changed: false, reason: null };
        }

        if (status === PaymentStatus.CANCELLED) return put(CARD_WORDS.late);
        if (status !== PaymentStatus.PENDING) return put(CARD_WORDS.other);

        const problem = this.verificationProblem(current, verified);

        if (problem) return put(problem);

        // The mission was cancelled while the customer was paying: the money is real, and it is for the team to look at (a refund is due).
        const job = await tx.intervention.findUnique({ where: { id: current.interventionId }, select: { status: true } });

        if (canonicalStatus(job?.status) === 'CANCELLED') return put(CARD_WORDS.jobCancelled);

        try {
          await this.ensureRoomLeft(tx, current);
        } catch (error) {
          if (error instanceof ConflictException) return put(CARD_WORDS.over);

          throw error;
        }

        const confirmed = await this.markPaid(tx, current, { userId: null, actor: { kind: 'system' } });

        return { outcome: 'CONFIRMED' as OnlineOutcome, payment: confirmed, changed: true, reason: null };
      }

      if (status !== PaymentStatus.PENDING) {
        // Asked about, and nothing to do: the date of the look is kept, so that a payment closed here is not asked about every minute.
        await tx.payment.updateMany({ where: { id: current.id }, data: { providerCheckedAt: new Date() } });

        return { outcome: 'UNCHANGED' as OnlineOutcome, payment: current, changed: false, reason: null };
      }

      if (verified.state === 'FAILED') {
        const moved = await tx.payment.updateMany({
          where: { id: current.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failedAt: new Date(), failureReason: CARD_WORDS.refused, payUrl: null },
        });

        return { outcome: 'FAILED' as OnlineOutcome, payment: await tx.payment.findUnique({ where: { id: current.id } }), changed: moved.count === 1, reason: CARD_WORDS.refused };
      }

      if (verified.state === 'EXPIRED') {
        const moved = await tx.payment.updateMany({
          where: { id: current.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: CARD_WORDS.expired, payUrl: null },
        });

        return { outcome: 'EXPIRED' as OnlineOutcome, payment: await tx.payment.findUnique({ where: { id: current.id } }), changed: moved.count === 1, reason: CARD_WORDS.expired };
      }

      await tx.payment.updateMany({ where: { id: current.id }, data: { providerCheckedAt: new Date() } });

      return { outcome: 'PENDING' as OnlineOutcome, payment: current, changed: false, reason: null };
    });

    // What is told to the people, once, when something really changed (a second delivery that changes nothing tells nothing).
    // The money is recorded by then: a notice that cannot be written is logged, it does not turn a confirmed payment into an error
    // (the provider would send the webhook again and find nothing to do).
    if (result.changed && result.payment) {
      const label = result.outcome;

      try {
        await this.announce(label, result.payment, result.reason);
      } catch (error) {
        this.logger.error(`The notice of card payment ${result.payment.id} (${label}) was not written (${describeError(error)}).`);
      }
    }

    return { outcome: result.outcome, payment: result.payment };
  }

  /** The timeline, and the people who must know, after a card payment moved. */
  private async announce(outcome: OnlineOutcome, payment: any, reason: string | null) {
    const metadata = { paymentId: payment.id, provider: payment.provider, amount: money(payment.amount), currency: payment.currency };

    if (outcome === 'CONFIRMED') {
      await this.createEvent({
        interventionId: payment.interventionId,
        type: InterventionEventType.PAYMENT_CONFIRMED,
        title: 'Paiement confirmé',
        message: `Le paiement de ${formatMoney(payment.amount, { currency: payment.currency })} a été confirmé.`,
        metadata: { ...metadata, method: payment.method, receiptNumber: payment.receiptNumber, by: 'provider' },
      });

      // The customer, and each accountant and admin. Never throws.
      await this.notifications.notifyPaymentReceived(payment.id);

      return;
    }

    if (outcome === 'REVIEW') {
      await this.createEvent({
        interventionId: payment.interventionId,
        type: InterventionEventType.STATUS_CHANGED,
        title: 'Paiement à vérifier',
        message: 'Un paiement par carte a été reçu : notre équipe le vérifie.',
        metadata: { ...metadata, reason },
      });
      await this.notifications.notifyPaymentToCheck(payment.id);

      return;
    }

    if (outcome === 'FAILED') {
      await this.createEvent({ interventionId: payment.interventionId, type: InterventionEventType.STATUS_CHANGED, title: 'Paiement échoué', message: 'Le paiement a échoué.', metadata: { ...metadata, reason } });

      return;
    }

    if (outcome === 'EXPIRED') {
      await this.createEvent({ interventionId: payment.interventionId, type: InterventionEventType.CANCELLED, title: 'Paiement annulé', message: reason ?? CARD_WORDS.expired, metadata: { ...metadata, reason } });
    }
  }

  /**
   * A card request that nobody can pay any more is cancelled (nothing was received on it). Returns false when it was decided meanwhile.
   * `unstarted`: the request was seen without a provider and not claimed since `unstarted.claimedBefore`; it is cancelled only if it still is
   * (a customer who asked again at that moment has the provider's page now, and keeps it).
   */
  private async cancelOnline(payment: any, reason: string, unstarted?: { claimedBefore: Date }): Promise<boolean> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, payment.interventionId);

      const moved = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentStatus.PENDING,
          ...(unstarted ? { providerPaymentId: null, OR: [{ gatewayClaimedAt: null }, { gatewayClaimedAt: { lt: unstarted.claimedBefore } }] } : {}),
        },
        data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason, payUrl: null },
      });

      return moved.count === 1;
    });

    if (cancelled) {
      await this.createEvent({
        interventionId: payment.interventionId,
        type: InterventionEventType.CANCELLED,
        title: 'Paiement annulé',
        message: reason,
        metadata: { paymentId: payment.id, reason },
      });
    }

    return cancelled;
  }

  /** A look at the provider is written on the payment, whatever it found. A failure to write it is not the caller's. */
  private async stampLook(paymentId: number): Promise<void> {
    try {
      await this.prisma.payment.updateMany({ where: { id: paymentId }, data: { providerCheckedAt: new Date() } });
    } catch (error) {
      this.logger.error(`The look at card payment ${paymentId} was not written (${describeError(error)}).`);
    }
  }

  /**
   * A payment that the provider was asked about a few seconds ago, whatever became of it: asking again would not tell more (and the
   * number of a closed payment, held by its customer, would otherwise be a way to make the server ask the provider without pause).
   */
  justAsked(payment: any): boolean {
    return Boolean(payment.providerCheckedAt) && Date.now() - new Date(payment.providerCheckedAt).getTime() < NOTIFICATION_GAP_MS;
  }

  /**
   * One row per call of the provider, for the support. A failure to write it never fails the call. A call that says again what an earlier
   * one said (nothing to do) is written once in ten minutes: the number of the payment is in the address the customer is sent to, and
   * anyone who holds it could otherwise fill the table.
   */
  private async logNotification(providerPaymentId: string, paymentId: number, outcome: string) {
    try {
      if (['ALREADY', 'UNCHANGED', 'PENDING', 'REVIEW', 'UNREACHABLE'].includes(outcome)) {
        const earlier = await this.prisma.paymentWebhookLog.findFirst({ where: { paymentId, outcome, receivedAt: { gt: new Date(Date.now() - LOG_ONCE_MS) } } });

        if (earlier) return;
      }

      await this.prisma.paymentWebhookLog.create({ data: { provider: this.gateway.provider() as any, providerPaymentId, paymentId, outcome } });
    } catch (error) {
      this.logger.error(`The call of the payment provider was not logged (${describeError(error)}).`);
    }
  }

  /**
   * The provider says something happened to a payment (its webhook). The call carries no truth of its own: it names a payment, and the
   * provider is asked about it, at most once in a few seconds for a payment (the customer holds the number, so a loop of calls would
   * otherwise be a loop of questions to the provider). Unknown payments are answered like known ones (nothing is told to someone who
   * guesses numbers); when the provider cannot be reached for a known one, it is told to try again (and the timer looks as well).
   */
  async handleProviderNotification(routeName: string, request: GatewayNotificationRequest): Promise<{ received: true }> {
    if (!this.gateway.connected() || routeName !== this.gateway.routeName()) throw new NotFoundException();

    const ref = this.gateway.readNotification(request);

    if (!ref) throw new BadRequestException('Notification sans numéro de paiement.');

    const payment = await this.prisma.payment.findFirst({ where: { providerPaymentId: ref, provider: this.gateway.provider() as any } });

    // A reference we never gave out is answered like a known one and written nowhere (anyone can send one: a row each would be a way to
    // fill the table).
    if (!payment) return { received: true };

    // Asked about a moment ago: the answer of that look stands. (The timer and the page of the customer look again in a minute.)
    if (this.justAsked(payment)) return { received: true };

    try {
      const result = await this.syncFromProvider(payment.id);

      await this.logNotification(ref, payment.id, result.outcome);
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;

      await this.logNotification(ref, payment.id, 'UNREACHABLE');

      // A look that cannot succeed by trying again (the provider refuses the key, does not know the payment) is a look all the same: the
      // pause applies. One that failed for a passing reason is asked again at once (the provider's retry must be answered).
      if (!error.retryable) await this.stampLook(payment.id);

      throw new ServiceUnavailableException(CARD_WORDS.unavailable);
    }

    return { received: true };
  }

  /** "Check with the provider": the customer who comes back from the payment page, or the team. The answer is the payment as it is then. */
  async checkOnline(paymentId: number, user: { id: number; role: Role }) {
    const payment = await this.getPaymentOrFail(paymentId);

    if (!isBackOffice(user.role)) {
      if (user.role !== Role.CLIENT || payment.intervention.clientId !== user.id) throw new NotFoundException('Paiement introuvable.');
    }

    if (!payment.providerPaymentId) throw new BadRequestException(CARD_WORDS.nothingToCheck);

    try {
      // The customer's page asks every few seconds at most; the team's click is always an answer.
      if (user.role === Role.CLIENT && this.justAsked(payment)) return paymentForClient(payment);

      const { outcome } = await this.syncFromProvider(paymentId);

      // The provider was not asked (it is not the one connected to this server): what the payment says is not an answer of anyone.
      if (outcome === 'UNKNOWN') throw new ConflictException(CARD_WORDS.notAsked);
    } catch (error) {
      if (error instanceof GatewayError) {
        if (!error.retryable) await this.stampLook(paymentId);

        throw new ServiceUnavailableException(CARD_WORDS.unavailable);
      }

      throw error;
    }

    const updated = await this.getPaymentOrFail(paymentId);

    return user.role === Role.CLIENT ? paymentForClient(updated) : updated;
  }

  /**
   * The timer of the card payments, one round (every minute, see `payment-expiry.service.ts`). It does two jobs:
   *  - the net under the webhook: a payment that waits at the provider is asked about when nobody has for a minute, so that a webhook
   *    that never came (or came while the server was down) does not leave a paid payment waiting;
   *  - the expiry: a payment still waiting a few minutes after its time is cancelled, after the provider was asked one last time
   *    (it may have been paid in the last seconds). A provider that cannot be reached is asked again next round; after a day, the
   *    payment is cancelled anyway (a late payment then goes to the team, see `applyProviderState`).
   * A request that never reached the provider (it did not answer) and was not asked again is cancelled after a quarter of an hour.
   * Does nothing without a provider.
   */
  async sweepOnline(now: Date = new Date()): Promise<{ looked: number; confirmed: number; expired: number; unreachable: number; dropped: number }> {
    const done = { looked: 0, confirmed: 0, expired: 0, unreachable: 0, dropped: 0 };

    if (!this.gateway.connected()) return done;

    const claimedBefore = new Date(now.getTime() - NOT_STARTED_AFTER_MS);

    const stale = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        method: { in: [...ONLINE_METHODS] as any },
        providerPaymentId: null,
        // The ones that were looked at and are the team's own (see below) are not looked at again: they would fill the batch every round.
        providerCheckedAt: null,
        requestedAt: { lt: claimedBefore },
        OR: [{ gatewayClaimedAt: null }, { gatewayClaimedAt: { lt: claimedBefore } }],
      },
      include: { intervention: { select: { clientId: true } } },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
    });

    for (const payment of stale) {
      // A payment the back office recorded by hand (online, but money the team is to count) was never asked of the provider and is not
      // dropped: the team confirms or cancels it. The customer's own request has no maker (asked through the link of the request) or
      // the customer (asked from the account), the same rule as `isSameRequest`.
      const maker = payment.createdById;

      if (maker !== null && maker !== undefined && Number(maker) !== Number(payment.intervention?.clientId)) {
        await this.prisma.payment.updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { providerCheckedAt: now } });

        continue;
      }

      if (await this.cancelOnline(payment, CARD_WORDS.notStarted, { claimedBefore })) done.dropped += 1;
    }

    // The ones asked the longest ago first (never asked first): a payment that keeps failing is put behind the others, it does not
    // stand in front of them every round.
    // And the ones the team (or the timer) closed a short while ago, without any money seen: the customer may still pay on the page the
    // provider keeps, and nobody would be told (the webhook is the only other way, and it can be lost).
    const waiting = await this.prisma.payment.findMany({
      where: {
        provider: this.gateway.provider() as any,
        providerPaymentId: { not: null },
        OR: [
          {
            status: PaymentStatus.PENDING,
            OR: [{ providerCheckedAt: null }, { providerCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } }],
          },
          {
            status: { in: [PaymentStatus.CANCELLED, PaymentStatus.FAILED] },
            moneySeenAt: null,
            expiresAt: { gt: new Date(now.getTime() - CLOSED_WATCH_MS) },
            OR: [{ providerCheckedAt: null }, { providerCheckedAt: { lt: new Date(now.getTime() - CLOSED_CHECK_EVERY_MS) } }],
          },
          // The ones given up on (a week from the day they were, once an hour).
          {
            ...givenUp(now),
            OR: [{ providerCheckedAt: null }, { providerCheckedAt: { lt: new Date(now.getTime() - GIVEN_UP_CHECK_EVERY_MS) } }],
          },
        ],
      },
      orderBy: [{ providerCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: SWEEP_BATCH,
    });

    const grace = this.gateway.config.expiry.graceMinutes * 60_000;

    for (const payment of waiting) {
      const lapsed = String(payment.status) === PaymentStatus.PENDING && payment.expiresAt ? now.getTime() > new Date(payment.expiresAt).getTime() + grace : false;

      try {
        const { outcome } = await this.syncFromProvider(payment.id);

        done.looked += 1;
        if (outcome === 'CONFIRMED') done.confirmed += 1;
        if (outcome === 'EXPIRED') done.expired += 1;

        // Still waiting at the provider, and its time is over: nobody can pay it any more.
        if (outcome === 'PENDING' && lapsed && (await this.cancelOnline(payment, CARD_WORDS.expired))) done.expired += 1;
      } catch (error) {
        // One payment that cannot be looked at (the provider is down, answers that it does not know the payment, or something of ours
        // failed on it) never stops the others; it is put behind them for the next rounds.
        done.unreachable += 1;

        await this.prisma.payment.updateMany({ where: { id: payment.id, status: payment.status }, data: { providerCheckedAt: now } });

        // A provider that does not answer is the usual case and is counted; one that refuses (the key, the wallet) or an error of ours is
        // written down, with its name and code only.
        if (!(error instanceof GatewayError) || !error.retryable) {
          this.logger.error(`Card payment ${payment.id} could not be looked at (${describeError(error)}).`);
        }

        if (String(payment.status) === PaymentStatus.PENDING && payment.expiresAt && now.getTime() > new Date(payment.expiresAt).getTime() + GIVE_UP_AFTER_MS && (await this.cancelOnline(payment, CARD_WORDS.gaveUp))) done.expired += 1;
      }
    }

    return done;
  }

  /** The calls of the provider are kept for the support for three months, then forgotten (a thousand rows at a time). Returns how many rows went. */
  async purgeWebhookLog(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - WEBHOOK_LOG_KEPT_MS);
    let total = 0;

    for (let round = 0; round < PURGE_ROUNDS; round += 1) {
      const old = await this.prisma.paymentWebhookLog.findMany({ where: { receivedAt: { lt: before } }, select: { id: true }, orderBy: { id: 'asc' }, take: PURGE_BATCH });

      if (old.length === 0) break;

      const gone = await this.prisma.paymentWebhookLog.deleteMany({ where: { id: { in: old.map((row: { id: number }) => row.id) } } });

      total += gone.count;

      if (old.length < PURGE_BATCH) break;
    }

    return total;
  }

  /**
   * The card payments of a job that are worth asking the provider about when the customer asks for it (the page "Vérifier mon paiement"):
   * the ones that wait, and the ones closed a short while ago with no money seen (the customer may have paid in the last seconds).
   * Not the ones that were refused long ago, nor the ones the team already holds.
   */
  async cardPaymentsToAsk(interventionId: number, now: Date = new Date()): Promise<any[]> {
    return this.prisma.payment.findMany({
      where: {
        interventionId,
        providerPaymentId: { not: null },
        OR: [
          { status: PaymentStatus.PENDING },
          { status: { in: [PaymentStatus.CANCELLED, PaymentStatus.FAILED] }, moneySeenAt: null, expiresAt: { gt: new Date(now.getTime() - CLOSED_WATCH_MS) } },
          givenUp(now),
        ],
      },
      orderBy: { id: 'desc' },
      take: 3,
    });
  }

  /**
   * A card payment of the job whose time is over is closed before a new request looks at the open payments: after one last look at the
   * provider (it may have been paid in the last seconds), a payment that still waits is cancelled. A provider that cannot be reached
   * leaves it as it is (the timer closes it later).
   */
  async closeLapsedCards(interventionId: number, now: Date = new Date(), options: { required?: boolean } = {}): Promise<void> {
    if (!this.gateway.connected()) return;

    // And the ones given up on lately: the customer who paid before the provider went quiet must not be asked to pay a second time
    // while the first payment sits unseen (a payment found now is put in front of the team, and stands in the way of a new request).
    const lapsed = await this.prisma.payment.findMany({
      where: {
        interventionId,
        method: { in: [...ONLINE_METHODS] as any },
        providerPaymentId: { not: null },
        OR: [{ status: PaymentStatus.PENDING, expiresAt: { lt: now } }, givenUp(now)],
      },
    });

    for (const payment of lapsed) {
      try {
        const { outcome } = await this.syncFromProvider(payment.id);

        if (outcome === 'PENDING') await this.cancelOnline(payment, CARD_WORDS.expired);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;

        // A new card request would be answered with this old page (the same request is handed its open payment): not while nobody
        // can say that page still takes payments.
        if (options.required) throw new ServiceUnavailableException(CARD_WORDS.checking);
      }
    }
  }
}
