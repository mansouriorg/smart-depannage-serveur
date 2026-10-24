/**
 * One open payment per job (P2-03).
 *
 * A payment is open while it waits to be decided: PENDING (asked for, nothing received) or AWAITING_CONFIRMATION (the customer
 * or the artisan says the money was handed over, the back office has not confirmed it). A job has at most one open payment
 * *request*: the customer (signed in or with the tracking link) or the back office who asks again gets the open one back when
 * it is the same request, and a refusal (409) when it is another. A second request would otherwise be confirmed too, and the
 * customer would have paid twice.
 *
 * Two things are not in the way. An online payment that has nobody behind it (no provider is connected: it can never be paid)
 * is cancelled when another way of paying is chosen, so the customer is not stuck with it. And cash that an artisan declares
 * is a fact more than a request: a cash request that is open is the one that gets declared, and an earlier declaration never
 * stands in the way of another payment. It does not go around a transfer or an online payment that someone can really pay: the
 * cash ledger refuses (409) while one is open, and the back office cancels it first.
 *
 * Callers take the lock of the job (`lockJob`) in the transaction before calling this, so two requests at the same moment
 * cannot both find the job free.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';

import { currencyCode } from '../../common/locale/locale';
import { compareMoney, formatMoney, money } from '../../common/money/money';
import { paymentPosition } from '../cash-ledger/cash-ledger-ops';

type Db = any;
type Row = Record<string, any>;

/** The statuses of a payment that waits to be decided. */
export const OPEN_PAYMENT_STATUSES: readonly string[] = ['PENDING', 'AWAITING_CONFIRMATION'];

const ONLINE_METHODS: readonly string[] = ['ONLINE', 'ONLINE_CARD'];

const METHOD_WORDS: Record<string, string> = {
  CASH: 'en espèces',
  BANK_TRANSFER: 'par virement',
  ONLINE: 'en ligne',
  ONLINE_CARD: 'par carte',
};

/** The open payments of a job, oldest first. */
export async function openPaymentsOf(db: Db, interventionId: number): Promise<Row[]> {
  const payments: Row[] = await db.payment.findMany({ where: { interventionId, status: { in: [...OPEN_PAYMENT_STATUSES] } }, orderBy: { id: 'asc' } });

  return payments;
}

/** An online request that nobody can pay: no provider took it. */
export function isPlaceholder(payment: Row): boolean {
  return String(payment.status) === 'PENDING' && ONLINE_METHODS.includes(String(payment.method)) && !payment.providerPaymentId;
}

export const SUPERSEDED_REASON = 'Remplacé par une autre demande de paiement.';

/** Cancels an online request nobody can pay (nothing was received on it, so nothing else changes). Returns false if it was decided meanwhile. */
export async function supersede(db: Db, payment: Row): Promise<boolean> {
  const changed = await db.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: SUPERSEDED_REASON },
  });

  return changed.count === 1;
}

/**
 * The same request again carries something new: the reference of the transfer the customer has just made, a note. The open
 * payment keeps it (the instructions ask for the reference after the transfer, and this is the only way to send it). Only what
 * is written is changed: an empty field never wipes what was kept.
 */
export async function refreshOpenPayment(db: Db, open: Row, details: { reference?: unknown; clientNote?: unknown; adminNote?: unknown }): Promise<void> {
  const data: Row = {};

  for (const [key, value] of Object.entries(details)) {
    const text = value === undefined || value === null ? '' : String(value);

    if (text.trim() !== '' && text !== String(open[key] ?? '')) data[key] = text;
  }

  if (Object.keys(data).length > 0) await db.payment.update({ where: { id: open.id }, data });
}

/**
 * The amount of a payment request that did not say how much: what is left to pay on the job (what it asks for, less what was
 * paid and kept, and the cash the artisan declared), never more than `asked` (the whole of the document). A deposit already
 * paid is not asked for twice, and a request that would be refused when it is confirmed is not made. Refuses a job that is paid.
 * A document in another currency than the company's cannot be set against the payments: the whole amount is asked.
 * Call it inside the transaction, after taking the lock of the job.
 */
export async function leftToPay(db: Db, interventionId: number, asked: number, currency: string | null | undefined): Promise<number> {
  if (currency && String(currency) !== currencyCode()) return asked;

  const { remaining } = await paymentPosition(db, interventionId);

  if (remaining === null) return asked;

  if (compareMoney(remaining, 0) <= 0) throw new BadRequestException('Cette mission est déjà payée.');

  return compareMoney(remaining, asked) < 0 ? remaining : asked;
}

/** The amount of a payment in words, with no word about the way it was paid (an artisan does not read that). */
export function describeAmount(payment: Row): string {
  return formatMoney(money(payment.amount), { currency: payment.currency });
}

export function describeOpenPayment(payment: Row): string {
  return `${describeAmount(payment)} ${METHOD_WORDS[String(payment.method)] ?? String(payment.method)}`;
}

/**
 * Decides what a new payment request does to the open payments of the job.
 *
 *  - The same request (same method, same amount) is already open: returns it. The caller answers with it and writes nothing.
 *  - Another open payment that nobody can pay (an online request with no provider) is cancelled.
 *  - Any other open payment (a transfer waiting for confirmation, cash waiting for confirmation, an online payment a provider
 *    took) refuses the request (409).
 *
 * Returns the open payment to reuse, or null when the caller may create the payment.
 */
export async function claimOpenPayment(db: Db, request: { interventionId: number; method: string; amount: number }): Promise<Row | null> {
  const open = await openPaymentsOf(db, request.interventionId);
  const same = open.find((payment) => String(payment.method) === request.method && compareMoney(money(payment.amount), request.amount) === 0);
  const others = open.filter((payment) => payment !== same);
  const blocking = others.filter((payment) => !isPlaceholder(payment));

  if (blocking.length > 0) {
    throw new ConflictException(`Un paiement de ${describeOpenPayment(blocking[0])} est déjà en attente pour cette mission. Faites-le annuler par l’administration ou attendez sa confirmation.`);
  }

  if (same) return same;

  for (const payment of others) {
    if (!(await supersede(db, payment))) throw new ConflictException('Un paiement vient d’être modifié sur cette mission. Réessayez.');
  }

  return null;
}
