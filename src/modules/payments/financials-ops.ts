/**
 * The financials of a job, worked out from its payments (P2-03).
 *
 * The financials of a job (what the customer paid, the platform's commission, what the artisan is owed, the refunds, the
 * revenue left) used to be typed in by the back office. They are now a result: whenever a payment is confirmed or a refund is
 * made, they are worked out again from the payments of the job, in the same transaction.
 *
 *  - totalPrice: what was received, the sum of the payments that were confirmed (paid, and paid then given back in part or in
 *    full), in the currency of the company, and never more than the job asks for (its invoice, else its accepted quote):
 *    money that went back to the customer and was paid again is received twice but is paid for once.
 *  - refundAmount: what went back to the customer, the sum of what was refunded on those payments.
 *  - platformCommission: the rate of the job (the one already on its financials, else the platform's usual one) on the total.
 *  - artisanPayout: the total less the commission. A refund does not reduce it: the platform bears the refund, as the
 *    revenue figure has always counted it (net revenue = commission - provider fee - refunds). What was refunded out of an
 *    overpayment (received above what the job asks for) is not a cost: it gives back what was never owed.
 *
 * What cannot be known from a payment stays what the back office wrote: the rate, the payment provider's fee and the notes.
 */
import { compareMoney, money, percentOf, subtractMoney, sumMoneyOf } from '../../common/money/money';
import { currencyCode } from '../../common/locale/locale';
import { DEFAULT_COMMISSION_RATE } from '../cash-ledger/cash-ledger.types';

type Db = any;
type Row = Record<string, any>;

