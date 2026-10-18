/**
 * Copies of rows that carry only the columns a reader is allowed to have.
 *
 * Every answer that leaves the server for somebody who is not back office is built with these:
 * a column nobody listed does not leave, so a column added to the schema tomorrow stays inside
 * until somebody decides who may read it (a test reads the schema and refuses a column that no
 * table below knows).
 */

/** The listed keys of `row` that it has (a missing key stays missing; null and false are kept). */
export function pick<T extends object>(row: T, keys: readonly string[]): any {
  const source = row as Record<string, unknown>;
  const copy: Record<string, unknown> = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      copy[key] = source[key];
    }
  }

  return copy;
}

/** `view` applied to a list; anything that is not a list comes back as an empty one. */
export function each<T, R>(rows: readonly T[] | null | undefined, view: (row: T) => R): R[] {
  return Array.isArray(rows) ? rows.map((row) => view(row)) : [];
}
