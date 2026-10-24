/**
 * Which jobs a payout leaves out, why, and what it pays for the others (P2-02).
 *
 * A payout pays an artisan the share that the platform owes them for jobs it has been paid for. These make a job not ready to
 * be paid out, and each is a reason that the back office is shown:
 *
 *  - NOT_FINISHED: the work is not done (the job is still being arranged or worked on). A customer may have paid in advance;
 *    the artisan is paid when the work is done.
 *  - NOT_PAID: the customer has not paid all of what the job asks for (its invoice, else its accepted quote): the financials
 *    of a job exist from the first confirmed payment, and the share is only known when everything was received. Cash that the
 *    artisan declared counts once the back office has confirmed it.
 *  - OPEN_DISPUTE: a complaint on the job is still being handled (or the job itself is in dispute). What is owed is not known
 *    until the complaint is decided.
 *  - REFUND: a refund is being decided (asked for or approved but not made), or money has gone back to the customer and the
 *    financials of the job do not say so yet. The back office records the refund in the financials (`refundAmount`), and the
 *    job is released at once.
 *  - PAID_IN_CASH: the artisan took the customer's cash for the whole job; the share they keep is already in their hand and
 *    what they owe the platform is in their cash ledger. Paying the share again would pay it twice.
 *
 * A job that was paid partly in cash is not held: it is paid for the part that the platform received (the share, times the
 * part of the price that did not go through the artisan's hand). A held job stays out of every payout until the reason is
 * gone; nothing is deleted.
 */
import { cashHeldByJob } from '../cash-ledger/cash-ledger-ops';
import { canonicalStatus } from '../intervention-workflow/intervention-status';
import { paymentFigures, refundedOn } from '../payments/financials-ops';
import { currencyCode } from '../../common/locale/locale';
import { compareMoney, money, proportionOf, subtractMoney, sumMoneyOf } from '../../common/money/money';

export type PayoutHold = 'OPEN_DISPUTE' | 'REFUND' | 'PAID_IN_CASH' | 'NOT_FINISHED' | 'NOT_PAID';

/** The statuses (in their canonical spelling) of a job whose work is done. */
export const WORK_DONE_STATUSES = ['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT'];

/** The complaints that are still being handled. */
export const OPEN_COMPLAINT_STATUSES = ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'];

/** A refund that was asked for or approved but not made yet. */
export const REFUND_DECISIONS_PENDING = ['PENDING', 'APPROVED'];

/** A refund that the complaint says was made. */
export const REFUND_DECISIONS_MADE = ['PARTIAL_REFUND', 'REFUNDED'];

/** The payments that took money in the artisan's hand and have not been undone. */
const CASH_PAYMENT_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];

/** The payments that say that money went back to the customer. */
const REFUNDED_PAYMENT_STATUSES = ['REFUNDED', 'PARTIALLY_REFUNDED'];

type Db = any;
type Row = Record<string, any>;

export interface PayoutDecision {
  /** Why the job is held; empty when it can be paid. */
  reasons: PayoutHold[];
  /** The cash the artisan holds for this job (0 when none). */
  cashHeld: number;
  /** What a payout pays for the job: the share, less the part of it that went through the artisan's hand. */
  amount: number;
}

export interface PayoutFinancial {
  id: number;
  interventionId: number;
  totalPrice?: unknown;
  artisanPayout?: unknown;
  refundAmount?: unknown;
}

/**
 * The decision for each of these financials (by the id of the financial) of the jobs of this artisan: held with its reasons, or
 * free with what it pays. The cash of the ledger is the cash of this artisan: a job that another artisan had before is not
 * held by their lines.
 */