/** The payments whose money was received: paid, and paid then given back in part or in full. */
export const RECEIVED_PAYMENT_STATUSES: readonly string[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** What went back to the customer on a payment: its refunded amount, or all of it when the payment is marked as refunded. */
export function refundedOn(payment: Row): number {
  const refunded = money(payment.amountRefunded);

  return String(payment.status) === 'REFUNDED' && compareMoney(money(payment.amount), refunded) > 0 ? money(payment.amount) : refunded;
}

/** Whether a payment is in the currency of the company (a payment with no currency written is). */
function inCompanyCurrency(payment: Row): boolean {
  return !payment.currency || String(payment.currency) === currencyCode();
}

export interface PaymentFigures {
  /** What was received on the job: the confirmed payments. */
  received: number;
  /** What went back to the customer. */
  refunded: number;
  /** What the job still holds: received less refunded. */
  kept: number;
}

/** The figures of a job's payments (only the confirmed ones, in the currency of the company, count). */
export function paymentFigures(payments: Row[]): PaymentFigures {
  const counted = payments.filter((payment) => RECEIVED_PAYMENT_STATUSES.includes(String(payment.status)) && inCompanyCurrency(payment));
  const received = sumMoneyOf(counted.map((payment) => payment.amount));
  const refunded = sumMoneyOf(counted.map((payment) => refundedOn(payment)));

  return { received, refunded, kept: subtractMoney(received, refunded) };
}

/**
 * An invoice that asks something of the customer: one that was not cancelled, and is not a draft (a draft is not the customer's
 * yet: the tracking page never shows it). One rule for the payment position, the financials and the payout holds, so that they
 * all price a job with the same document.
 */
export const isLiveInvoice = (invoice: Row | null | undefined): invoice is Row => Boolean(invoice) && String(invoice!.status) !== 'CANCELLED' && String(invoice!.status) !== 'DRAFT';

/** What the job asks for: its invoice when it has a live one (see `isLiveInvoice`), else its latest accepted quote. */
export async function documentOfJob(db: Db, interventionId: number): Promise<Row | null> {
  const invoice: Row | null = await db.invoice.findUnique({ where: { interventionId } });

  if (isLiveInvoice(invoice)) return invoice;

  return db.quote.findFirst({ where: { interventionId, status: 'ACCEPTED' }, orderBy: { createdAt: 'desc' } });
}

/** What the back office can still decide for itself on the financials of a job. */
export interface FinancialsOverrides {
  commissionRate?: number;
  paymentProviderFee?: number;
  notes?: string | null;
}

/**
 * Works the financials of the job out from its payments and writes them (one row per job). Returns the row, or null when there
 * is nothing to work out: the job has no artisan, or no payment of it was confirmed yet. Call it inside the transaction that
 * changes the payments, after taking the lock of the job.
 */
export async function syncFinancials(db: Db, interventionId: number, by: { userId: number | null }, overrides: FinancialsOverrides = {}): Promise<Row | null> {
  const job: Row | null = await db.intervention.findUnique({ where: { id: interventionId }, select: { artisanId: true } });

  if (!job?.artisanId) return null;

  const payments: Row[] = await db.payment.findMany({ where: { interventionId } });
  const figures = paymentFigures(payments);

  if (compareMoney(figures.received, 0) <= 0) return null;

  const existing: Row | null = await db.interventionFinancials.findUnique({ where: { interventionId } });

  const rate = overrides.commissionRate ?? (existing && existing.commissionRate !== null && existing.commissionRate !== undefined ? Number(String(existing.commissionRate)) : DEFAULT_COMMISSION_RATE);
  const fee = overrides.paymentProviderFee !== undefined ? money(overrides.paymentProviderFee) : existing ? money(existing.paymentProviderFee) : 0;
  const notes = overrides.notes !== undefined ? (overrides.notes?.trim() || null) : (existing?.notes ?? null);

  // What is paid for: what was received, up to what the job asks for (a document in another currency cannot be compared).
  const document = await documentOfJob(db, interventionId);
  const asked = document && String(document.currency) === currencyCode() ? money(document.amountTTC) : 0;
  const price = compareMoney(asked, 0) > 0 && compareMoney(figures.received, asked) > 0 ? asked : figures.received;

  // A refund out of what was received above the price gives back an overpayment: the platform does not bear it.
  const overpaid = subtractMoney(figures.received, price);
  const borne = compareMoney(figures.refunded, overpaid) > 0 ? subtractMoney(figures.refunded, overpaid) : 0;

  const platformCommission = percentOf(price, rate);
  const artisanPayout = subtractMoney(price, platformCommission);
  const netRevenue = subtractMoney(subtractMoney(platformCommission, fee), borne);

  const data = {
    totalPrice: price,
    commissionRate: rate,
    platformCommission,
    artisanPayout,
    paymentProviderFee: fee,
    refundAmount: figures.refunded,
    netRevenue,
    companyMargin: netRevenue,
    currency: currencyCode(),
    notes,
    calculatedById: by.userId,
  };

  return db.interventionFinancials.upsert({ where: { interventionId }, update: data, create: { interventionId, ...data } });
}

const WAITING_REFUND_DECISIONS: readonly string[] = ['PENDING', 'APPROVED'];

/** The refund decisions that say the money went back: they close the question of the refund. */
export const REFUND_MADE_DECISIONS: readonly string[] = ['PARTIAL_REFUND', 'REFUNDED'];

/** What the back office is told when it tries to decide again a refund that was made. */
export const REFUND_ALREADY_MADE = 'Le remboursement de cette réclamation est déjà effectué.';

/** A complaint that was closed without a refund: a refund that comes later is not an answer to it. */
const CLOSED_WITHOUT_REFUND: readonly string[] = ['RESOLVED', 'REJECTED'];

/**
 * A refund was made on the job: the complaints of the job that were waiting for one are decided. A refund of everything that was
 * received is REFUNDED, anything less is PARTIAL_REFUND; the amount is what went back to the customer on the whole job. Returns
 * how many complaints were decided (only the complaint `only`, when one is given: a decision made on it for money that already
 * went back must not decide the others). The status and dates follow what a refund decision made by hand does.
 *
 * What a person already decided is respected:
 *  - a complaint that was closed (resolved or rejected) without a refund is left alone;
 *  - a refund that a person approved for an amount stays approved, and waiting, until that amount has gone back; it then keeps
 *    the person and the date of the approval; a refusal that a person wrote before the decision itself was written stays a
 *    refusal;
 *  - only the complaints still waiting are written, and only if they are still waiting when they are (a person may decide in
 *    between).
 */
export async function settleComplaintRefund(db: Db, interventionId: number, by: { userId: number | null }, figures: PaymentFigures, only?: number): Promise<number> {
  const waiting: Row[] = await db.complaint.findMany({
    where: { interventionId, refundDecision: { in: [...WAITING_REFUND_DECISIONS] }, ...(only !== undefined ? { id: only } : {}) },
    select: { id: true, status: true, refundDecision: true, refundAmount: true, refundApproved: true, refundDecidedAt: true },
  });

  // Nothing was received in the currency of the company (a refund of a payment in another one): there is no refund to speak of.
  if (compareMoney(figures.received, 0) <= 0) return 0;

  const now = new Date();
  const decision = compareMoney(figures.refunded, figures.received) >= 0 ? 'REFUNDED' : 'PARTIAL_REFUND';
  let decided = 0;

  for (const complaint of waiting) {
    // A decision made by a person before the decision itself was written (it was left at PENDING): a refusal stays a refusal,
    // an approval is an approval.
    const decidedBefore = String(complaint.refundDecision) === 'PENDING' && complaint.refundDecidedAt !== null && complaint.refundDecidedAt !== undefined;

    if (decidedBefore && complaint.refundApproved !== true) continue;

    const approved = String(complaint.refundDecision) === 'APPROVED' || decidedBefore;
    const promised = money(complaint.refundAmount);

    // Closed without a refund: not an answer to this complaint.
    if (!approved && CLOSED_WITHOUT_REFUND.includes(String(complaint.status))) continue;

    // Approved for an amount that has not all gone back yet: still waiting.
    if (approved && compareMoney(promised, 0) > 0 && compareMoney(figures.refunded, promised) < 0) continue;

    const data = approved
      ? { refundDecision: decision, refundApproved: true, refundAmount: figures.refunded }
      : {
          refundDecision: decision,
          refundApproved: true,
          refundAmount: figures.refunded,
          refundDecidedById: by.userId,
          refundDecidedAt: now,
          status: 'REFUNDED',
          resolvedAt: now,
          closedAt: now,
        };

    const changed = await db.complaint.updateMany({ where: { id: complaint.id, refundDecision: complaint.refundDecision }, data });

    decided += changed.count;
  }

  return decided;
}
