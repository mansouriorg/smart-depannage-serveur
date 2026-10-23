/**
 * Money (P2-01): amounts are exact to the millime (the dinar has three decimals), and every total is computed in whole millimes.
 *
 * The database keeps money in `DECIMAL(14,3)` columns, and Prisma answers a Decimal object for them. A Decimal is not a number:
 * `a + b` joins two texts, `Math.round(a)` is not the amount, `JSON.stringify` writes a string. So the services read an amount
 * with `money(row.amount)` (a plain number that holds exactly three decimals, like 12.345), and compute with the functions below
 * (whole millimes, rounded half up, never a float product). The answers of the API stay plain numbers: see `common/money/money-numbers`.
 *
 * Rounding: an amount with more than three decimals is rounded half away from zero on its decimal text, as PostgreSQL rounds a
 * number into a DECIMAL(14,3) column. 1.0005 is 1.001; a float's binary error is not looked at (0.1 + 0.2 is 0.300).
 */
import { currencyCode } from '../locale/locale';

/** A number, a decimal text, or a Prisma Decimal (anything whose `toString()` is a decimal number). */
export type MoneyInput = number | string | bigint | { toString(): string } | null | undefined;

export const MONEY_DECIMALS = 3;
const MILLIMES_PER_UNIT = 10n ** BigInt(MONEY_DECIMALS);

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** The largest amount that three decimals still hold exactly in a number: about 9 000 000 000 000 dinars. */
export const MAX_MONEY = Number.MAX_SAFE_INTEGER / 1000;

/** The largest amount a money column holds: DECIMAL(14,3) is eleven digits before the decimal point. */
export const MAX_COLUMN_AMOUNT = 99_999_999_999.999;

interface Parsed {
  /** All the digits, with the sign. */
  units: bigint;
  /** How many of the digits are decimals. */
  scale: number;
}

const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parse(value: unknown, what = 'amount'): Parsed {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new MoneyError(`${what}: ${value} is not an amount`);

  const text = (typeof value === 'bigint' ? value.toString() : String(value)).trim();
  const match = DECIMAL_TEXT.exec(text);

  if (!match || (!match[2] && !match[3])) throw new MoneyError(`${what}: "${text}" is not an amount`);

  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = match[4] ? Number(match[4]) : 0;

  if (Math.abs(exponent) > 40) throw new MoneyError(`${what}: "${text}" is out of range`);

  let units = BigInt(`${whole}${fraction}` || '0');
  let scale = fraction.length - exponent;

  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }

  return { units: match[1] === '-' ? -units : units, scale };
}

/** `numerator / denominator` rounded half away from zero (the sign of the quotient is the sign of the two together). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  let quotient = magnitude / divisor;

  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;

  return negative ? -quotient : quotient;
}

function toBigMillimes(value: unknown, what: string): bigint {
  const { units, scale } = parse(value, what);

  if (scale <= MONEY_DECIMALS) return units * 10n ** BigInt(MONEY_DECIMALS - scale);

  return divideRounded(units, 10n ** BigInt(scale - MONEY_DECIMALS));
}

function toSafeNumber(millimes: bigint, what: string): number {
  if (millimes > BigInt(Number.MAX_SAFE_INTEGER) || millimes < -BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`${what}: out of range`);

  return Number(millimes);
}

/** The amount in whole millimes: 12.345 -> 12345. Null and undefined are no amount at all, and 0. */
export function toMillimes(value: MoneyInput, what = 'amount'): number {
  if (value === null || value === undefined) return 0;

  return toSafeNumber(toBigMillimes(value, what), what);
}

export function fromMillimes(millimes: number): number {
  if (!Number.isInteger(millimes)) throw new MoneyError(`${millimes} is not a whole number of millimes`);

  // A whole number divided by 1000 is the double nearest to the decimal, which prints with at most three decimals.
  return millimes / 1000 + 0;
}

/** The amount as a plain number with exactly three decimals. Null and undefined are 0. */
export function money(value: MoneyInput, what = 'amount'): number {
  return fromMillimes(toMillimes(value, what));
}

/** Like `money`, but a missing amount stays missing. */
export function moneyOrNull(value: MoneyInput, what = 'amount'): number | null {
  return value === null || value === undefined ? null : money(value, what);
}

export function isMoney(value: unknown): boolean {
  try {
    parse(value);

    return value !== null && value !== undefined;
  } catch {
    return false;
  }
}

