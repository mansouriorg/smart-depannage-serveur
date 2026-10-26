/**
 * What the finance console asks of the database (P2-08), as functions that return a `where`, an order, or a row of an answer, so
 * that the rules (which statuses a view holds, which date a view is about, what a search looks at) are read and tested apart from
 * the service that runs them.
 */
import { localMoment } from '../../common/availability/weekly-schedule';
import { currencyCode } from '../../common/locale/locale';
import { money, moneyOrNull, subtractMoney } from '../../common/money/money';
import { getBusinessTimeZone } from '../../config/env';
import { NOTHING, idOf, likeLiteral } from '../../common/search/staff-search';
import { phoneSearch } from '../admin/intervention-queue';
import { RECEIVED_PAYMENT_STATUSES, amountToPay, refundedOn } from '../payments/financials-ops';
import { FinancePeriod } from './finance-period';

/** An id the database can hold: a number past it is not a job, and would be a database error. */
const MAX_ROW_ID = 2_147_483_647;

type Row = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------- payments

/** The tabs of the payments list. */
export const PAYMENT_VIEWS = ['all', 'awaiting', 'received', 'refunded'] as const;
export type PaymentView = (typeof PAYMENT_VIEWS)[number];

export const PAYMENT_SORTS = ['newest', 'oldest'] as const;

/** The payments the team enters by hand and confirms: no provider says whether the money came. */
export const MANUAL_METHODS: readonly string[] = ['CASH', 'BANK_TRANSFER'];

/**
 * A payment that is asked for and not decided: the team confirms it, fails it or cancels it. Cash and transfers wait as
 * AWAITING_CONFIRMATION (or as PENDING, when they were asked for before anyone said the money was handed over). An online payment
 * that is PENDING waits for the provider (or is a placeholder that never reached it): the server settles it by itself, from the
 * provider's own answer (P2-10), so there is nothing for the team to confirm, and it is not in the queue, in the count of the summary
 * or in the oldest date. It stays in the list of all payments. A card payment the server cannot count by itself (money that came
 * late, or for another amount) is AWAITING_CONFIRMATION with a note, and is in the queue.
 */
export function awaitingFilter(): Row {
  return { OR: [{ status: 'AWAITING_CONFIRMATION' }, { status: 'PENDING', method: { in: [...MANUAL_METHODS] } }] };
}

/** Money that came in (and may have gone back in part or in full): the statuses the figures of a job count. */
export const RECEIVED_STATUSES: readonly string[] = RECEIVED_PAYMENT_STATUSES;

/** Money that went back in part or in full. */
export const REFUNDED_STATUSES: readonly string[] = ['PARTIALLY_REFUNDED', 'REFUNDED'];

const VIEW_STATUSES: Record<PaymentView, readonly string[] | null> = {
  all: null,
  awaiting: null, // by `awaitingFilter`: a status and a method
  received: RECEIVED_STATUSES,
  refunded: REFUNDED_STATUSES,
};

export function paymentViewOf(value: unknown): PaymentView {
  return typeof value === 'string' && (PAYMENT_VIEWS as readonly string[]).includes(value) ? (value as PaymentView) : 'all';
}

/** The date a view is about: when the payment was asked for, when it was confirmed, when it was given back. */
export function paymentDateField(view: PaymentView): 'requestedAt' | 'confirmedAt' | 'refundedAt' {
  if (view === 'received') return 'confirmedAt';
  if (view === 'refunded') return 'refundedAt';

  return 'requestedAt';
}

// The escape of "%", "_" and the backslash in a LIKE is shared with the other searches of the back office.
export { likeLiteral };

const insensitive = (text: string) => ({ contains: likeLiteral(text), mode: 'insensitive' as const });

/**
 * The words typed in a search box, cut to what a search reads; null when there is nothing to look for. A NUL byte is dropped
 * (PostgreSQL refuses it in a text, and the request would end in a 500).
 */
export function searchText(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.replace(/\u0000/g, '').trim().slice(0, 100).trim() : '';

  return text === '' ? null : text;
}

/**
 * The conditions for a phone number typed in a search box: the number as typed, its digits, the 8 local digits, and the
 * "22 123 456" spelling (a phone is kept as the person typed it, so "22123456" would not find it otherwise), and the account's
 * own key, which has one spelling for every way of writing the number. Text that is not a phone number is looked for as it is.
 */
