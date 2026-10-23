/**
 * A stand-in for the `Decimal` object that Prisma answers for a DECIMAL column (P2-01), used only by the in-memory database of the tests.
 *
 * What matters is that it is NOT a number, exactly like the real one (decimal.js): `a + b` joins two texts, `a > b` compares
 * two texts, `JSON.stringify` writes a string. A service that forgets to read an amount with `money(...)` fails a test here
 * instead of failing in production. It is exact (whole digits in a BigInt), keeps no trailing zeros in `toString()`
 * (12.500 prints "12.5", as decimal.js does), and rounds a value written into a column to the scale of the column, half away
 * from zero, as PostgreSQL does for NUMERIC.
 */
export class Decimal {
  /** All the digits, with the sign. */
  readonly units: bigint;
  /** How many of the digits are decimals. */
  readonly scale: number;

  constructor(value: unknown) {
    const parts = parseDecimal(value);

    this.units = parts.units;
    this.scale = parts.scale;
  }

  get [Symbol.toStringTag](): string {
    return 'Decimal';
  }

  /** The shortest text: no trailing zeros ("12.5", "-3", "0"). */
  toString(): string {
    return formatDecimal(this.units, this.scale, null);
  }

  /** Like decimal.js, the primitive value of a Decimal is its text. */
  valueOf(): string {
    return this.toString();
  }

  toJSON(): string {
    return this.toString();
  }

  toNumber(): number {
    return Number(this.toString());
  }

  /** Exactly `places` decimals (rounded half away from zero), or all of them when no number is given. */
  toFixed(places?: number): string {
    return formatDecimal(this.units, this.scale, places ?? this.scale);
  }

  toDecimalPlaces(places: number): Decimal {
    const parts = rescale({ units: this.units, scale: this.scale }, places);

    return fromParts(parts.units, parts.scale);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  neg(): Decimal {
    return fromParts(-this.units, this.scale);
  }

  abs(): Decimal {
    return fromParts(this.units < 0n ? -this.units : this.units, this.scale);
  }

  plus(other: unknown): Decimal {
    const [a, b, scale] = align(this, other);

    return fromParts(a + b, scale);
  }

  minus(other: unknown): Decimal {
    const [a, b, scale] = align(this, other);

    return fromParts(a - b, scale);
  }

  times(other: unknown): Decimal {
    const o = parseDecimal(other);

    return fromParts(this.units * o.units, this.scale + o.scale);
  }

  /** Twenty decimals, like the default precision of decimal.js. */
  dividedBy(other: unknown): Decimal {
    const o = parseDecimal(other);

    if (o.units === 0n) throw new Error('Decimal: division by zero');

    const extra = 20;
    const numerator = this.units * 10n ** BigInt(extra + o.scale);
    const denominator = o.units * 10n ** BigInt(this.scale);

    return fromParts(divideRounded(numerator, denominator), extra);
  }

  comparedTo(other: unknown): -1 | 0 | 1 {
    return compareDecimals(this, other);
  }

  equals(other: unknown): boolean {
    return compareDecimals(this, other) === 0;
  }

  lessThan(other: unknown): boolean {
    return compareDecimals(this, other) < 0;
  }

  lessThanOrEqualTo(other: unknown): boolean {
    return compareDecimals(this, other) <= 0;
  }

  greaterThan(other: unknown): boolean {
    return compareDecimals(this, other) > 0;
  }

  greaterThanOrEqualTo(other: unknown): boolean {
    return compareDecimals(this, other) >= 0;
  }
}

interface Parts {
  units: bigint;
  scale: number;
}

const TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimal(value: unknown): Parts {
  if (value instanceof Decimal) return { units: value.units, scale: value.scale };
  if (typeof value === 'bigint') return { units: value, scale: 0 };
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${typeof value} is not a decimal`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${value} is not a decimal`);

  const text = String(value).trim();
  const match = TEXT.exec(text);

  if (!match || (!match[2] && !match[3])) throw new Error(`"${text.slice(0, 40)}" is not a decimal`);

  const fraction = match[3] ?? '';
  const exponent = match[4] ? Number(match[4]) : 0;

  if (Math.abs(exponent) > 400) throw new Error(`"${text.slice(0, 40)}" is out of range`);

  let units = BigInt(`${match[2] ?? ''}${fraction}` || '0');
  let scale = fraction.length - exponent;

  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }

  return { units: match[1] === '-' ? -units : units, scale };
}

function fromParts(units: bigint, scale: number): Decimal {
  const out = Object.create(Decimal.prototype) as { units: bigint; scale: number };

  out.units = units;
  out.scale = scale;

  return out as unknown as Decimal;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;

  if ((n % d) * 2n >= d) quotient += 1n;

  return negative ? -quotient : quotient;
}

function rescale(parts: Parts, scale: number): Parts {
  if (parts.scale <= scale) return { units: parts.units * 10n ** BigInt(scale - parts.scale), scale };

  return { units: divideRounded(parts.units, 10n ** BigInt(parts.scale - scale)), scale };
}

function align(a: Decimal, other: unknown): [bigint, bigint, number] {
  const b = parseDecimal(other);
  const scale = Math.max(a.scale, b.scale);

  return [rescale(a, scale).units, rescale(b, scale).units, scale];
}

function formatDecimal(units: bigint, scale: number, places: number | null): string {
  let value = units;
  let digitsAfter = scale;

  if (places !== null) {
    const fixed = rescale({ units, scale }, places);

    value = fixed.units;
    digitsAfter = places;
  }

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(digitsAfter + 1, '0');
  const whole = digits.slice(0, digits.length - digitsAfter);
  let fraction = digits.slice(digits.length - digitsAfter);

  if (places === null) fraction = fraction.replace(/0+$/, '');

  return `${negative ? '-' : ''}${fraction ? `${whole}.${fraction}` : whole}`;
}

function compareDecimals(a: unknown, b: unknown): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const difference = rescale(x, scale).units - rescale(y, scale).units;

  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** A number, a decimal text or a Decimal: what a DECIMAL column accepts. */
export function isDecimalInput(value: unknown): boolean {
  if (value instanceof Decimal) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;

  const match = TEXT.exec(value.trim());

  return Boolean(match && (match[2] || match[3]));
}

/** What PostgreSQL does with a value written into NUMERIC(precision, scale): rounds to the scale, refuses what does not fit. */
export function toColumnDecimal(value: unknown, precision: number, scale: number, where: string): Decimal {
  const fixed = rescale(parseDecimal(value), scale);
  const digits = (fixed.units < 0n ? -fixed.units : fixed.units).toString().length;

  if (digits > precision) {
    throw Object.assign(new Error(`Value out of range for the type. The column \`${where}\` is NUMERIC(${precision},${scale}) and ${String(value).slice(0, 40)} does not fit`), { code: 'P2020' });
  }

  return fromParts(fixed.units, fixed.scale);
}

/** Exact sum (null when there is nothing to add), with the scale of the widest term. */
export function sumDecimals(values: unknown[]): Decimal | null {
  if (!values.length) return null;

  let total: Decimal = fromParts(0n, 0);

  for (const value of values) total = total.plus(value);

  return total;
}

export function averageDecimals(values: unknown[]): Decimal | null {
  const total = sumDecimals(values);

  return total ? total.dividedBy(values.length) : null;
}

export { compareDecimals };
