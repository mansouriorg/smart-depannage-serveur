/**
 * How a customer may pay a job (P2-06): the ways of paying the company offers, what a request would ask for, the bank account
 * to pay into for a transfer, and the payment that is already waiting. The page of the tracking link reads it before it shows a
 * choice, and the routes that take a payment request check the way of paying against the same settings, so that a button the
 * page shows is one the server accepts.
 *
 *  - The company's settings say which ways are offered (`CompanySettings.paymentMethods`). A row without a list, or with an empty
 *    one (a row from before the list existed), offers the three it starts with. "Online" stands for the card too.
 *  - A transfer needs an account to pay into (the RIB of the settings). Without one it is not offered: the customer would be told
 *    to pay nowhere.
 *  - Online payment is listed as not available while no provider is connected (P2-10). The request is still recorded when it is sent
 *    (P2-03) and waits: that is a decision of its own, not of this file.
 *  - The amount is the one a request would ask for (`amountLeft`: what the invoice, or the accepted quote while there is no invoice,
 *    asks, less what was paid and kept). A job that is paid, cancelled, or has neither an invoice nor an accepted quote, offers nothing,
 *    and says why.
 *  - Another payment that waits (a transfer to confirm, cash to confirm) is in the way of every other way of paying, with the
 *    sentence the request would be refused with. The same request again is not in the way: it is answered with the open payment.
 *
 * It only reads: nothing is locked, so the figures are a hint, and the request decides. The payments are read once, so that what
 * is received, what waits and what is left come from the same moment.
 */
import { BadRequestException } from '@nestjs/common';

import { currencyCode } from '../../common/locale/locale';
import { money } from '../../common/money/money';
import { paymentForClient } from '../../common/views/views';
import { canonicalStatus } from '../intervention-workflow/intervention-status';
import { paymentPosition } from '../cash-ledger/cash-ledger-ops';
import { amountToPay } from './financials-ops';
import { gatewayConnected, readGatewayConfig } from './gateway/gateway-config';
import { OPEN_PAYMENT_STATUSES, PAID_WORDS, amountLeft, isPlaceholder, isSameRequest, otherPaymentOpenWords } from './open-payment';

type Db = any;
type Row = Record<string, any>;

/** The ways of paying a page can offer. "Online" and "card" are one way in the settings and two names in the payments. */
export const PAYMENT_CHOICES = ['CASH', 'BANK_TRANSFER', 'ONLINE_CARD'] as const;
export type PaymentChoice = (typeof PAYMENT_CHOICES)[number];

/** What a company that never chose offers. */
export const DEFAULT_PAYMENT_METHODS: readonly string[] = ['ONLINE', 'CASH', 'BANK_TRANSFER'];

/**
 * True when a payment provider is connected (PAYMENT_PROVIDER in the environment, P2-10); without one a card payment cannot be made.
 * The callers that hold the gateway of the application pass what it says (`PaymentGatewayService.connected()`); a caller that does
 * not asks the environment.
 */
export function onlineProviderConnected(env: Record<string, unknown> = process.env): boolean {
  return gatewayConnected(readGatewayConfig(env));
}

export const PAYMENT_WORDS = {
  noQuote: 'Aucun devis accepté trouvé pour cette intervention.',
  notOffered: 'Ce mode de paiement n’est pas proposé.',
  noAccount: 'Le virement n’est pas disponible pour le moment.',
  noProvider: 'Le paiement par carte n’est pas encore disponible.',
  cardCurrency: 'Le paiement par carte n’est pas disponible pour cette devise.',
  nothingOffered: 'Aucun mode de paiement n’est proposé pour le moment.',
  cancelled: 'Cette demande est annulée: il n’y a rien à payer.',
};

/**
 * A card payment is asked in the currency of the company: the provider's amount is in thousandths of it, and the payments of a job in
 * another currency are not set against what is left to pay (a part payment would settle the job when the provider confirms it).
 */
export function ensureCardCurrency(currency: string | null | undefined): void {
  if (currency && String(currency) !== currencyCode()) throw new BadRequestException(PAYMENT_WORDS.cardCurrency);
}

/** The ways of paying the settings offer (as the names of `PaymentMethod`), the card included when "online" is. */
export function offeredMethods(settings: { paymentMethods?: unknown } | null | undefined): string[] {
  const listed = Array.isArray(settings?.paymentMethods) ? (settings.paymentMethods as unknown[]).map(String) : [];
  const list = listed.length === 0 ? [...DEFAULT_PAYMENT_METHODS] : listed;
  const online = list.includes('ONLINE') || list.includes('ONLINE_CARD');

  return Array.from(new Set([...list.filter((method) => method !== 'ONLINE' && method !== 'ONLINE_CARD'), ...(online ? ['ONLINE', 'ONLINE_CARD'] : [])]));
}

/** The account a transfer is paid into: the RIB of the settings, in its one spelling (20 digits), or null when there is none. */
export function accountOf(settings: { rib?: unknown } | null | undefined): string | null {
  const digits = typeof settings?.rib === 'string' ? settings.rib.replace(/\D/g, '') : '';

  return digits.length === 20 ? digits : null;
}

