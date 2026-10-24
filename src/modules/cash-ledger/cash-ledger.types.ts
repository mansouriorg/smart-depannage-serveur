/**
 * The vocabulary of the cash ledger (P2-02).
 *
 * An artisan who is paid in cash holds money that is partly the platform's: the commission on the job. The ledger is the list
 * of what was taken, what was handed over and what was corrected, one line each, and the balance is added up from the lines.
 */
import { CanonicalStatus } from '../intervention-workflow/intervention-status';

/**
 * The kinds of line. A text in the database and not an enum, so that the types shared with the apps do not change with it.
 *
 *  - COLLECTION: the artisan took cash from a customer. Adds the cash and the commission on it.
 *  - REMITTANCE: the artisan paid commission to the platform. Takes it off what they owe.
 *  - REVERSAL: takes back a whole collection (the payment it belonged to was cancelled or failed). Made by the server.
 *  - ADJUSTMENT: a figure put right by the back office, with the reason (a refund, a mistake, the balance at the start).
 */
export const LEDGER_TYPES = ['COLLECTION', 'REMITTANCE', 'REVERSAL', 'ADJUSTMENT'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** The platform's share of a job, in percent, when the job has no financials yet (the same figure as the financials form). */
export const DEFAULT_COMMISSION_RATE = 20;

/**
 * The statuses of a job in which its artisan may declare cash taken: on the spot, or after the work. Before that (a job
 * that is only assigned, or on its way) nobody pays; a job that is cancelled or in dispute takes no money. A job that is
 * paid (a first payment, an invoice sent) may still have something left to pay, so those two are allowed too: the amount that
 * is left decides, not the status.
 */
export const COLLECT_CASH_IN: readonly CanonicalStatus[] = ['ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT'];

/**
 * The words of a refusal to take cash, one place for the two routes that say it: the collection (which refuses) and the position
 * (which tells the app beforehand, so that the button is not offered when the server would say no).
 */
export const COLLECT_CASH_WORDS = {
  wrongStatus: 'Les espèces ne peuvent être encaissées qu’une fois sur place, pendant ou après le travail.',
  inPaidPayout: 'Un payout déjà payé comprend cette mission: contactez l’administration pour enregistrer cet encaissement.',
  noDocument: 'Aucun devis accepté ni facture: il n’y a pas de montant à encaisser.',
  alreadyPaid: 'Cette mission est déjà payée.',
} as const;

/** Another way of paying is open on the job and waits to be decided: `described` is what it is ("120,000 TND par virement"). */
export const openPaymentWords = (described: string) => `Un paiement de ${described} est déjà en attente pour cette mission: contactez l’administration.`;

/** A job billed in another currency than the ledger's. */
export const foreignCurrencyWords = (documentCurrency: string, ledgerCurrency: string) => `Cette mission est facturée en ${documentCurrency}, le registre est tenu en ${ledgerCurrency}.`;

/**
 * What is left to take on a job, for the artisan who holds it (P2-05). A hint for the screen: the collection checks everything
 * again under the lock when the artisan sends the amount.
 */
export interface CashPositionView {
  interventionId: number;
  currency: string;
  /** What the job has to pay: its invoice, or without one its accepted quote; null when it has neither. */
  document: 'INVOICE' | 'QUOTE' | null;
  /** The total of that document with tax; null without a document. */
  total: number | null;
  /** What was received: payments that are paid (net of refunds) and the cash that artisans declared. */
  received: number;
  /** `total - received`; null without a document. */
  remaining: number | null;
  /** The cash this artisan declared on this job and that still stands. */
  collected: number;
  /** Whether the artisan may declare cash now. */
  canCollect: boolean;
  /** Why not (the same words as the refusal), or null when they may. */
  reason: string | null;
}

/** What the figures of one artisan say. All amounts are in the currency of the company. */
export interface LedgerTotals {
  currency: string;
  /** The cash the artisan has taken from customers, net of what was taken back. */
  cashCollected: number;
  /** The commission that the cash brings to the platform, net of what was taken back or put right. */
  commissionDue: number;
  /** What the artisan has paid to the platform so far. */
  commissionRemitted: number;
  /** What the artisan still owes the platform: `commissionDue - commissionRemitted`. */
  balance: number;
}

export interface LedgerEntryView {
  id: number;
  type: LedgerType;
  interventionId: number | null;
  paymentId: number | null;
  cashAmount: number;
  commissionAmount: number;
  commissionRate: number | null;
  currency: string;
  reference: string | null;
  note: string | null;
  reversesId: number | null;
  createdAt: Date;
}
