/**
 * Which jobs a payout leaves out, why, and what it pays for the others (P2-02).
 *
 * A payout pays an artisan the share that the platform owes them for jobs it has been paid for. Three things make a job not
 * ready to be paid out, and each is a reason that the back office is shown:
 *
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
import { compareMoney, money, proportionOf, subtractMoney, sumMoneyOf } from '../../common/money/money';

export type PayoutHold = 'OPEN_DISPUTE' | 'REFUND' | 'PAID_IN_CASH';

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

/** What went back to the customer on a payment: its refunded amount, or all of it when the payment is marked as refunded. */
function refundedOn(payment: Row): number {
  const refunded = money(payment.amountRefunded);

  return String(payment.status) === 'REFUNDED' && compareMoney(money(payment.amount), refunded) > 0 ? money(payment.amount) : refunded;
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
  const payments: Row[] = await db.payment.findMany({ where: { interventionId: { in: ids } }, select: { interventionId: true, method: true, status: true, amount: true, amountRefunded: true } });
  const ledgerCash = await cashHeldByJob(db, artisanId, ids);

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