function phoneConditions(text: string, onPhone: (condition: Row) => Row, onKey: (condition: Row) => Row): Row[] {
  const phone = phoneSearch(text);

  if (!phone) return [onPhone({ contains: likeLiteral(text) })];

  return [...phone.variants.map((variant) => onPhone({ contains: variant })), onKey({ contains: phone.digits })];
}

/** "12" or "#12": a number that can be a row of the database. */
function asRowId(text: string): number | null {
  const match = /^#?(\d{1,10})$/.exec(text);

  if (!match) return null;

  const id = Number(match[1]);

  return id >= 1 && id <= MAX_ROW_ID ? id : null;
}

/** A payment is found by its job number or its own number, its reference or receipt, the invoice it pays, or its customer. */
function paymentSearch(text: string): Row[] {
  const id = asRowId(text);

  return [
    ...(id === null ? [] : [{ interventionId: id }, { id }]),
    { reference: insensitive(text) },
    { receiptNumber: insensitive(text) },
    { invoice: { invoiceNumber: insensitive(text) } },
    { intervention: { client: { name: insensitive(text) } } },
    ...phoneConditions(
      text,
      (condition) => ({ intervention: { client: { phone: condition } } }),
      (condition) => ({ intervention: { client: { phoneKey: condition } } }),
    ),
  ];
}

export interface PaymentsFilter {
  view?: unknown;
  status?: unknown;
  method?: unknown;
  /** Only the payments of this job. A number that is no job (0, text, past the last number the database holds) shows no payment. */
  interventionId?: unknown;
  search?: unknown;
}

/**
 * Whether the period limits a view. What waits for the team (the "awaiting" tab) is shown whatever its date, as the summary
 * counts it: a transfer that has waited three weeks does not leave the list because last week was chosen.
 */
export function paymentPeriodApplies(view: PaymentView, period: FinancePeriod): boolean {
  return period.explicit && view !== 'awaiting';
}

/** The `where` of the payments list: the view's statuses, the filters, the period on the view's date, the search. */
export function paymentsWhere(filter: PaymentsFilter, period: FinancePeriod): Row {
  const view = paymentViewOf(filter.view);
  const and: Row[] = [];
  const statuses = VIEW_STATUSES[view];

  if (view === 'awaiting') and.push(awaitingFilter());
  if (statuses) and.push({ status: { in: [...statuses] } });
  if (filter.status) and.push({ status: filter.status });
  if (filter.method) and.push({ method: filter.method });
  if (filter.interventionId !== undefined && filter.interventionId !== null && filter.interventionId !== '') and.push(idOf(filter.interventionId) === null ? NOTHING : { interventionId: idOf(filter.interventionId) });
  if (paymentPeriodApplies(view, period)) and.push({ [paymentDateField(view)]: { gte: period.start, lt: period.end } });

  const text = searchText(filter.search);

  if (text) and.push({ OR: paymentSearch(text) });

  return and.length > 0 ? { AND: and } : {};
}

/** Newest first by the date of the view; the people waiting longest come first in the "awaiting" tab unless the caller says otherwise. */
export function paymentsOrder(view: PaymentView, sort: unknown): Row[] {
  const oldestFirst = sort === 'oldest' || (sort !== 'newest' && view === 'awaiting');
  const direction = oldestFirst ? 'asc' : 'desc';

  return [{ [paymentDateField(view)]: direction }, { id: direction }];
}

/** The columns of a payment that the list reads (not the whole row: no customer note, no pay page, no idempotency key). The team may read the provider's number: it is how a card payment is found at the provider. */
export const PAYMENT_LIST_SELECT = {
  id: true,
  interventionId: true,
  invoiceId: true,
  method: true,
  provider: true,
  status: true,
  amount: true,
  amountRefunded: true,
  currency: true,
  reference: true,
  receiptNumber: true,
  adminNote: true,
  providerPaymentId: true,
  expiresAt: true,
  failureReason: true,
  cancelReason: true,
  refundReason: true,
  requestedAt: true,
  confirmedAt: true,
  failedAt: true,
  refundedAt: true,
  cancelledAt: true,
  invoice: { select: { id: true, invoiceNumber: true, status: true } },
  intervention: {
    select: {
      id: true,
      status: true,
      serviceType: true,
      client: { select: { id: true, name: true, phone: true } },
      artisan: { select: { id: true, name: true } },
    },
  },
} as const;