/** What the customer writes as the reason of the transfer, so that whoever reads the bank statement finds the job it pays. */
export function transferReference(interventionId: number): string {
  return `DEP-${interventionId}`;
}

async function settingsOf(db: Db): Promise<Row | null> {
  return db.companySettings.findFirst({ orderBy: { id: 'asc' } });
}

/**
 * The way of paying is one the company offers (400 otherwise). A transfer also needs an account. Online payment is not refused
 * here: its request is recorded without a provider (P2-03) and P2-10 decides what happens to it.
 */
export async function ensureMethodOffered(db: Db, method: string): Promise<void> {
  const settings = await settingsOf(db);

  if (!offeredMethods(settings).includes(method)) throw new BadRequestException(PAYMENT_WORDS.notOffered);
  if (method === 'BANK_TRANSFER' && !accountOf(settings)) throw new BadRequestException(PAYMENT_WORDS.noAccount);
}

/** A request to pay is not taken for a request that was cancelled (400). Any other status takes it: the payment is recorded whatever the stage of the work (P2-03). */
export function ensureJobTakesPayment(status: string | null | undefined): void {
  if (canonicalStatus(status) === 'CANCELLED') throw new BadRequestException(PAYMENT_WORDS.cancelled);
}

export interface PaymentOptionsView {
  interventionId: number;
  currency: string;
  /** What is paid: the invoice, or the accepted quote when there is none yet. */
  document: 'INVOICE' | 'QUOTE' | null;
  /** What the invoice or the quote asks, and what was received on it. */
  total: number | null;
  received: number;
  /** What a request would ask for now; null when none can be made. */
  amount: number | null;
  /** Whether a request can be made at all, and why not. */
  canPay: boolean;
  reason: string | null;
  methods: Array<{ method: PaymentChoice; available: boolean; reason: string | null }>;
  /** Where a transfer goes (and the reason to write on it); null when transfers are not offered, there is no account, or there is nothing to pay. The invoice on the page prints the same account while it is unpaid. */
  bank: { holder: string | null; rib: string; reference: string } | null;
  /** The payment that waits to be decided (not a card request nobody can pay), as the customer reads it. */
  open: Row | null;
}

export async function paymentOptionsOf(db: Db, job: { id: number; status: string | null | undefined; clientId?: number | null }, online: boolean = onlineProviderConnected()): Promise<PaymentOptionsView> {
  const settings = await settingsOf(db);
  const offered = offeredMethods(settings);
  const account = accountOf(settings);
  const position = await paymentPosition(db, job.id);
  const quote = position.quote;
  const document = position.document;
  const currency: string = document?.currency ?? quote?.currency ?? currencyCode();
  const waiting = position.payments.filter((payment) => OPEN_PAYMENT_STATUSES.includes(String(payment.status)) && !isPlaceholder(payment, { clientId: job.clientId }));

  let amount: number | null = null;
  let reason: string | null = null;

  if (canonicalStatus(job.status) === 'CANCELLED') {
    reason = PAYMENT_WORDS.cancelled;
  } else if (!document) {
    reason = PAYMENT_WORDS.noQuote;
  } else {
    // The same rule as the request: what is left of what the document asks, and nothing when it is all paid.
    amount = amountLeft(position, amountToPay(document), document.currency);

    if (amount === null) reason = PAID_WORDS;
  }

  const methods = PAYMENT_CHOICES.filter((method) => offered.includes(method)).map((method) => {
    let why: string | null = reason;

    if (why === null && method === 'ONLINE_CARD' && !online) why = PAYMENT_WORDS.noProvider;
    if (why === null && method === 'ONLINE_CARD' && currency !== currencyCode()) why = PAYMENT_WORDS.cardCurrency;
    if (why === null && method === 'BANK_TRANSFER' && !account) why = PAYMENT_WORDS.noAccount;

    // (No reason so far means there is an amount: the reason is set whenever there is none.)
    if (why === null) {
      // The same request again is not in the way (it is answered with the open payment); any other waiting payment is.
      const inTheWay = waiting.find((payment) => !isSameRequest(payment, { method, amount: amount as number, derived: true, clientId: job.clientId, customer: true }));

      if (inTheWay) why = otherPaymentOpenWords(inTheWay);
    }

    return { method, available: why === null, reason: why };
  });

  const bank =
    offered.includes('BANK_TRANSFER') && account && amount !== null
      ? { holder: typeof settings?.companyName === 'string' && settings.companyName.trim() !== '' ? settings.companyName.trim() : null, rib: account, reference: transferReference(job.id) }
      : null;

  // Nothing to pay with is told in words too, so that a page never shows an empty choice without a sentence.
  const blocked = reason ?? (methods.length === 0 ? PAYMENT_WORDS.nothingOffered : methods.some((choice) => choice.available) ? null : methods[0].reason);

  return {
    interventionId: job.id,
    currency,
    document: position.invoice ? 'INVOICE' : quote ? 'QUOTE' : null,
    total: document ? amountToPay(document) : null,
    received: position.received,
    amount,
    canPay: blocked === null,
    reason: blocked,
    methods,
    bank,
    open: waiting.length > 0 ? paymentForClient(waiting[waiting.length - 1]) : null,
  };
}
