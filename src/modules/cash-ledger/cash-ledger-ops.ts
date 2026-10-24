/**
 * What is done with the lines of the cash ledger (P2-02), as functions of a database client so that a payment and its ledger
 * lines change in the same transaction.
 *
 * Every function that writes takes the artisan's lock first (see `assignment/artisan-lock`), so it must be called inside `$transaction`.
 * The lines are never changed: a reversal is a new line that takes back an old one, and a line is taken back once (the
 * `reversesId` column is unique).
 */
import { ConflictException } from '@nestjs/common';

import { currencyCode } from '../../common/locale/locale';
import { compareMoney, money, moneyOrNull, percentOf, subtractMoney, sumMoney } from '../../common/money/money';
import { DEFAULT_COMMISSION_RATE, LedgerEntryView, LedgerTotals, LedgerType } from './cash-ledger.types';
import { lockCashLedger, lockPayouts } from '../assignment/artisan-lock';
import { amountToPay, liveInvoiceOf } from '../payments/financials-ops';

/** A Prisma client or the client of a transaction. */
type Db = any;

type Row = Record<string, any>;

const negate = (amount: unknown) => subtractMoney(0, money(amount as any));

/** A line as it is shown: plain numbers, and none of the columns that only the server uses. */
export function viewOfEntry(entry: Row): LedgerEntryView {
  return {
    id: entry.id,
    type: entry.type as LedgerType,
    interventionId: entry.interventionId ?? null,
    paymentId: entry.paymentId ?? null,
    cashAmount: money(entry.cashAmount),
    commissionAmount: money(entry.commissionAmount),
    commissionRate: moneyOrNull(entry.commissionRate),
    currency: entry.currency,
    reference: entry.reference ?? null,
    note: entry.note ?? null,
    reversesId: entry.reversesId ?? null,
    createdAt: entry.createdAt,
  };
}

/** The sums of a group of lines, by type: what one query answers, so that the figures come from one moment. */
export type TypeSums = Array<{ type?: unknown; _sum?: { cashAmount?: unknown; commissionAmount?: unknown } | null }>;

/** The figures of a ledger from its sums by type. */
export function totalsOfSums(groups: TypeSums): LedgerTotals {
  let cash = 0;
  let commission = 0;
  let remittances = 0;

  for (const group of groups) {
    cash = sumMoney(cash, money(group._sum?.cashAmount as any));
    commission = sumMoney(commission, money(group._sum?.commissionAmount as any));

    if (group.type === 'REMITTANCE') remittances = sumMoney(remittances, money(group._sum?.commissionAmount as any));
  }

  return totalsFrom(cash, commission, remittances);
}

/** The figures of one artisan, added up from all their lines in one query (two queries could see two different moments). */
export async function ledgerTotals(db: Db, artisanId: number): Promise<LedgerTotals> {
  const groups: TypeSums = await db.cashLedgerEntry.groupBy({ by: ['type'], where: { artisanId }, _sum: { cashAmount: true, commissionAmount: true } });

  return totalsOfSums(groups);
}

/** The same figures from the three sums (the list of all the artisans adds them up in one query). */
export function totalsFrom(cash: unknown, commission: unknown, remittances: unknown): LedgerTotals {
  const balance = money(commission as any);
  const commissionRemitted = negate(remittances);

  return {
    currency: currencyCode(),
    cashCollected: money(cash as any),
    commissionDue: sumMoney(balance, commissionRemitted),
    commissionRemitted,
    balance,
  };
}

/** The commission rate of a job: the one on its financials if the back office has computed them, else the platform's usual one. */
export async function commissionRateFor(db: Db, interventionId: number): Promise<number> {
  const financials = await db.interventionFinancials.findUnique({ where: { interventionId }, select: { commissionRate: true } });

  return financials?.commissionRate === undefined || financials?.commissionRate === null ? DEFAULT_COMMISSION_RATE : Number(String(financials.commissionRate));
}

/** The collections that stand: those that nobody has taken back. */
export async function activeCollections(db: Db, where: { paymentId?: number; interventionId?: number; artisanId?: number }): Promise<Row[]> {
  const collections: Row[] = await db.cashLedgerEntry.findMany({ where: { ...where, type: 'COLLECTION' }, orderBy: { id: 'asc' } });

  if (collections.length === 0) return [];

  const reversals: Row[] = await db.cashLedgerEntry.findMany({
    where: { type: 'REVERSAL', reversesId: { in: collections.map((entry) => entry.id) } },
    select: { reversesId: true },
  });
  const taken = new Set(reversals.map((entry) => entry.reversesId));

  return collections.filter((entry) => !taken.has(entry.id));
}

/**
 * The cash this artisan holds for each of these jobs: the sum of the cash of all their lines on it (the lines of another
 * artisan, who had the job before, are not theirs). A job with more than nothing here was paid in the artisan's hand, and what
 * the platform owes the artisan for it is settled there, not in a payout.
 */