export interface PaymentListRow {
  id: number;
  interventionId: number;
  method: string;
  provider: string;
  status: string;
  amount: number;
  amountRefunded: number;
  /** What can still be given back on this payment (its amount less what went back); 0 when it is not money received. */
  refundable: number;
  currency: string;
  reference: string | null;
  receiptNumber: string | null;
  adminNote: string | null;
  /** The number the card provider gave to the payment (P2-10); null for cash, a transfer, and a card request the provider never took. */
  providerReference: string | null;
  /** When the time to pay a card payment ends; null when it has none. */
  expiresAt: Date | null;
  /** Why it failed, was cancelled or was refunded, whichever applies to its status. */
  reason: string | null;
  requestedAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  cancelledAt: Date | null;
  invoice: { id: number; number: string; status: string } | null;
  job: { id: number; status: string; serviceType: string | null };
  client: { id: number; name: string | null; phone: string | null } | null;
  artisan: { id: number; name: string | null } | null;
  /** Cash that the artisan said they took for this payment (and nobody took back): the team confirms it or not. */
  declared: { artisanId: number; amount: number } | null;
}

/** What the screen is given for a payment, with the amounts as numbers. `declared` is the artisan's cash line for it, if one stands. */
export function paymentListRow(payment: Row, declared: Row | null): PaymentListRow {
  const amount = money(payment.amount);
  // What went back, as the summary counts it (all of the amount on a payment marked as refunded).
  const refunded = refundedOn(payment);
  const received = RECEIVED_STATUSES.includes(String(payment.status));
  const status = String(payment.status);
  const reason = status === 'FAILED' ? payment.failureReason : status === 'CANCELLED' ? payment.cancelReason : REFUNDED_STATUSES.includes(status) ? payment.refundReason : null;

  return {
    id: payment.id,
    interventionId: payment.interventionId,
    method: String(payment.method),
    provider: String(payment.provider),
    status,
    amount,
    amountRefunded: refunded,
    refundable: received && status !== 'REFUNDED' ? Math.max(subtractMoney(amount, refunded), 0) : 0,
    currency: String(payment.currency ?? 'TND'),
    reference: payment.reference ?? null,
    receiptNumber: payment.receiptNumber ?? null,
    adminNote: payment.adminNote ?? null,
    providerReference: payment.providerPaymentId ?? null,
    expiresAt: payment.expiresAt ?? null,
    reason: reason ?? null,
    requestedAt: payment.requestedAt ?? null,
    confirmedAt: payment.confirmedAt ?? null,
    failedAt: payment.failedAt ?? null,
    refundedAt: payment.refundedAt ?? null,
    cancelledAt: payment.cancelledAt ?? null,
    invoice: payment.invoice ? { id: payment.invoice.id, number: payment.invoice.invoiceNumber, status: String(payment.invoice.status) } : null,
    job: { id: payment.intervention?.id ?? payment.interventionId, status: String(payment.intervention?.status ?? ''), serviceType: payment.intervention?.serviceType ? String(payment.intervention.serviceType) : null },
    client: payment.intervention?.client ? { id: payment.intervention.client.id, name: payment.intervention.client.name ?? null, phone: payment.intervention.client.phone ?? null } : null,
    artisan: payment.intervention?.artisan ? { id: payment.intervention.artisan.id, name: payment.intervention.artisan.name ?? null } : null,
    declared: declared ? { artisanId: declared.artisanId, amount: money(declared.cashAmount) } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------- invoices

export const INVOICE_VIEWS = ['all', 'unpaid', 'credited'] as const;
export type InvoiceView = (typeof INVOICE_VIEWS)[number];

export function invoiceViewOf(value: unknown): InvoiceView {
  return typeof value === 'string' && (INVOICE_VIEWS as readonly string[]).includes(value) ? (value as InvoiceView) : 'all';
}

/** An invoice that asks for money: issued or sent, and not yet covered (a covered one is PAID, a cancelled one is nobody's). */
export const UNPAID_INVOICE_STATUSES = ['ISSUED', 'SENT'] as const;

/** An invoice that is a document of the customer: not a draft (a draft has no number the customer has seen, and is nobody's yet). */
const NOT_DRAFT = { status: { not: 'DRAFT' } };

function invoiceSearch(text: string): Row[] {
  const id = asRowId(text);

  return [
    ...(id === null ? [] : [{ interventionId: id }, { id }]),
    { invoiceNumber: insensitive(text) },
    { clientName: insensitive(text) },
    ...phoneConditions(
      text,
      (condition) => ({ clientPhone: condition }),
      (condition) => ({ intervention: { client: { phoneKey: condition } } }),
    ),
    { creditNotes: { some: { creditNoteNumber: insensitive(text) } } },
  ];
}

export interface InvoicesFilter {
  view?: unknown;
  status?: unknown;
  search?: unknown;
}

/** Whether the period limits a view. The invoices that ask for money ("unpaid") are shown whatever their date, as the summary counts them. */
export function invoicePeriodApplies(view: InvoiceView, period: FinancePeriod): boolean {
  return period.explicit && view !== 'unpaid';
}

/**
 * The invoices that count as issued in a period, as the summary adds them up: not a draft, and not one cancelled with nothing
 * credited (it asks nothing and nothing offsets it). An invoice closed by a credit note is issued, and its credit note is
 * counted beside it, so that issued less credit notes is what the customers were asked for.
 */
export function issuedInvoicesWhere(currency: string, window: { gte: Date; lt: Date }): Row {
  return { currency, issuedAt: window, status: { not: 'DRAFT' }, OR: [{ status: { not: 'CANCELLED' } }, { creditedAmount: { gt: 0 } }] };
}

/**
 * The `where` of the invoices list: the ones that were issued, the view, the status, the period, the search. The period is on the
 * date of issue, except in the "credited" tab, where it is on the date of the credit note (as the summary counts the credit notes).
 */
export function invoicesWhere(filter: InvoicesFilter, period: FinancePeriod): Row {
  const view = invoiceViewOf(filter.view);
  const and: Row[] = [NOT_DRAFT];
  const window = { gte: period.start, lt: period.end };

  if (view === 'unpaid') and.push({ status: { in: [...UNPAID_INVOICE_STATUSES] } });
  if (view === 'credited') and.push(invoicePeriodApplies(view, period) ? { creditNotes: { some: { issuedAt: window } } } : { creditedAmount: { gt: 0 } });
  if (filter.status) and.push({ status: filter.status });
  if (invoicePeriodApplies(view, period) && view !== 'credited') and.push({ issuedAt: window });

  const text = searchText(filter.search);

  if (text) and.push({ OR: invoiceSearch(text) });

  return { AND: and };
}

export const INVOICE_LIST_SELECT = {
  id: true,
  interventionId: true,
  invoiceNumber: true,
  status: true,
  paymentStatus: true,
  currency: true,
  amountHT: true,
  taxRate: true,
  taxAmount: true,
  amountTTC: true,
  stampDuty: true,
  creditedAmount: true,
  clientName: true,
  clientPhone: true,
  mentionsConfirmed: true,
  cancelReason: true,
  issuedAt: true,
  sentAt: true,
  paidAt: true,
  cancelledAt: true,
  creditNotes: { select: { id: true, creditNoteNumber: true, amountTTC: true, stampDuty: true, reason: true, issuedAt: true }, orderBy: { id: 'asc' as const } },
} as const;

export interface InvoiceListRow {
  id: number;
  interventionId: number;
  number: string;
  status: string;
  paymentStatus: string;
  currency: string;
  amountHT: number;
  taxAmount: number;
  amountTTC: number;
  stampDuty: number;
  /** What the credit notes took off (the total and the stamp duty they took back). */
  credited: number;
  /** What the customer has to pay on it: the total, plus the stamp duty, less what was credited. */
  toPay: number;
  /** What the job holds from the customer, in the company's currency: received and not given back. */
  received: number;
  /** What is still to be paid on it (`toPay` less `received`, never below 0); 0 for a cancelled invoice; null in another currency than the company's. */
  left: number | null;
  clientName: string | null;
  clientPhone: string | null;
  mentionsConfirmed: boolean;
  cancelReason: string | null;
  issuedAt: Date | null;
  sentAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  creditNotes: Array<{ id: number; number: string; amountTTC: number; stampDuty: number; reason: string; issuedAt: Date | null }>;
}

/** What the screen is given for an invoice, with the amounts as numbers; `kept` is what the job's payments hold (received less given back). */
export function invoiceListRow(invoice: Row, kept: number): InvoiceListRow {
  const cancelled = String(invoice.status) === 'CANCELLED';
  // A cancelled invoice asks nothing (one closed by a credit note already shows 0; one cancelled by the back office shows 0 here).
  const toPay = cancelled ? 0 : amountToPay(invoice);
  const foreign = Boolean(invoice.currency) && String(invoice.currency) !== currencyCode();

  return {
    id: invoice.id,
    interventionId: invoice.interventionId,
    number: String(invoice.invoiceNumber),
    status: String(invoice.status),
    paymentStatus: String(invoice.paymentStatus),
    currency: String(invoice.currency ?? currencyCode()),
    amountHT: money(invoice.amountHT),
    taxAmount: money(invoice.taxAmount),
    amountTTC: money(invoice.amountTTC),
    stampDuty: money(invoice.stampDuty),
    credited: money(invoice.creditedAmount),
    toPay,
    received: kept,
    left: cancelled ? 0 : foreign ? null : Math.max(subtractMoney(toPay, kept), 0),
    clientName: invoice.clientName ?? null,
    clientPhone: invoice.clientPhone ?? null,
    mentionsConfirmed: Boolean(invoice.mentionsConfirmed),
    cancelReason: invoice.cancelReason ?? null,
    issuedAt: invoice.issuedAt ?? null,
    sentAt: invoice.sentAt ?? null,
    paidAt: invoice.paidAt ?? null,
    cancelledAt: invoice.cancelledAt ?? null,
    creditNotes: (invoice.creditNotes ?? []).map((note: Row) => ({
      id: note.id,
      number: String(note.creditNoteNumber),
      amountTTC: money(note.amountTTC),
      stampDuty: money(note.stampDuty),
      reason: String(note.reason ?? ''),
      issuedAt: note.issuedAt ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------- the CSV

const SEPARATOR = ';';

/** A cell that a spreadsheet will not run as a formula: a text that starts with = + - @ (or a tab or a return) is shown as it is. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);

  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** An amount as a French spreadsheet reads it: 120,000. A number, never a text that starts with a sign (the formula guard leaves it alone). */
export function csvAmount(value: unknown): string {
  const amount = moneyOrNull(value as any);

  return amount === null ? '' : amount.toFixed(3).replace('.', ',');
}

/** "2026-10-19 09:05" on the clock of the business. */
export function csvMoment(value: unknown): string {
  if (!value) return '';

  const at = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(at.getTime())) return '';

  const local = localMoment(at, getBusinessTimeZone());

  return `${local.date} ${local.time}`;
}

const CSV_HEADERS = [
  'Paiement',
  'Mission',
  'Demandé le',
  'Confirmé le',
  'Client',
  'Téléphone',
  'Technicien',
  'Mode',
  'Statut',
  'Montant',
  'Remboursé',
  'Remboursé le',
  'Devise',
  'Référence',
  'Reçu',
  'Facture',
  'Motif',
  'Note interne',
];

/** The payments of a filter as a file for a spreadsheet: a byte-order mark, semicolons, commas in the amounts, lines ended as Windows ends them. */
export function paymentsCsv(rows: PaymentListRow[]): string {
  const lines = [CSV_HEADERS.map(csvCell).join(SEPARATOR)];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.interventionId,
        csvMoment(row.requestedAt),
        csvMoment(row.confirmedAt),
        row.client?.name ?? '',
        row.client?.phone ?? '',
        row.artisan?.name ?? '',
        row.method,
        row.status,
        csvAmount(row.amount),
        csvAmount(row.amountRefunded),
        csvMoment(row.refundedAt),
        row.currency,
        row.reference ?? '',
        row.receiptNumber ?? '',
        row.invoice?.number ?? '',
        row.reason ?? '',
        row.adminNote ?? '',
      ]
        .map((cell, index) => (index === 9 || index === 10 ? String(cell) : csvCell(cell)))
        .join(SEPARATOR),
    );
  }

  return `﻿${lines.join('\r\n')}\r\n`;
}