export async function payoutDecisions(db: Db, artisanId: number, financials: PayoutFinancial[]): Promise<Map<number, PayoutDecision>> {
  const decisions = new Map<number, PayoutDecision>();

  if (financials.length === 0) return decisions;

  const ids = [...new Set(financials.map((item) => item.interventionId))];

  const complaints: Row[] = await db.complaint.findMany({ where: { interventionId: { in: ids } }, select: { interventionId: true, status: true, refundDecision: true } });
  const jobs: Row[] = await db.intervention.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  const payments: Row[] = await db.payment.findMany({ where: { interventionId: { in: ids } }, select: { interventionId: true, method: true, status: true, amount: true, amountRefunded: true, currency: true } });
  const invoices: Row[] = await db.invoice.findMany({ where: { interventionId: { in: ids } }, select: { interventionId: true, status: true, amountTTC: true, currency: true } });
  const quotes: Row[] = await db.quote.findMany({ where: { interventionId: { in: ids }, status: 'ACCEPTED' }, orderBy: { createdAt: 'desc' }, select: { interventionId: true, amountTTC: true, currency: true } });
  const ledgerCash = await cashHeldByJob(db, artisanId, ids);

  const statusOf = new Map<number, string>(jobs.map((job) => [job.id as number, String(job.status)]));
  const paymentsByJob = new Map<number, Row[]>();

  for (const payment of payments) paymentsByJob.set(payment.interventionId, [...(paymentsByJob.get(payment.interventionId) ?? []), payment]);

  // What each job asks for: its invoice when it has one that was not cancelled, else its latest accepted quote.
  const documentOf = new Map<number, Row>();

  for (const quote of quotes) if (!documentOf.has(quote.interventionId)) documentOf.set(quote.interventionId, quote);

  for (const invoice of invoices) if (String(invoice.status) !== 'CANCELLED') documentOf.set(invoice.interventionId, invoice);

  const disputed = new Set<number>();
  const refundPending = new Set<number>();
  const refundMentioned = new Set<number>();

  for (const complaint of complaints) {
    if (OPEN_COMPLAINT_STATUSES.includes(String(complaint.status))) disputed.add(complaint.interventionId);
    if (REFUND_DECISIONS_PENDING.includes(String(complaint.refundDecision))) refundPending.add(complaint.interventionId);
    if (REFUND_DECISIONS_MADE.includes(String(complaint.refundDecision)) || String(complaint.status) === 'REFUNDED') refundMentioned.add(complaint.interventionId);
  }

  for (const job of jobs) {
    if (String(job.status) === 'DISPUTED') disputed.add(job.id);
  }

  const refundedByJob = new Map<number, number>();
  const cashPaymentsByJob = new Map<number, number>();

  for (const payment of payments) {
    const id = payment.interventionId as number;

    refundedByJob.set(id, sumMoneyOf([refundedByJob.get(id) ?? 0, refundedOn(payment)]));

    // A payment that says it was refunded with no amount behind it: a refund was made and nobody wrote how much.
    if (REFUNDED_PAYMENT_STATUSES.includes(String(payment.status))) refundMentioned.add(id);

    if (String(payment.method) === 'CASH' && CASH_PAYMENT_STATUSES.includes(String(payment.status))) {
      cashPaymentsByJob.set(id, sumMoneyOf([cashPaymentsByJob.get(id) ?? 0, subtractMoney(money(payment.amount), refundedOn(payment))]));
    }
  }

  for (const item of financials) {
    const reasons: PayoutHold[] = [];
    const recorded = money(item.refundAmount as any);
    const refunded = refundedByJob.get(item.interventionId) ?? 0;
    const total = money(item.totalPrice as any);
    const share = money(item.artisanPayout as any);

    // The cash of the ledger, or of the cash payments that were confirmed without the artisan declaring them (older data).
    const ledger = ledgerCash.get(item.interventionId) ?? 0;
    const paid = cashPaymentsByJob.get(item.interventionId) ?? 0;
    const cashHeld = compareMoney(paid, ledger) > 0 ? paid : ledger;

    if (disputed.has(item.interventionId)) reasons.push('OPEN_DISPUTE');

    // The work first, then the money: an advance on a job being worked on, or a deposit on a job that is done, is not the
    // whole of it.
    const status = statusOf.get(item.interventionId);

    const meaning = canonicalStatus(status);

    // Whichever spelling the row uses (an invoiced job may be stored as INVOICE_READY).
    if (status !== undefined && !(meaning && WORK_DONE_STATUSES.includes(meaning)) && meaning !== 'DISPUTED') reasons.push('NOT_FINISHED');

    const document = documentOf.get(item.interventionId);
    const documentInCompanyCurrency = document && String(document.currency) === currencyCode();

    if (document && documentInCompanyCurrency && compareMoney(paymentFigures(paymentsByJob.get(item.interventionId) ?? []).received, money(document.amountTTC)) < 0) reasons.push('NOT_PAID');

    // A refund still to be decided; or money that went back and that the financials do not record; or a complaint that says
    // a refund was made when nothing records an amount anywhere.
    const notRecorded = compareMoney(refunded, recorded) > 0 || (refundMentioned.has(item.interventionId) && compareMoney(recorded, 0) <= 0);

    if (refundPending.has(item.interventionId) || notRecorded) reasons.push('REFUND');

    let amount = share;

    if (compareMoney(cashHeld, 0) > 0) {
      if (compareMoney(cashHeld, total) >= 0) reasons.push('PAID_IN_CASH');
      else amount = proportionOf(share, subtractMoney(total, cashHeld), total);
    }

    decisions.set(item.id, { reasons, cashHeld, amount: reasons.length > 0 ? share : amount });
  }

  return decisions;
}