export async function cashHeldByJob(db: Db, artisanId: number, interventionIds: number[]): Promise<Map<number, number>> {
  const held = new Map<number, number>();

  if (interventionIds.length === 0) return held;

  const groups: Row[] = await db.cashLedgerEntry.groupBy({ by: ['interventionId'], where: { artisanId, interventionId: { in: interventionIds } }, _sum: { cashAmount: true } });

  for (const group of groups) held.set(group.interventionId, money(group._sum?.cashAmount));

  return held;
}

/**
 * What has been paid on a job: money that was received, and cash an artisan says they took. Money in another currency than the
 * company's is not in the sum: it cannot be set against the price of the job (the figures of the job leave it out too).
 */
export function receivedOn(payments: Row[], declared: Set<number>): number {
  const parts = payments.map((payment) => {
    if (payment.currency && String(payment.currency) !== currencyCode()) return 0;
    if (payment.status === 'PAID' || payment.status === 'PARTIALLY_REFUNDED') return subtractMoney(money(payment.amount), money(payment.amountRefunded));
    if (payment.status === 'AWAITING_CONFIRMATION' && declared.has(payment.id)) return money(payment.amount);

    return 0;
  });

  return parts.reduce<number>((total, part) => sumMoney(total, part), 0);
}

/**
 * What a job has to pay and what has been paid: its invoice (or, without one, its accepted quote) against the payments that
 * were received and the cash that artisans declared. `remaining` is null when the job has no document to pay.
 */
export async function paymentPosition(db: Db, interventionId: number) {
  // A cancelled invoice asks nothing, and neither does a draft: it is not the customer's yet (the customer never sees it). A job
  // that had several invoices is priced by the live one (P2-07).
  const liveInvoice: Row | null = await liveInvoiceOf(db, interventionId);
  const quote: Row | null = await db.quote.findFirst({ where: { interventionId, status: 'ACCEPTED' }, orderBy: { createdAt: 'desc' } });
  const document = liveInvoice ?? quote;
  const payments: Row[] = await db.payment.findMany({ where: { interventionId }, orderBy: { id: 'asc' } });
  const declared = new Set((await activeCollections(db, { interventionId })).map((entry) => entry.paymentId));
  const received = receivedOn(payments, declared);

  return {
    invoice: liveInvoice,
    quote,
    document,
    payments,
    declared,
    received,
    remaining: document ? subtractMoney(amountToPay(document), received) : null,
  };
}

/**
 * Whether a payout that was paid has taken the financials of this job: the platform has already given the artisan their share,
 * so cash taken afterwards cannot be put right by the payout. (A payout that is not paid yet is cancelled and made again.)
 */
export async function jobIsInPaidPayout(db: Db, interventionId: number): Promise<boolean> {
  const item = await db.artisanPayoutItem.findFirst({ where: { interventionId, payout: { status: 'PAID' } }, select: { id: true } });

  return item !== null && item !== undefined;
}

/**
 * The payment was cancelled or failed: the cash it stood for was not taken after all. Takes back each collection of the
 * payment that still stands. Does nothing when there is none, and nothing the second time.
 */
export async function reverseCollectionsOfPayment(tx: Db, paymentId: number, by: { userId: number | null; reason: string }): Promise<number> {
  const first = await activeCollections(tx, { paymentId });

  if (first.length === 0) return 0;

  await lockCashLedger(tx, first[0].artisanId);

  // A payout is checked against the cash of its jobs when it is paid: the cash does not change between the check and the write.
  if (first[0].interventionId !== null && first[0].interventionId !== undefined) {
    const job: Row | null = await tx.intervention.findUnique({ where: { id: first[0].interventionId }, select: { artisanId: true } });

    if (job?.artisanId) await lockPayouts(tx, job.artisanId);
  }

  // Read again after taking the lock: another request may have taken the collection back in the meantime.
  const standing = await activeCollections(tx, { paymentId });

  for (const entry of standing) {
    await tx.cashLedgerEntry.create({
      data: {
        artisanId: entry.artisanId,
        type: 'REVERSAL',
        interventionId: entry.interventionId,
        paymentId: entry.paymentId,
        cashAmount: negate(entry.cashAmount),
        commissionAmount: negate(entry.commissionAmount),
        commissionRate: entry.commissionRate,
        currency: entry.currency,
        note: by.reason,
        reversesId: entry.id,
        recordedById: by.userId,
      },
    });
  }

  return standing.length;
}

/**
 * A payment that had been failed or cancelled is confirmed after all: the cash it stood for was taken. Puts back the
 * collection that was taken back, once. A payment that never had a collection (it was not declared by the artisan) gets none.
 */
