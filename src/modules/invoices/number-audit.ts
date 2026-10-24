/**
 * Whether the numbers of the invoices and of the credit notes have no gaps (P2-07): the check the ticket's "done when" asks for, as a
 * function over what is in the database (the script `scripts/invoice-numbers.ts` reads the rows and prints this).
 *
 * For each series (INVOICE, CREDIT_NOTE) and each year: the ranks that were given must be 1, 2, 3 ... n, each once; the number written
 * on the document must be the one its year and rank say; and the counter must stand at n. A document numbered before the counter
 * existed ("INV-..." with no rank) is not part of the series: it is counted and left alone.
 */
import { DOCUMENT_SERIES, DocumentSeries, formatDocumentNumber } from './document-number';

export interface NumberedDocument {
  id: number;
  number: string;
  year: number | null;
  sequence: number | null;
}

export interface CounterRow {
  series: string;
  year: number;
  last: number;
}

export interface SeriesYearReport {
  series: DocumentSeries;
  year: number;
  count: number;
  /** The highest rank given. */
  highest: number;
  /** Ranks between 1 and the highest that no document has. */
  missing: number[];
  /** Ranks that two documents have. */
  duplicated: number[];
  /** Documents whose written number is not the one their year and rank say. */
  misnumbered: Array<{ id: number; number: string; expected: string }>;
  /** The counter of the series for that year (null: no counter row). */
  counter: number | null;
  /** The counter is not at the highest rank: the next number would be a duplicate (below) or would leave a gap (above). */
  counterOff: boolean;
}

export interface NumberAudit {
  ok: boolean;
  years: SeriesYearReport[];
  /** Documents with no rank: numbered before the counter existed, left alone. */
  legacy: Record<DocumentSeries, number>;
  /** A counter row with no document at all. */
  counterWithoutDocuments: CounterRow[];
  problems: string[];
}

/** The number a rank says. A rank that cannot have one (0, a negative, a fraction: a row written by hand) is reported, not a reason for the audit to stop. */
function numberExpected(series: DocumentSeries, year: number, sequence: number): string {
  try {
    return formatDocumentNumber(series, year, sequence);
  } catch {
    return `(no number can be written for rank ${sequence} of ${year})`;
  }
}

/** The audit names this many missing ranks of a series and year, and counts the rest. */
export const MAX_LISTED_GAPS = 200;

export function auditNumbers(documents: Record<DocumentSeries, NumberedDocument[]>, counters: CounterRow[]): NumberAudit {
  const years: SeriesYearReport[] = [];
  const legacy = { INVOICE: 0, CREDIT_NOTE: 0 } as Record<DocumentSeries, number>;
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const series of DOCUMENT_SERIES) {
    const ranked = new Map<number, NumberedDocument[]>();

    for (const document of documents[series] ?? []) {
      if (document.sequence === null || document.sequence === undefined || document.year === null || document.year === undefined) {
        legacy[series] += 1;
        continue;
      }

      // Added to the list of its year, not copied into a new one: the audit of a big year must not be quadratic.
      const sameYear = ranked.get(document.year);

      if (sameYear) sameYear.push(document);
      else ranked.set(document.year, [document]);
    }

    for (const year of [...ranked.keys()].sort((a, b) => a - b)) {
      const list = ranked.get(year) as NumberedDocument[];
      const byRank = new Map<number, number>();

      for (const document of list) byRank.set(document.sequence as number, (byRank.get(document.sequence as number) ?? 0) + 1);

      // A loop, not Math.max(...ranks): a year with a hundred thousand documents must not overflow the stack of the audit.
      let highest = 0;
      let inRange = 0;

      for (const rank of byRank.keys()) {
        if (rank > highest) highest = rank;
        if (rank >= 1) inRange += 1;
      }

      // A rank that is far too high (a row written by hand) must not make the audit list billions of gaps: it lists the first ones and counts the rest.
      const missingCount = highest - inRange;
      const missing: number[] = [];

      for (let rank = 1; rank <= highest && missing.length < MAX_LISTED_GAPS; rank += 1) if (!byRank.has(rank)) missing.push(rank);

      const duplicated = [...byRank.entries()].filter(([, count]) => count > 1).map(([rank]) => rank).sort((a, b) => a - b);
      const misnumbered = list
        .map((document) => ({ id: document.id, number: document.number, expected: numberExpected(series, year, document.sequence as number) }))
        .filter((entry) => entry.number !== entry.expected);
      const row = counters.find((counter) => counter.series === series && counter.year === year);
      const counter = row ? row.last : null;
      const counterOff = counter !== highest;

      seen.add(`${series}:${year}`);
      years.push({ series, year, count: list.length, highest, missing, duplicated, misnumbered, counter, counterOff });

      if (missingCount > 0) problems.push(`${series} ${year}: rank(s) ${missing.join(', ')}${missingCount > missing.length ? ` and ${missingCount - missing.length} more` : ''} missing (a gap).`);
      if (duplicated.length > 0) problems.push(`${series} ${year}: rank(s) ${duplicated.join(', ')} given twice.`);
      for (const entry of misnumbered) problems.push(`${series} ${year}: document ${entry.id} is written ${entry.number}, its rank says ${entry.expected}.`);
      if (counterOff) problems.push(`${series} ${year}: the counter is at ${counter === null ? 'nothing (no row)' : counter}, the highest rank given is ${highest}.`);
    }
  }

  const counterWithoutDocuments = counters.filter((counter) => !seen.has(`${counter.series}:${counter.year}`) && counter.last > 0);

  for (const counter of counterWithoutDocuments) problems.push(`${counter.series} ${counter.year}: the counter is at ${counter.last} but there is no document of that year.`);

  return { ok: problems.length === 0, years, legacy, counterWithoutDocuments, problems };
}

/** The report as lines for a person. */
export function describeAudit(audit: NumberAudit): string[] {
  const lines: string[] = [];

  for (const year of audit.years) {
    lines.push(
      `${year.series} ${year.year}: ${year.count} document(s), ranks 1 to ${year.highest}, counter ${year.counter ?? '-'}${year.missing.length + year.duplicated.length + year.misnumbered.length === 0 && !year.counterOff ? ' - no gap' : ' - PROBLEM'}`,
    );
  }

  if (audit.years.length === 0) lines.push('No document with a rank yet.');

  if (audit.legacy.INVOICE > 0) lines.push(`${audit.legacy.INVOICE} invoice(s) numbered before the counter existed (left alone).`);
  if (audit.legacy.CREDIT_NOTE > 0) lines.push(`${audit.legacy.CREDIT_NOTE} credit note(s) numbered before the counter existed (left alone).`);

  for (const problem of audit.problems) lines.push(`PROBLEM: ${problem}`);

  lines.push(audit.ok ? 'OK: the numbers have no gaps.' : `NOT OK: ${audit.problems.length} problem(s).`);

  return lines;
}
