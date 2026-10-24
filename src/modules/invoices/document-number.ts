/**
 * The numbers of the invoices and of the credit notes (P2-07): in order, without a gap, restarting at 1 each year.
 *
 *   F-2026-0001, F-2026-0002 ...   invoices
 *   AV-2026-0001 ...               credit notes (avoirs)
 *
 * A number is taken from a counter (`DocumentCounter`, one row per series and year) while holding the lock of that series
 * and year, in the transaction that writes the document. The counter is raised in that same transaction, so:
 *  - a document that fails to save (any error until the commit) undoes the counter with it, and the next document takes
 *    the number that was not used;
 *  - two documents that are written at the same time are given their numbers one after the other;
 *  - the date of the document is taken after the lock, so that the numbers follow the dates.
 * Nobody types a number: a number that was typed is how a series gets a gap or a double.
 *
 * The year is the one of the business clock (Africa/Tunis), not of the server.
 */
import { lockDocumentNumbers } from '../assignment/artisan-lock';
import { businessYearMonth } from '../../common/locale/business-time';

export type DocumentSeries = 'INVOICE' | 'CREDIT_NOTE';

export const DOCUMENT_SERIES: readonly DocumentSeries[] = ['INVOICE', 'CREDIT_NOTE'];

const PREFIX: Record<DocumentSeries, string> = { INVOICE: 'F', CREDIT_NOTE: 'AV' };

/** At least four digits: the ten thousandth document of a year is F-2026-10000, never a truncated number. */
const DIGITS = 4;

export interface DocumentNumber {
  series: DocumentSeries;
  year: number;
  /** The rank in the year, from 1. */
  sequence: number;
  /** "F-2026-0001". */
  number: string;
  /** When the number was given: the date of the document. */
  issuedAt: Date;
}

export function formatDocumentNumber(series: DocumentSeries, year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error(`document number: ${year} is not a year`);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`document number: ${sequence} is not a rank`);

  return `${PREFIX[series]}-${year}-${String(sequence).padStart(DIGITS, '0')}`;
}

/** "AV-2026-0012" -> { series: 'CREDIT_NOTE', year: 2026, sequence: 12 }; null for anything else (the numbers of before the counter, too). */
export function parseDocumentNumber(text: string | null | undefined): { series: DocumentSeries; year: number; sequence: number } | null {
  const match = /^(F|AV)-(\d{4})-(\d{4,})$/.exec(String(text ?? ''));

  if (!match) return null;

  const sequence = Number(match[3]);

  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;

  return { series: match[1] === 'F' ? 'INVOICE' : 'CREDIT_NOTE', year: Number(match[2]), sequence };
}

/** One lock per series and year (an int for pg_advisory_xact_lock): 2026 invoices -> 4052, 2026 credit notes -> 4053. */
export function lockKeyOf(series: DocumentSeries, year: number): number {
  return year * 2 + (series === 'CREDIT_NOTE' ? 1 : 0);
}

type Db = any;

/**
 * Takes the next number of a series. Call it inside the transaction that writes the document, after the lock of the job and
 * as late as possible: the lock of the series is held until that transaction commits (or rolls back, and then the number goes
 * back to the counter with it, so there is no gap), and nobody else takes a number of the series meanwhile. Never outside a
 * transaction.
 */
export async function takeDocumentNumber(tx: Db, series: DocumentSeries, now: () => Date = () => new Date()): Promise<DocumentNumber> {
  // The year is read once to know which lock to take, and again after the lock: a document that waited for the lock
  // across midnight of the new year belongs to the new year's series.
  let year = businessYearMonth(now()).year;

  await lockDocumentNumbers(tx, lockKeyOf(series, year));

  let issuedAt = now();
  const yearAfter = businessYearMonth(issuedAt).year;

  if (yearAfter !== year) {
    year = yearAfter;
    await lockDocumentNumbers(tx, lockKeyOf(series, year));
    // The date is taken again once the lock of the new year is ours: the document that held it may have been dated a moment ago, and
    // the numbers of a series follow the dates.
    issuedAt = now();
  }

  const counter = await tx.documentCounter.upsert({
    where: { series_year: { series, year } },
    create: { series, year, last: 1 },
    update: { last: { increment: 1 } },
  });

  return { series, year, sequence: counter.last, number: formatDocumentNumber(series, year, counter.last), issuedAt };
}
