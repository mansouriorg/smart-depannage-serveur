/**
 * What an invoice prints about the company (P2-01): its bank account (RIB) and its matricule fiscal.
 *
 * Both are written by people with spaces and dashes, in lower case; they are kept in one spelling. A RIB is 20 digits.
 * The matricule fiscal is checked loosely (seven digits, a control letter, then the category codes and the number of
 * the establishment): the exact layout is confirmed with the accountant when the invoice is printed (P2-07), and a rule
 * that is too strict here would stop the administrators from saving a valid one.
 */

/** "08 006 0123456789012 34" -> "08006012345678901234"; throws when it is not 20 digits. */
export function normalizeRib(value: string): string {
  const digits = value.replace(/[\s.-]/g, '');

  if (!/^\d{20}$/.test(digits)) throw new Error('rib: 20 digits (bank, branch, account and key)');

  return digits;
}

/** "1234567 a/m/000" -> "1234567A/M/000"; "1234567/a/a/m/000" -> "1234567/A/A/M/000" (both ways of writing it are in use). */
export function normalizeMatriculeFiscal(value: string): string {
  const text = value.trim().toUpperCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');

  if (!/^\d{7}[\s/]?[A-Z](?:[\s/]?[A-Z0-9]){0,12}$/.test(text)) {
    throw new Error('matriculeFiscal: seven digits, a letter, then the codes of the category and of the establishment (example: 1234567A/M/000)');
  }

  return text.replace(/\s/g, '');
}