/** The sum of a list of any length (a list of thousands of rows is not spread into arguments). */
export function sumMoneyOf(values: readonly MoneyInput[]): number {
  return fromMillimes(values.reduce<number>((total, value) => total + toMillimes(value), 0));
}

export function sumMoney(...values: MoneyInput[]): number {
  return sumMoneyOf(values);
}

/** An amount shared between `parts` (an average): rounded to the millime, half away from zero. */
export function divideMoney(amount: MoneyInput, parts: number): number {
  if (!Number.isInteger(parts) || parts <= 0) throw new MoneyError(`${parts} is not a number of parts`);

  return fromMillimes(toSafeNumber(divideRounded(toBigMillimes(amount, 'amount'), BigInt(parts)), 'amount'));
}

/** `part` as a percent of `whole`, with two decimals (12.34 for 12.34 %); 0 when there is no whole. */
export function ratioPercent(part: MoneyInput, whole: MoneyInput): number {
  const base = toBigMillimes(whole, 'whole');

  if (base === 0n) return 0;

  return Number(divideRounded(toBigMillimes(part, 'part') * 10_000n, base)) / 100;
}

export function subtractMoney(from: MoneyInput, amount: MoneyInput): number {
  return fromMillimes(toMillimes(from) - toMillimes(amount));
}

/** -1, 0 or 1: the amounts compared to the millime. */
export function compareMoney(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  const difference = toMillimes(a) - toMillimes(b);

  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}

export function isZeroMoney(value: MoneyInput): boolean {
  return toMillimes(value) === 0;
}

/** `amount` times `factor` (a quantity, three decimals or more are kept in the product before the one rounding). */
export function multiplyMoney(amount: MoneyInput, factor: MoneyInput): number {
  const { units, scale } = parse(factor, 'factor');

  return fromMillimes(toSafeNumber(divideRounded(toBigMillimes(amount, 'amount') * units, 10n ** BigInt(scale)), 'amount'));
}

/** `rate` percent of `amount`: 19 % of 12.345 is 2.346 (2.34555 rounded). */
export function percentOf(amount: MoneyInput, rate: MoneyInput): number {
  const { units, scale } = parse(rate, 'rate');

  return fromMillimes(toSafeNumber(divideRounded(toBigMillimes(amount, 'amount') * units, 100n * 10n ** BigInt(scale)), 'amount'));
}

export interface VatTotals {
  amountHT: number;
  taxAmount: number;
  amountTTC: number;
}

/** The three amounts of a quote or an invoice: the tax is the one rounding, and the total is exactly the two parts added. */
export function vatTotals(amountHT: MoneyInput, taxRate: MoneyInput): VatTotals {
  const ht = money(amountHT, 'amountHT');
  const taxAmount = percentOf(ht, taxRate);

  return { amountHT: ht, taxAmount, amountTTC: sumMoney(ht, taxAmount) };
}

/** The lines of a quote or an invoice, the total of each, and the sum of the lines as the amount without tax. */
export function totalOfLines<T extends { quantity?: MoneyInput; unitPrice: MoneyInput }>(lines: T[]): { lines: Array<T & { quantity: number; unitPrice: number; total: number }>; amountHT: number } {
  const priced = lines.map((line) => {
    const quantity = line.quantity === null || line.quantity === undefined ? 1 : Number(String(line.quantity));
    const unitPrice = money(line.unitPrice, 'unitPrice');

    return { ...line, quantity, unitPrice, total: multiplyMoney(unitPrice, quantity) };
  });

  return { lines: priced, amountHT: sumMoneyOf(priced.map((line) => line.total)) };
}

/** "12.345": three decimals, a dot, no currency and no grouping: what a file for a machine holds. */
export function toMoneyString(value: MoneyInput): string {
  const millimes = toBigMillimes(value ?? 0, 'amount');
  const negative = millimes < 0n;
  const magnitude = negative ? -millimes : millimes;
  const whole = magnitude / MILLIMES_PER_UNIT;
  const fraction = (magnitude % MILLIMES_PER_UNIT).toString().padStart(MONEY_DECIMALS, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** "1 234,500 TND": for a person; the currency is the one of the company settings. */
export function formatMoney(value: MoneyInput, options: { currency?: string | false } = {}): string {
  const [whole, fraction] = toMoneyString(value).split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const text = `${negative ? '-' : ''}${grouped},${fraction}`;
  const currency = options.currency === false ? '' : options.currency ?? currencyCode();

  return currency ? `${text} ${currency}` : text;
}
