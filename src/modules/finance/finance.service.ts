/**
 * The finance console (P2-08): what an accountant reads to reconcile a week without opening the database.
 *
 * Reading only. The actions (confirm, refund, issue a credit note, mark a payout paid, record a remittance) stay on the routes of
 * the payments, invoices, business and cash-ledger modules, which check them under their own locks; this service gives the
 * screens the lists they act from: payments waiting for the team, money received and given back in a period, invoices with their
 * credit notes, refunds that are due, and the week's totals.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { Role } from '../../../generated/prisma/client';
import { businessDateOf } from '../../common/locale/business-time';
import { currencyCode } from '../../common/locale/locale';
import { compareMoney, money, subtractMoney, sumMoney, sumMoneyOf } from '../../common/money/money';
import { PrismaService } from '../../prisma/prisma.service';
import { TypeSums, activeCollections, totalsOfSums } from '../cash-ledger/cash-ledger-ops';
import { RECEIVED_PAYMENT_STATUSES, amountToPay, paymentFigures, refundedOn } from '../payments/financials-ops';
import { FinancePaymentsExportQueryDto, FinancePaymentsQueryDto, FinanceInvoicesQueryDto, FinancePeriodQueryDto } from './dto/finance.dto';
import {
  INVOICE_LIST_SELECT,
  PAYMENT_LIST_SELECT,
  REFUNDED_STATUSES,
  UNPAID_INVOICE_STATUSES,
  awaitingFilter,
  invoiceListRow,
  invoicePeriodApplies,
  invoiceViewOf,
  invoicesWhere,
  issuedInvoicesWhere,
  paymentListRow,
  paymentPeriodApplies,
  paymentViewOf,
  paymentsCsv,
  paymentsOrder,
  paymentsWhere,
} from './finance-queries';
import { FinancePeriod, periodOf } from './finance-period';
import type { DayTotal, FinancePage, FinanceSummary, InvoiceListRow, MethodTotal, PaymentListRow, RefundDueRow, RefundsDue } from './finance.types';

type Row = Record<string, any>;

const FINANCE_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** The most rows one export holds: a spreadsheet of more is a period to cut, not a file to open. */
export const EXPORT_LIMIT = 10_000;

/** The most rows one total is built from in memory. */
export const SUMMARY_LIMIT = 50_000;

const CSV_TYPE = 'text/csv; charset=utf-8';

