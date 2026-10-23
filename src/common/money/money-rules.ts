/**
 * What the request objects accept as an amount and as a rate (P2-01), as plain functions that need no validation library.
 *
 * class-validator's own `maxDecimalPlaces` counts the decimals on the text after the point and throws on a number written
 * with an exponent (`1e-7` has no "."), which would turn a bad request into a 500. These rules read the number through
 * `money()`, which knows exponents: an amount is valid when reading it as millimes gives the same number back.
 */
import { isValidRate } from '../locale/locale';
import { MAX_COLUMN_AMOUNT, money } from './money';

/** A finite number from `min` to the size of a money column, with at most three decimals (millimes). */
export function isValidAmount(value: unknown, min = 0): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < min || value > MAX_COLUMN_AMOUNT) return false;

  try {
    return money(value) === value;
  } catch {
    return false;
  }
}

/** A percent from 0 to 100 with at most two decimals. */
export function isValidTaxRate(value: unknown): boolean {
  return isValidRate(value);
}
