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

/**
 * Whether the customer made the payment: asked through the link of the request (no maker), or from the account (the customer's own
 * number), as opposed to a payment the back office entered.
 */
export function madeByCustomer(payment: Row, clientId: number | null | undefined): boolean {
  const maker = payment.createdById;

  return maker === null || maker === undefined || (clientId !== null && clientId !== undefined && Number(maker) === Number(clientId));
}

/**
 * An online request that nobody can pay: no provider took it. For a request of the customer (`owner`), only the customer's own: an
 * online payment that the back office entered by hand (money to be counted by the team) is not an empty request, it is theirs to
 * confirm or to cancel, and is neither taken over nor cancelled by a customer who asks to pay by card.
 */
export function isPlaceholder(payment: Row, owner?: { clientId: number | null | undefined }): boolean {
  const empty = String(payment.status) === 'PENDING' && ONLINE_METHODS.includes(String(payment.method)) && !payment.providerPaymentId;

  return empty && (owner === undefined || madeByCustomer(payment, owner.clientId));
}

export const SUPERSEDED_REASON = 'Remplacé par une autre demande de paiement.';

/** Cancels an online request nobody can pay (nothing was received on it, so nothing else changes). Returns false if it was decided meanwhile. */
export async function supersede(db: Db, payment: Row): Promise<boolean> {
  const changed = await db.payment.updateMany({
    // Still without a provider: a request the provider took while this one was read has its page now, and is not cancelled under it.
    where: { id: payment.id, status: 'PENDING', providerPaymentId: null },
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
  if (isForeign(currency)) return asked;

  const left = amountLeft(await paymentPosition(db, interventionId), asked, currency);

  if (left === null) throw new BadRequestException(PAID_WORDS);

  return left;
}

/** What a customer is told when the job has nothing left to pay. */
export const PAID_WORDS = 'Cette mission est déjà payée.';

const isForeign = (currency: string | null | undefined): boolean => Boolean(currency) && String(currency) !== currencyCode();

/**
 * The rule of `leftToPay` on a position that was already read (so that a screen can tell what a request would ask without reading
 * the payments twice): what is left, never more than `asked`; the whole of `asked` when the document is in another currency or
 * there is nothing to set the payments against; null when nothing is left.
 */
export function amountLeft(position: { remaining: number | null }, asked: number, currency: string | null | undefined): number | null {
  if (isForeign(currency) || position.remaining === null) return asked;

  if (compareMoney(position.remaining, 0) <= 0) return null;

  return compareMoney(position.remaining, asked) < 0 ? position.remaining : asked;
}

/** The amount of a payment in words, with no word about the way it was paid (an artisan does not read that). */
export function describeAmount(payment: Row): string {
  return formatMoney(money(payment.amount), { currency: payment.currency });
}

/**
 * The open payments of a job that are not cash, and the one among them that stands in the way of declaring cash: an online
 * request that nobody can pay is not in the way (the collection cancels it), a transfer waiting for its confirmation or an online
 * payment a provider took is. One place for the collection (which refuses) and the position (which tells the app beforehand).
 * (Cash that was declared before is a fact, not a request: it is never in the way.)
 */
export function paymentsInTheWayOfCash(payments: Row[]): { others: Row[]; blocking: Row | undefined } {
  const others = payments.filter((other) => OPEN_PAYMENT_STATUSES.includes(String(other.status)) && other.method !== 'CASH');

  return { others, blocking: others.find((other) => !isPlaceholder(other)) };
}

export function describeOpenPayment(payment: Row): string {
  return `${describeAmount(payment)} ${METHOD_WORDS[String(payment.method)] ?? String(payment.method)}`;
}

/** What a customer is told when another payment is already waiting on the job (the refusal of a new request, and the reason the payment options give beforehand). */
export const otherPaymentOpenWords = (payment: Row): string =>
  `Un paiement de ${describeOpenPayment(payment)} est déjà en attente pour cette mission. Faites-le annuler par l’administration ou attendez sa confirmation.`;

/**
 * Whether an open payment is the one a request asks for: the same method and the same amount, or, for a transfer asked for again
 * when the amount is worked out (`derived`), the transfer the customer asked for earlier when the document has grown since (see
 * `claimOpenPayment`). It is the customer's own (asked for through the link or by the customer, not entered by the back office),
 * and it is not more than what is left now: the team could not confirm more than that. The payment options use the same rule, so
 * that a way the page offers is one the server answers with the open payment instead of refusing it.
 */
export function isSameRequest(payment: Row, request: { method: string; amount: number; derived?: boolean; clientId?: number | null; customer?: boolean }): boolean {
  if (String(payment.method) !== request.method) return false;

  const theirs = madeByCustomer(payment, request.clientId);

  // A card request of the customer is never answered with an online payment the back office entered: that one is the team's to count,
  // and the provider would be asked for a payment on a row that was never meant for it.
  if (request.customer === true && ONLINE_METHODS.includes(request.method) && !theirs) return false;

  if (compareMoney(money(payment.amount), request.amount) === 0) return true;
  if (request.derived !== true || request.method !== 'BANK_TRANSFER') return false;

  return theirs && compareMoney(money(payment.amount), request.amount) < 0;
}

/**
 * Decides what a new payment request does to the open payments of the job.
 *
 *  - The same request (same method, same amount) is already open: returns it. The caller answers with it and writes nothing.
 *    A transfer whose amount was worked out and not typed (`derived`) is also the same request when the customer's own transfer is
 *    smaller than what is asked now: the reference of a transfer is sent after it was made, and an invoice issued meanwhile must not
 *    lock the customer out of sending it. (Cash that waits is not: it may be a declaration of the technician for another part of
 *    the price. A transfer the back office entered, or one larger than what is left, is not either: see `isSameRequest`.)
 *  - Another open payment that nobody can pay (an online request with no provider) is cancelled.
 *  - Any other open payment (a transfer waiting for confirmation, cash waiting for confirmation, an online payment a provider
 *    took) refuses the request (409).
 *
 *  - On a request of the customer (`customer`), an online payment that the back office entered is neither answered nor cancelled: it
 *    refuses the request (409) like any other open payment.
 *
 * Returns the open payment to reuse, or null when the caller may create the payment.
 */
export async function claimOpenPayment(
  db: Db,
  request: { interventionId: number; method: string; amount: number; derived?: boolean; clientId?: number | null; customer?: boolean },
): Promise<Row | null> {
  const open = await openPaymentsOf(db, request.interventionId);
  const same = open.find((payment) => isSameRequest(payment, request));
  const others = open.filter((payment) => payment !== same);
  // The customer's request cancels only the empty card requests that are the customer's own (see `isPlaceholder`).
  const owner = request.customer === true ? { clientId: request.clientId } : undefined;
  const blocking = others.filter((payment) => !isPlaceholder(payment, owner));

  if (blocking.length > 0) throw new ConflictException(otherPaymentOpenWords(blocking[0]));

  if (same) return same;

  for (const payment of others) {
    if (!(await supersede(db, payment))) throw new ConflictException('Un paiement vient d’être modifié sur cette mission. Réessayez.');
  }

  return null;
}