/** The page asked for: 1-based, 20 rows unless the caller says less or more (never more than 100). */
export function pageOf(query: { page?: unknown; limit?: unknown }): { page: number; limit: number } {
  const page = Math.trunc(Number(query?.page));
  const limit = Math.trunc(Number(query?.limit));

  return {
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

/**
 * A total is built from at most SUMMARY_LIMIT rows. Past it the caller is told what to do: a shorter period when the rows are those
 * of the period, and that the figure cannot be given when they are not (what waits, whatever the date, has no period to cut).
 */
export function tooMany(rows: unknown[], what: string, ofThePeriod = true): void {
  if (rows.length <= SUMMARY_LIMIT) return;

  // "Trop de paiements", "Trop d’avoirs"
  const tooManyOf = /^[aeiouyàâéèêëîïôù]/i.test(what) ? `Trop d’${what}` : `Trop de ${what}`;

  throw new BadRequestException(
    ofThePeriod
      ? `${tooManyOf} pour un résumé (plus de ${SUMMARY_LIMIT}): choisissez une période plus courte.`
      : `${tooManyOf} pour un résumé (plus de ${SUMMARY_LIMIT}): ce chiffre ne peut pas être calculé ici, prévenez l’équipe technique.`,
  );
}

/** Totals by method, in the order of the method names. */
function byMethod(rows: Row[]): MethodTotal[] {
  const groups = new Map<string, MethodTotal>();

  for (const row of rows) {
    const method = String(row.method);
    const group = groups.get(method) ?? { method, count: 0, amount: 0 };

    group.count += 1;
    group.amount = sumMoney(group.amount, row.amount as any);
    groups.set(method, group);
  }

  return [...groups.values()].sort((a, b) => a.method.localeCompare(b.method));
}

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** The queries are written with statuses and filters as plain texts (`Row`), as the rest of the money code does: the enums are checked by the schema, the tests and the database. */
  private get db(): any {
    return this.prisma;
  }

  private assertFinance(role: Role) {
    if (!FINANCE_ROLES.includes(role)) throw new ForbiddenException('Réservé à la comptabilité et aux administrateurs.');
  }

  // ---------------------------------------------------------------------------------------------------------------- the week

  /** The totals of a period (the last seven days unless the caller names one), and the things that wait whatever the period. */
  async summary(role: Role, query: FinancePeriodQueryDto = {}, now: Date = new Date()): Promise<FinanceSummary> {
    this.assertFinance(role);

    const period = periodOf(query.from, query.to, now);
    const currency = currencyCode();
    const window = { gte: period.start, lt: period.end };

    const awaitingWhere = { AND: [awaitingFilter(), { currency }] };
    const issuedWhere = issuedInvoicesWhere(currency, window);

    const [awaitingGroups, oldest, receivedRows, refundedRows, issued, notes, unpaid, due, cash, openPayouts, paidPayouts] = await Promise.all([
      this.db.payment.groupBy({ by: ['method'], where: awaitingWhere, _count: { _all: true }, _sum: { amount: true } }),
      this.db.payment.findFirst({ where: awaitingWhere, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }),
      this.db.payment.findMany({
        where: { status: { in: [...RECEIVED_PAYMENT_STATUSES] }, currency, confirmedAt: window },
        select: { method: true, amount: true, confirmedAt: true },
        take: SUMMARY_LIMIT + 1,
      }),
      this.db.payment.findMany({
        where: { status: { in: [...REFUNDED_STATUSES] }, currency, refundedAt: window },
        select: { method: true, amount: true, amountRefunded: true, status: true, refundedAt: true },
        take: SUMMARY_LIMIT + 1,
      }),
      this.db.invoice.aggregate({ where: issuedWhere, _count: { _all: true }, _sum: { amountTTC: true, stampDuty: true } }),
      this.db.creditNote.aggregate({ where: { currency, issuedAt: window }, _count: { _all: true }, _sum: { amountTTC: true, stampDuty: true } }),
      this.unpaidInvoices(),
      this.computeRefundsDue(),
      this.db.cashLedgerEntry.groupBy({ by: ['artisanId', 'type'], _sum: { cashAmount: true, commissionAmount: true } }),
      this.db.artisanPayout.aggregate({ where: { currency, status: { in: ['PENDING', 'READY'] } }, _count: { _all: true }, _sum: { netAmount: true } }),
      this.db.artisanPayout.aggregate({ where: { currency, status: 'PAID', paidAt: window }, _count: { _all: true }, _sum: { netAmount: true } }),
    ]);

    tooMany(receivedRows, 'paiements reçus');
    tooMany(refundedRows, 'remboursements');

    const awaiting = {
      count: awaitingGroups.reduce((sum: number, group: Row) => sum + Number(group._count?._all ?? 0), 0),
      amount: sumMoneyOf(awaitingGroups.map((group: Row) => group._sum?.amount)),
      oldestAt: (oldest?.requestedAt ?? null) as Date | null,
      byMethod: awaitingGroups
        .map((group: Row) => ({ method: String(group.method), count: Number(group._count?._all ?? 0), amount: money(group._sum?.amount) }))
        .sort((a: MethodTotal, b: MethodTotal) => a.method.localeCompare(b.method)),
    };

    const days = new Map<string, DayTotal>(period.days.map((day) => [day, { day, received: 0, refunded: 0, count: 0 }]));

    for (const row of receivedRows as Row[]) {
      const day = days.get(businessDateOf(row.confirmedAt));

      if (!day) continue;

      day.received = sumMoney(day.received, row.amount);
      day.count += 1;
    }

    const refundedAmounts = (refundedRows as Row[]).map((row) => ({ at: row.refundedAt as Date, amount: refundedOn(row) }));

    for (const row of refundedAmounts) {
      const day = days.get(businessDateOf(row.at));

      if (day) day.refunded = sumMoney(day.refunded, row.amount);
    }

    const received = { count: receivedRows.length, amount: sumMoneyOf((receivedRows as Row[]).map((row) => row.amount)), byMethod: byMethod(receivedRows) };
    const refunded = { count: refundedAmounts.length, amount: sumMoneyOf(refundedAmounts.map((row) => row.amount)) };

    const owing = cashByArtisan(cash as Row[]).filter((totals) => compareMoney(totals.balance, 0) > 0);

    return {
      currency,
      period: { from: period.from, to: period.to, days: period.days.length },
      awaiting,
      received,
      refunded,
      net: subtractMoney(received.amount, refunded.amount),
      days: [...days.values()],
      invoices: {
        issued: { count: Number(issued._count?._all ?? 0), total: sumMoney(issued._sum?.amountTTC, issued._sum?.stampDuty) },
        creditNotes: { count: Number(notes._count?._all ?? 0), total: sumMoney(notes._sum?.amountTTC, notes._sum?.stampDuty) },
        unpaid,
      },
      refundsDue: { count: due.length, amount: sumMoneyOf(due.map((row) => row.due)) },
      cash: {
        artisansOwing: owing.length,
        commissionOwed: sumMoneyOf(owing.map((totals) => totals.balance)),
        cashCollected: sumMoneyOf(cashByArtisan(cash as Row[]).map((totals) => totals.cashCollected)),
      },
      payouts: {
        open: { count: Number(openPayouts._count?._all ?? 0), net: money(openPayouts._sum?.netAmount) },
        paid: { count: Number(paidPayouts._count?._all ?? 0), net: money(paidPayouts._sum?.netAmount) },
      },
    };
  }

  /** What the job's payments hold (received less given back), for each of these jobs. */
  private async keptByJob(jobIds: number[]): Promise<Map<number, number>> {
    const kept = new Map<number, number>();

    if (jobIds.length === 0) return kept;

    const payments: Row[] = await this.db.payment.findMany({
      where: { interventionId: { in: jobIds }, status: { in: [...RECEIVED_PAYMENT_STATUSES] } },
      select: { interventionId: true, status: true, amount: true, amountRefunded: true, currency: true },
    });
    const byJob = new Map<number, Row[]>();

    for (const payment of payments) byJob.set(payment.interventionId, [...(byJob.get(payment.interventionId) ?? []), payment]);
    for (const [jobId, list] of byJob) kept.set(jobId, paymentFigures(list).kept);

    return kept;
  }

  /**
   * Invoices out and not paid, and what is left to pay on them (an invoice in another currency than the company's is counted, not
   * added up). Every unpaid invoice unless a `where` narrows them (the filter of the "unpaid" tab).
   */
  private async unpaidInvoices(where: Row = { status: { in: [...UNPAID_INVOICE_STATUSES] } }): Promise<{ count: number; left: number }> {
    const invoices: Row[] = await this.db.invoice.findMany({
      where,
      select: { id: true, interventionId: true, currency: true, amountTTC: true, creditedAmount: true, stampDuty: true },
      take: SUMMARY_LIMIT + 1,
    });

    tooMany(invoices, 'factures impayées', false);

    const kept = await this.keptByJob([...new Set(invoices.map((invoice) => invoice.interventionId as number))]);
    const company = currencyCode();
    const left = invoices
      .filter((invoice) => !invoice.currency || String(invoice.currency) === company)
      .map((invoice) => Math.max(subtractMoney(amountToPay(invoice), kept.get(invoice.interventionId) ?? 0), 0));

    return { count: invoices.length, left: sumMoneyOf(left) };
  }

  // ---------------------------------------------------------------------------------------------------------------- payments

  async listPayments(role: Role, query: FinancePaymentsQueryDto = {}, now: Date = new Date()): Promise<FinancePage<PaymentListRow>> {
    this.assertFinance(role);

    const period = periodOf(query.from, query.to, now);
    const view = paymentViewOf(query.view);
    const where = paymentsWhere(query, period);
    const { page, limit } = pageOf(query);

    const [total, amount, rows] = await Promise.all([
      this.db.payment.count({ where }),
      this.paymentsAmount(view, where),
      this.db.payment.findMany({ where, select: PAYMENT_LIST_SELECT, orderBy: paymentsOrder(view, query.sort), skip: (page - 1) * limit, take: limit }),
    ]);

    const declared = await this.declaredCash((rows as Row[]).filter((row) => String(row.method) === 'CASH').map((row) => row.id as number));

    return {
      items: (rows as Row[]).map((row) => paymentListRow(row, declared.get(row.id) ?? null)),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
      amount,
      period: { from: period.from, to: period.to, explicit: period.explicit, applied: paymentPeriodApplies(view, period) },
    };
  }

  /**
   * The sum a payments tab is about, in the currency of the company (dinars and euros do not add up; the list shows every currency):
   * what is asked in "awaiting", what came in in "received", what went back in "refunded" (all of the amount on a payment marked as
   * refunded, as the summary counts it). The "all" tab has no sum: payments that failed, were cancelled or went back do not add up.
   */
  private async paymentsAmount(view: ReturnType<typeof paymentViewOf>, where: Row): Promise<number | null> {
    if (view === 'all') return null;

    const inCurrency = { AND: [where, { currency: currencyCode() }] };

    if (view !== 'refunded') {
      const sum = await this.db.payment.aggregate({ where: inCurrency, _sum: { amount: true } });

      return money(sum._sum?.amount);
    }

    const groups: Row[] = await this.db.payment.groupBy({ by: ['status'], where: inCurrency, _sum: { amount: true, amountRefunded: true } });

    return sumMoneyOf(groups.map((group) => (String(group.status) === 'REFUNDED' ? group._sum?.amount : group._sum?.amountRefunded)));
  }

  /** The cash that artisans said they took for each of these payments and that nobody has taken back: the team confirms it or not. */
  private async declaredCash(paymentIds: number[]): Promise<Map<number, Row>> {
    const declared = new Map<number, Row>();

    if (paymentIds.length === 0) return declared;

    for (const entry of await activeCollections(this.prisma, { paymentId: { in: paymentIds } })) declared.set(entry.paymentId, entry);

    return declared;
  }

  /** The payments of a filter as a file for a spreadsheet, oldest first, as one reads a period. */
  async exportPayments(role: Role, query: FinancePaymentsExportQueryDto = {}, now: Date = new Date()): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    this.assertFinance(role);

    const period = periodOf(query.from, query.to, now);
    const view = paymentViewOf(query.view);
    const where = paymentsWhere(query, period);
    const total = await this.db.payment.count({ where });

    if (total > EXPORT_LIMIT) throw new BadRequestException(`Trop de lignes pour un fichier (${total}, au plus ${EXPORT_LIMIT}): choisissez une période plus courte.`);

    const rows: Row[] = await this.db.payment.findMany({ where, select: PAYMENT_LIST_SELECT, orderBy: paymentsOrder(view, 'oldest'), take: EXPORT_LIMIT });

    return {
      filename: paymentPeriodApplies(view, period) ? `paiements-${view}-${period.from}_${period.to}.csv` : `paiements-${view}.csv`,
      contentType: CSV_TYPE,
      buffer: Buffer.from(paymentsCsv(rows.map((row) => paymentListRow(row, null))), 'utf8'),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------- invoices

  async listInvoices(role: Role, query: FinanceInvoicesQueryDto = {}, now: Date = new Date()): Promise<FinancePage<InvoiceListRow>> {
    this.assertFinance(role);

    const period = periodOf(query.from, query.to, now);
    const view = invoiceViewOf(query.view);
    const where = invoicesWhere(query, period);
    const { page, limit } = pageOf(query);

    const [total, amount, rows] = await Promise.all([
      this.db.invoice.count({ where }),
      this.invoicesAmount(view, where, period),
      this.db.invoice.findMany({ where, select: INVOICE_LIST_SELECT, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
    ]);

    const kept = await this.keptByJob([...new Set((rows as Row[]).map((row) => row.interventionId as number))]);

    return {
      items: (rows as Row[]).map((row) => invoiceListRow(row, kept.get(row.interventionId) ?? 0)),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
      amount,
      period: { from: period.from, to: period.to, explicit: period.explicit, applied: invoicePeriodApplies(view, period) },
    };
  }

  /**
   * The sum an invoices tab is about, in the currency of the company: what is left to pay in "unpaid" (the summary's figure, after
   * what the jobs already hold); what the credit notes took back in "credited" (the summary's figure: an invoice that a credit
   * note closes is cancelled, and asks nothing any more, which would show 0); in the other tab what the invoices ask less their
   * credit notes, the cancelled ones left out.
   */
  private async invoicesAmount(view: ReturnType<typeof invoiceViewOf>, where: Row, period: FinancePeriod): Promise<number> {
    if (view === 'unpaid') return (await this.unpaidInvoices(where)).left;
    if (view === 'credited') return this.creditedAmount(where, period);

    // A cancelled invoice asks nothing; only the company's currency.
    const sum = await this.db.invoice.aggregate({
      where: { AND: [where, { status: { not: 'CANCELLED' } }, { currency: currencyCode() }] },
      _sum: { amountTTC: true, stampDuty: true, creditedAmount: true },
    });

    return subtractMoney(sumMoney(sum._sum?.amountTTC, sum._sum?.stampDuty), sum._sum?.creditedAmount);
  }

  /**
   * What the credit notes of the invoices of the "credited" tab took back, stamp duty included: the ones of the days chosen when a
   * period was asked (as the summary counts them), all of them otherwise. The credit notes of an invoice come with it, so that a
   * filter on the invoice (status, search) narrows the sum as it narrows the list.
   */
  private async creditedAmount(where: Row, period: FinancePeriod): Promise<number> {
    const currency = currencyCode();
    const invoices: Row[] = await this.db.invoice.findMany({
      where,
      select: { creditNotes: { select: { amountTTC: true, stampDuty: true, issuedAt: true, currency: true } } },
      take: SUMMARY_LIMIT + 1,
    });

    tooMany(invoices, 'factures', false);

    const inWindow = (issuedAt: Date | null) => !invoicePeriodApplies('credited', period) || (issuedAt !== null && issuedAt >= period.start && issuedAt < period.end);

    return sumMoneyOf(
      invoices.flatMap((invoice) => ((invoice.creditNotes ?? []) as Row[]).filter((note) => note.currency === currency && inWindow(note.issuedAt ?? null)).map((note) => sumMoney(note.amountTTC, note.stampDuty))),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- refunds due

  async refundsDue(role: Role): Promise<RefundsDue> {
    this.assertFinance(role);

    const items = await this.computeRefundsDue();

    return { items, total: items.length, amount: sumMoneyOf(items.map((row) => row.due)) };
  }

  /**
   * The money to give back to customers, job by job. Two reasons make a job appear (both can):
   *  - a credit note: the job holds (received less given back) more than the standing invoice asks (nothing when a credit note
   *    closed it). A job that continues on its quote after a closing credit note shows what it holds: the accountant decides,
   *    the server does not guess;
   *  - a complaint whose refund was accepted for an amount (P2-09): the amount less what has already gone back on the job (the
   *    payment refund that reaches it settles the complaint). An acceptance with no amount says nothing about how much: it is
   *    in the complaints screen, not here.
   * When both apply the job owes the larger: money that goes back answers both.
   */
  private async computeRefundsDue(): Promise<RefundDueRow[]> {
    const [notes, complaints]: Row[][] = await Promise.all([
      this.db.creditNote.findMany({
        select: { id: true, creditNoteNumber: true, interventionId: true, amountTTC: true, stampDuty: true, issuedAt: true },
        orderBy: { id: 'asc' },
        take: SUMMARY_LIMIT + 1,
      }),
      this.db.complaint.findMany({
        where: { refundDecision: 'APPROVED' },
        select: { id: true, interventionId: true, title: true, refundAmount: true, refundDecidedAt: true },
        orderBy: { id: 'asc' },
        take: SUMMARY_LIMIT + 1,
      }),
    ]);

    tooMany(notes, 'avoirs', false);
    tooMany(complaints, 'réclamations', false);

    // An acceptance that states no amount cannot be priced here.
    const promises = complaints.filter((complaint) => compareMoney(money(complaint.refundAmount), 0) > 0);

    if (notes.length === 0 && promises.length === 0) return [];

    const jobIds = [...new Set([...notes.map((note) => note.interventionId as number), ...promises.map((complaint) => complaint.interventionId as number)])];

    const [payments, invoices, jobs]: Row[][] = await Promise.all([
      this.db.payment.findMany({
        where: { interventionId: { in: jobIds } },
        select: { id: true, interventionId: true, method: true, status: true, amount: true, amountRefunded: true, currency: true, confirmedAt: true },
        orderBy: { id: 'asc' },
      }),
      this.db.invoice.findMany({ where: { interventionId: { in: jobIds }, status: { notIn: ['CANCELLED', 'DRAFT'] } }, orderBy: { id: 'asc' } }),
      this.db.intervention.findMany({ where: { id: { in: jobIds } }, select: { id: true, client: { select: { id: true, name: true, phone: true } } } }),
    ]);

    const paymentsOf = new Map<number, Row[]>();
    const live = new Map<number, Row>();
    const clients = new Map<number, Row | null>(jobs.map((job) => [job.id as number, (job.client ?? null) as Row | null]));
    const notesOf = new Map<number, Row[]>();
    const promisesOf = new Map<number, Row[]>();
    const company = currencyCode();

    for (const payment of payments) paymentsOf.set(payment.interventionId, [...(paymentsOf.get(payment.interventionId) ?? []), payment]);
    for (const invoice of invoices) live.set(invoice.interventionId, invoice);
    for (const note of notes) notesOf.set(note.interventionId, [...(notesOf.get(note.interventionId) ?? []), note]);
    for (const complaint of promises) promisesOf.set(complaint.interventionId, [...(promisesOf.get(complaint.interventionId) ?? []), complaint]);

    const rows: RefundDueRow[] = [];

    for (const jobId of jobIds) {
      const jobPayments = paymentsOf.get(jobId) ?? [];
      const standing = live.get(jobId) ?? null;
      const jobNotes = notesOf.get(jobId) ?? [];
      const jobPromises = promisesOf.get(jobId) ?? [];

      const figures = paymentFigures(jobPayments);
      const owed = standing ? amountToPay(standing) : 0;

      // A standing invoice in another currency cannot be set against the sums of the company: the accountant reads that one.
      const comparable = !(standing?.currency && String(standing.currency) !== company);
      const fromCreditNotes = jobNotes.length > 0 && comparable ? Math.max(subtractMoney(figures.kept, owed), 0) : 0;

      // Every complaint is answered by a refund that reaches its amount: the job owes what the largest of them still lacks, and never
      // more than the job still holds (a refund accepted before any payment came in cannot be given back from nothing).
      const held = Math.max(figures.kept, 0);
      const pending = jobPromises
        .map((complaint) => {
          const lacking = Math.max(subtractMoney(complaint.refundAmount, figures.refunded), 0);

          return { id: complaint.id as number, title: String(complaint.title ?? ''), accepted: money(complaint.refundAmount), remaining: compareMoney(lacking, held) > 0 ? held : lacking, decidedAt: (complaint.refundDecidedAt ?? null) as Date | null };
        })
        .filter((complaint) => compareMoney(complaint.remaining, 0) > 0);
      const fromComplaints = pending.reduce((most, complaint) => (compareMoney(complaint.remaining, most) > 0 ? complaint.remaining : most), 0);

      const due = compareMoney(fromCreditNotes, fromComplaints) >= 0 ? fromCreditNotes : fromComplaints;

      if (compareMoney(due, 0) <= 0) continue;

      const client = clients.get(jobId) ?? null;
      // The line is as old as the oldest thing that makes the job owe: a credit note the invoice already covers owes nothing.
      const dates = [...(compareMoney(fromCreditNotes, 0) > 0 ? [jobNotes[0]?.issuedAt] : []), ...(compareMoney(fromComplaints, 0) > 0 ? pending.map((complaint) => complaint.decidedAt) : [])].filter((date): date is Date => date instanceof Date);

      rows.push({
        interventionId: jobId,
        client: client ? { id: client.id, name: client.name ?? null, phone: client.phone ?? null } : null,
        invoice: standing ? { id: standing.id, number: String(standing.invoiceNumber) } : null,
        creditNotes: jobNotes.map((note) => ({ id: note.id, number: String(note.creditNoteNumber), amount: sumMoney(note.amountTTC, note.stampDuty), issuedAt: note.issuedAt ?? null })),
        complaints: pending.map((complaint) => ({ id: complaint.id, title: complaint.title, accepted: complaint.accepted, remaining: complaint.remaining, decidedAt: complaint.decidedAt })),
        kept: figures.kept,
        owed,
        fromCreditNotes,
        fromComplaints,
        due,
        payments: jobPayments
          .filter((payment) => RECEIVED_PAYMENT_STATUSES.includes(String(payment.status)) && (!payment.currency || String(payment.currency) === company))
          .map((payment) => ({ id: payment.id, method: String(payment.method), status: String(payment.status), amount: money(payment.amount), refundable: Math.max(subtractMoney(payment.amount, refundedOn(payment)), 0), confirmedAt: payment.confirmedAt ?? null }))
          .filter((payment) => compareMoney(payment.refundable, 0) > 0),
        since: dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null,
      });
    }

    return rows.sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0) || a.interventionId - b.interventionId);
  }
}

/** The figures of each artisan from the sums by artisan and type (what one query of the ledger answers). */
function cashByArtisan(groups: Row[]) {
  const byArtisan = new Map<number, TypeSums>();

  for (const group of groups) byArtisan.set(group.artisanId, [...(byArtisan.get(group.artisanId) ?? []), group]);

  return [...byArtisan.values()].map((sums) => totalsOfSums(sums));
}
