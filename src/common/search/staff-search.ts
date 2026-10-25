import { phoneSearch } from '../../modules/admin/intervention-queue';

/**
 * What the lists of the back office share when they read a search box (P2-09): the text is cut, a NUL byte is dropped (PostgreSQL
 * refuses it with an error 500), a number is a row number ("12", "#12"), and a text that looks like a phone number is looked for in
 * every way it may have been written. Nothing here touches the database: the queues build a Prisma `where` from it.
 */

export type Where = Record<string, unknown>;

/** The longest text looked for: a longer one is cut, not refused (a pasted address). */
export const MAX_SEARCH_LENGTH = 100;

/** The largest id the database holds (a 32-bit integer): a bigger one is no row. */
export const MAX_ROW_ID = 2_147_483_647;

/** A `where` that matches nothing: a filter that cannot be satisfied must not silently match everything. */
export const NOTHING: Where = { id: { in: [] } };

/**
 * A text for a `contains`: Prisma writes it into a LIKE as it is, where "%" matches everything and "_" any one character, so a
 * backslash (the escape of PostgreSQL's LIKE) makes each of the three literal. "50%" finds 50%, not every row.
 */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/** The condition "this column holds the text, whatever its case", with the characters of LIKE taken literally. */
export function likeContains(text: string): { contains: string; mode: 'insensitive' } {
  return { contains: likeLiteral(text), mode: 'insensitive' };
}

/** Text for a database column: a NUL byte is refused by PostgreSQL, so it is dropped. */
export function withoutNul(text: string): string {
  return text.replace(/\u0000/g, '');
}

/** The text of the search box as it is looked for; empty when there is nothing to look for. */
export function searchText(raw: unknown): string {
  return withoutNul(String(raw ?? ''))
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .trim();
}

/** The row number, when the text is one: "12" or "#12" (a number past the largest id is no row, however many digits it has). */
export function rowNumber(text: string): number | null {
  const match = /^#?\s*(\d+)$/.exec(text);

  if (!match) return null;

  const id = Number(match[1]);

  return id >= 1 && id <= MAX_ROW_ID ? id : null;
}

/**
 * The conditions that look for a phone number in the places a queue keeps one. `leaves` says where the number is written (a column
 * of the row or of a person it points to) and the account key (digits only) where the account's own number is, if anywhere.
 */
export function phoneConditions(text: string, leaves: Array<(value: Where) => Where>, keys: Array<(digits: string) => Where> = []): Where[] {
  const phone = phoneSearch(text);

  if (!phone) return leaves.map((leaf) => leaf(likeContains(text)));

  return [...phone.variants.flatMap((variant) => leaves.map((leaf) => leaf({ contains: variant, mode: 'insensitive' }))), ...keys.map((key) => key(phone.digits))];
}

/** A whole number from the query, or null for text that is not one: a bad id means nothing, not everything. */
export function idOf(value: unknown): number | null {
  const number = Number(value);

  return Number.isInteger(number) && number >= 1 && number <= MAX_ROW_ID ? number : null;
}
