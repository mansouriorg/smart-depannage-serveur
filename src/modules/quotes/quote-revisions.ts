/**
 * The versions of a quote (P2-04).
 *
 * A quote that was sent can still be edited: the artisan answers a question, corrects a price. The customer who read the quote
 * a minute ago must not accept a price that changed under them, and the back office must be able to say what the customer was
 * shown. So the quote carries a `revision` (1 when it is first sent), each edit of its content (title, description, lines, tax
 * rate, the amounts, the PDF) that happens after it was sent writes the version it replaces in `QuoteRevision` and raises the number, and a customer
 * who answers can say which revision they read (see quote-decisions).
 *
 * A draft is not seen by anyone yet: editing it keeps no version and leaves the number at 1.
 */
import { compareMoney, money } from '../../common/money/money';

type Db = any;
type Row = Record<string, any>;

/** A line as it is kept: the amounts as numbers, an empty description as nothing. */
export interface QuoteLine {
  label: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
}

function clean(value: unknown): string | null {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value);
}

/** The lines of a quote in the form that is compared and kept. */
export function linesOf(items: Row[] | null | undefined): QuoteLine[] {
  return (items ?? []).map((item) => ({
    label: String(item.label),
    description: clean(item.description),
    quantity: Number(item.quantity),
    unitPrice: money(item.unitPrice),
    total: money(item.total),
  }));
}

/** Are these two PDFs the same document? (no PDF and an empty address are the same) */
export function samePdf(a: unknown, b: unknown): boolean {
  return clean(a) === clean(b);
}

/** The number of the version the quote is at now. */
export function revisionOf(quote: Row): number {
  const value = Number(quote.revision);

  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * What the customer reads of a quote, once an edit would give it these values: whether the edit changes any of it. The three
 * amounts are part of it: on a quote whose amounts did not match its lines (older data) an edit that only works them out again
 * still changes the price the customer was shown. So is the PDF, which is the document the customer downloads. The date a quote
 * expires is not.
 */
export function sameContent(
  quote: Row,
  next: { title: string; description: string | null; pdfUrl: string | null; taxRate: number; lines: QuoteLine[]; amountHT: number; taxAmount: number; amountTTC: number },
): boolean {
  return (
    String(quote.title) === next.title &&
    clean(quote.description) === clean(next.description) &&
    samePdf(quote.pdfUrl, next.pdfUrl) &&
    compareMoney(money(quote.taxRate), next.taxRate) === 0 &&
    compareMoney(money(quote.amountHT), next.amountHT) === 0 &&
    compareMoney(money(quote.taxAmount), next.taxAmount) === 0 &&
    compareMoney(money(quote.amountTTC), next.amountTTC) === 0 &&
    JSON.stringify(linesOf(quote.items)) === JSON.stringify(next.lines)
  );
}

/** Keeps the version that an edit replaces. Call it inside the transaction of the edit, under the lock of the job. */
export async function saveRevision(tx: Db, quote: Row, by: { userId: number | null }): Promise<void> {
  await tx.quoteRevision.create({
    data: {
      quoteId: quote.id,
      revision: revisionOf(quote),
      status: quote.status,
      title: quote.title,
      description: quote.description ?? null,
      currency: quote.currency,
      pdfUrl: clean(quote.pdfUrl),
      amountHT: money(quote.amountHT),
      taxRate: money(quote.taxRate),
      taxAmount: money(quote.taxAmount),
      amountTTC: money(quote.amountTTC),
      items: linesOf(quote.items),
      savedById: by.userId,
    },
  });
}

/** The versions a quote went through before the one it is at now, the latest first. */
export async function revisionsOf(db: Db, quoteId: number): Promise<Row[]> {
  return db.quoteRevision.findMany({ where: { quoteId }, orderBy: { revision: 'desc' } });
}