export async function restoreCollectionOfPayment(tx: Db, paymentId: number, by: { userId: number | null }): Promise<boolean> {
  const everyCollection: Row[] = await tx.cashLedgerEntry.findMany({ where: { paymentId, type: 'COLLECTION' }, orderBy: { id: 'asc' } });

  if (everyCollection.length === 0) return false;

  await lockCashLedger(tx, everyCollection[0].artisanId);

  if ((await activeCollections(tx, { paymentId })).length > 0) return false;

  const last = everyCollection[everyCollection.length - 1];

  await tx.cashLedgerEntry.create({
    data: {
      artisanId: last.artisanId,
      type: 'COLLECTION',
      interventionId: last.interventionId,
      paymentId,
      cashAmount: money(last.cashAmount),
      commissionAmount: money(last.commissionAmount),
      commissionRate: last.commissionRate,
      currency: last.currency,
      note: 'Paiement confirmé après avoir été annulé ou marqué comme échoué.',
      recordedById: by.userId,
    },
  });

  return true;
}

/** What `settleCashOnConfirm` did. */
export type CashSettlement = 'standing' | 'restored' | 'booked' | 'skipped';

const CASH_OVER_WHAT_IS_LEFT = 'Ce paiement en espèces dépasse ce qu’il reste à payer sur cette mission.';

/** Whether a payment is above what its job has left to pay. A job with no document, or one in another currency, has nothing to compare with. */
function exceedsWhatIsLeft(position: { remaining: number | null; document: Row | null }, payment: Row): boolean {
  if (position.remaining === null) return false;

  if (position.document?.currency && String(position.document.currency) !== currencyCode()) return false;

  return compareMoney(money(payment.amount), position.remaining) > 0;
}

/**
 * A cash payment is confirmed: the cash it stands for is in the artisan's ledger, once.
 *
 *  - The artisan declared it and it stands: nothing to do.
 *  - The artisan declared it and it was taken back (the payment failed or was cancelled): it is put back.
 *  - Nobody declared it (the customer asked to pay in cash and the back office confirmed it): the collection is written now, for
 *    the artisan of the job, at the rate of the job. Without it the artisan would hold the cash and owe nothing on it.
 *  - No artisan on the job, or a payment in another currency than the ledger's: nothing is written.
 *
 * Writing it takes the artisan's ledger and then their payouts, so that a payout is not marked as paid between the moment it was
 * checked and the moment the cash is written. A payment that would bring the job above what it has to pay is refused (409), and
 * so is cash for a job that a payout already paid has taken (409): the payout would have paid the share twice. A payout that
 * is not paid yet is not in the way: it no longer matches the cash, so it is refused when it is marked as paid and made again.
 */
export async function settleCashOnConfirm(tx: Db, payment: Row, by: { userId: number | null }): Promise<CashSettlement> {
  if (String(payment.method) !== 'CASH') return 'skipped';

  const everyCollection: Row[] = await tx.cashLedgerEntry.findMany({ where: { paymentId: payment.id, type: 'COLLECTION' }, orderBy: { id: 'asc' } });

  if (everyCollection.length > 0 && (await activeCollections(tx, { paymentId: payment.id })).length > 0) return 'standing';

  const job: Row | null = await tx.intervention.findUnique({ where: { id: payment.interventionId }, select: { artisanId: true } });
  const artisanId: number | null = job?.artisanId ?? null;

  const otherCurrency = Boolean(payment.currency) && String(payment.currency) !== currencyCode();

  // No ledger to write (nobody took the cash, or it is not in the currency of the company): the cash is still not confirmed
  // above what the job has left to pay, when that can be told (money in another currency is not in the figures of the job).
  if (everyCollection.length === 0 && (artisanId === null || otherCurrency)) {
    if (!otherCurrency && exceedsWhatIsLeft(await paymentPosition(tx, payment.interventionId), payment)) {
      throw new ConflictException(CASH_OVER_WHAT_IS_LEFT);
    }

    return 'skipped';
  }

  const ledgerOf = everyCollection.length > 0 ? (everyCollection[0].artisanId as number) : (artisanId as number);

  await lockCashLedger(tx, ledgerOf);

  if (artisanId !== null) await lockPayouts(tx, artisanId);

  if (await jobIsInPaidPayout(tx, payment.interventionId)) {
    throw new ConflictException('Un payout déjà payé comprend cette mission: enregistrez cet encaissement par une correction du registre.');
  }

  const position = await paymentPosition(tx, payment.interventionId);

  if (exceedsWhatIsLeft(position, payment)) {
    throw new ConflictException(CASH_OVER_WHAT_IS_LEFT);
  }

  if (everyCollection.length > 0) return (await restoreCollectionOfPayment(tx, payment.id, by)) ? 'restored' : 'standing';

  const amount = money(payment.amount);
  const rate = await commissionRateFor(tx, payment.interventionId);

  await tx.cashLedgerEntry.create({
    data: {
      artisanId: ledgerOf,
      type: 'COLLECTION',
      interventionId: payment.interventionId,
      paymentId: payment.id,
      cashAmount: amount,
      commissionAmount: percentOf(amount, rate),
      commissionRate: rate,
      currency: currencyCode(),
      note: 'Paiement en espèces confirmé par l’administration.',
      recordedById: by.userId,
    },
  });

  return 'booked';
}
