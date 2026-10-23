import { MAX_COLUMN_AMOUNT } from './money';
import { isValidAmount, isValidTaxRate } from './money-rules';

describe('what a person may send as an amount (P2-01)', () => {
  it('accepts an amount with up to three decimals, from the minimum to the size of the column', () => {
    for (const value of [0, 0.001, 12.345, 100, 99999.999, 1_000_000.5, MAX_COLUMN_AMOUNT]) expect(isValidAmount(value)).toBe(true);
  });

  it('refuses more than three decimals, as a number and as a binary sum', () => {
    for (const value of [0.0001, 12.3456, 1.0005, 0.1 + 0.2, 1 / 3]) expect(isValidAmount(value)).toBe(false);
  });

  it('refuses a number written with an exponent that is not three decimals (class-validator would throw on it)', () => {
    for (const value of [1e-7, 1.5e-9, 1e-4]) expect(isValidAmount(value)).toBe(false);
    expect(isValidAmount(1e3)).toBe(true);
    expect(isValidAmount(2.5e2)).toBe(true);
  });

  it('refuses what is below the minimum, above the column, or not a finite number', () => {
    expect(isValidAmount(-0.001)).toBe(false);
    expect(isValidAmount(-5, -10)).toBe(true);
    expect(isValidAmount(0, 0.001)).toBe(false);
    expect(isValidAmount(0.001, 0.001)).toBe(true);
    expect(isValidAmount(MAX_COLUMN_AMOUNT + 0.001)).toBe(false);
    expect(isValidAmount(1e21)).toBe(false);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '12.345', '', null, undefined, true, [], {}, 12345678901234567n]) expect(isValidAmount(value)).toBe(false);
  });
});

describe('what a person may send as a rate (P2-01)', () => {
  it('accepts a percent from 0 to 100 with up to two decimals', () => {
    for (const value of [0, 7, 13, 19, 5.5, 18.25, 100]) expect(isValidTaxRate(value)).toBe(true);
  });

  it('refuses the rest, including an exponent and a text', () => {
    for (const value of [-1, 100.01, 19.999, 1e-7, 1 / 3, Number.NaN, Number.POSITIVE_INFINITY, '19', null, undefined, []]) expect(isValidTaxRate(value)).toBe(false);
  });
});
