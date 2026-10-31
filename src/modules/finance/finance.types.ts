/**
 * What the finance console answers (P2-08). Amounts are numbers (TND, three decimals), dates are instants; the screen turns them
 * into words with the formatters of the company.
 */
import type { InvoiceListRow, PaymentListRow } from './finance-queries';

export type { InvoiceListRow, PaymentListRow };

/**
 * A page of a list: `total` is the count of every row of the filter, `amount` the sum the tab is about (below), over every row of
 * the filter and not only this page, in the currency of the company.
 *
 *  - payments, "awaiting": what is asked; "received": what came in; "refunded": what went back; "all": null (no sum means anything
 *    over payments that failed, were cancelled, were received and went back).
 *  - invoices, "unpaid": what is left to pay after what the jobs already hold (the summary's figure); "all" and "credited": what
 *    the invoices ask, less their credit notes, the cancelled ones left out.
 */
export interface FinancePage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  amount: number | null;
  /** `explicit`: the caller named a period. `applied`: the period limited this list (the tabs of what waits are shown whatever the date). */
  period: { from: string; to: string; explicit: boolean; applied: boolean };
}

export interface MethodTotal {
  method: string;
  count: number;
  amount: number;
}

export interface DayTotal {
  /** YYYY-MM-DD, the clock of the business. */
  day: string;
  received: number;
  refunded: number;
  count: number;
}

export interface FinanceSummary {
  currency: string;
  period: { from: string; to: string; days: number };

  /** Payments asked for and not decided, whenever they were asked (a payment that waits is owed attention, not a date). */
  awaiting: { count: number; amount: number; oldestAt: Date | null; byMethod: MethodTotal[] };

  /** Money confirmed in the period (on the day of its confirmation), by method, and per day. */
  received: { count: number; amount: number; byMethod: MethodTotal[] };

  /** Money given back in the period (on the day of the last refund of a payment). */
  refunded: { count: number; amount: number };

  /** `received - refunded` of the period. */
  net: number;

  days: DayTotal[];

  invoices: {
    /** Invoices issued in the period, with what they ask (total, stamp duty included); not the cancelled ones. */
    issued: { count: number; total: number };
    /** Credit notes issued in the period, with what they take back (total, stamp duty included). */
    creditNotes: { count: number; total: number };
    /** Invoices out and not paid, whenever they were issued, and what is left to pay on them. */
    unpaid: { count: number; left: number };
  };

  /** Money to give back: credit notes were issued and the customer has paid more than is now owed, a complaint was accepted, or a cancelled job holds money. */
  refundsDue: { count: number; amount: number };

  /** Cash taken by artisans and the commission on it that they have not handed over. */
  cash: { artisansOwing: number; commissionOwed: number; cashCollected: number };

  payouts: {
    /** Payouts made and not paid, not cancelled. */
    open: { count: number; net: number };
    /** Payouts marked paid in the period. */
    paid: { count: number; net: number };
  };
}

export interface RefundDueRow {
  interventionId: number;
  client: { id: number; name: string | null; phone: string | null } | null;
  /** The invoice that stands now, if any (a credit note that closes an invoice leaves none). */
  invoice: { id: number; number: string } | null;
  creditNotes: Array<{ id: number; number: string; amount: number; issuedAt: Date | null }>;
  /** The complaints whose refund was accepted for an amount that has not all gone back (P2-09), with what each still lacks. */
  complaints: Array<{ id: number; title: string; accepted: number; remaining: number; decidedAt: Date | null }>;
  /** What the job holds: received less given back. */
  kept: number;
  /** What the customer owes now: the standing invoice's amount to pay, or 0 without one. */
  owed: number;
  /** What the credit notes leave to give back: `kept - owed` (0 for a job with no credit note). */
  fromCreditNotes: number;
  /** What the accepted refunds of complaints still lack: the largest of them (0 for a job with no accepted refund). */
  fromComplaints: number;
  /** What a cancelled job holds that the standing invoice does not ask (P3-01): all of it when nothing is asked (0 for a job that is not cancelled). */
  fromCancellation: number;
  /** When and why the job was cancelled, for a job that owes because of the cancellation (`fromCancellation` above 0); null for any other job, a cancelled one that owes nothing included. */
  cancelled: { at: Date | null; reason: string | null } | null;
  /** What to give back: the largest of the three (money that goes back answers all of them). */
  due: number;
  /** The payments the money can go back on, oldest first. */
  payments: Array<{ id: number; method: string; status: string; amount: number; refundable: number; confirmedAt: Date | null }>;
  /** The date of the first credit note, of the first acceptance of a refund or of the cancellation: the one who has waited longest comes first. */
  since: Date | null;
}

export interface RefundsDue {
  items: RefundDueRow[];
  total: number;
  amount: number;
}
