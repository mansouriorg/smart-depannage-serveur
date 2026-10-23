import { resetLocale, applyLocale } from '../locale/locale';
import {
  MoneyError,
  compareMoney,
  divideMoney,
  formatMoney,
  fromMillimes,
  isMoney,
  isZeroMoney,
  money,
  moneyOrNull,
  multiplyMoney,
  percentOf,
  ratioPercent,
  subtractMoney,
  sumMoney,
  sumMoneyOf,
  toMillimes,
  toMoneyString,
  totalOfLines,
  vatTotals,
} from './money';

/** What Prisma answers for a DECIMAL column: an object, not a number, whose text is the amount. */
const decimal = (text: string) => ({ toString: () => text });

describe('money: amounts are exact to the millime (P2-01)', () => {
  it('reads a number, a text, a Decimal and a missing amount', () => {
    expect(toMillimes(12.345)).toBe(12345);
    expect(toMillimes('12.345')).toBe(12345);
    expect(toMillimes(decimal('12.345'))).toBe(12345);
    expect(toMillimes(null)).toBe(0);
    expect(toMillimes(undefined)).toBe(0);
    expect(toMillimes(7n)).toBe(7000);
    expect(money(decimal('0.001'))).toBe(0.001);
    expect(money(decimal('-4.5'))).toBe(-4.5);
    expect(moneyOrNull(null)).toBeNull();
    expect(moneyOrNull(undefined)).toBeNull();
    expect(moneyOrNull('1.5')).toBe(1.5);
  });

  it('rounds on the decimal text, half away from zero, never on the binary value', () => {
    expect(money('1.0005')).toBe(1.001);
    expect(money('1.0004')).toBe(1);
    expect(money('-1.0005')).toBe(-1.001);
    expect(money('2.5e-4')).toBe(0);
    expect(money('5e-4')).toBe(0.001);
    // 0.1 + 0.2 is 0.30000000000000004 as a float, and 0.300 as an amount.
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money(1.005)).toBe(1.005);
    expect(money('1e3')).toBe(1000);
  });

  it('refuses what is not an amount instead of making it zero', () => {
    for (const bad of ['abc', '', ' ', '1.2.3', NaN, Infinity, '--1', '1e999', {}]) {
      expect(() => money(bad as never)).toThrow('amount');
    }

    expect(isMoney('12.5')).toBe(true);
    expect(isMoney(null)).toBe(false);
    expect(isMoney('x')).toBe(false);
    expect(() => money(1e16)).toThrow('out of range');
  });

  it('adds without the error of a float', () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney(12.345, 12.345, 12.345)).toBe(37.035);
    expect(sumMoney()).toBe(0);
    expect(sumMoney(decimal('10.001'), '0.002', 3)).toBe(13.003);
    expect(sumMoneyOf(new Array(10000).fill(0.001))).toBe(10);
    expect(subtractMoney(10, 0.001)).toBe(9.999);
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
  });

  it('compares to the millime', () => {
    expect(compareMoney('12.345', 12.345)).toBe(0);
    expect(compareMoney(12.344, 12.345)).toBe(-1);
    expect(compareMoney(decimal('12.346'), 12.345)).toBe(1);
    expect(compareMoney(0.1 + 0.2, 0.3)).toBe(0);
    expect(isZeroMoney(0)).toBe(true);
    expect(isZeroMoney(null)).toBe(true);
    expect(isZeroMoney('0.0004')).toBe(true);
    expect(isZeroMoney('0.001')).toBe(false);
  });

  it('multiplies and takes a percent with a single rounding', () => {
    expect(multiplyMoney(12.345, 2)).toBe(24.69);
    expect(multiplyMoney(12.345, 1.5)).toBe(18.518);
    expect(multiplyMoney(0.1, 3)).toBe(0.3);
    expect(multiplyMoney(1.005, 100)).toBe(100.5);
    expect(percentOf(12.345, 19)).toBe(2.346);
    expect(percentOf(100, 19)).toBe(19);
    expect(percentOf(100, 7.5)).toBe(7.5);
    expect(percentOf(0.001, 50)).toBe(0.001);
    expect(percentOf(-12.345, 19)).toBe(-2.346);
    expect(divideMoney(10, 3)).toBe(3.333);
    expect(divideMoney(20, 3)).toBe(6.667);
    expect(() => divideMoney(1, 0)).toThrow('parts');
    expect(ratioPercent(1, 3)).toBe(33.33);
    expect(ratioPercent(2, 3)).toBe(66.67);
    expect(ratioPercent(5, 0)).toBe(0);
  });

  it('the total of a document is exactly the amount and its tax added', () => {
    expect(vatTotals(12.345, 19)).toEqual({ amountHT: 12.345, taxAmount: 2.346, amountTTC: 14.691 });
    expect(vatTotals(12.345, 0)).toEqual({ amountHT: 12.345, taxAmount: 0, amountTTC: 12.345 });
    expect(vatTotals(100, 19)).toEqual({ amountHT: 100, taxAmount: 19, amountTTC: 119 });

    for (const ht of [0.001, 1.005, 33.333, 99.999, 1234.567, 0.5]) {
      for (const rate of [0, 7, 13, 19]) {
        const totals = vatTotals(ht, rate);

        expect(toMillimes(totals.amountTTC)).toBe(toMillimes(totals.amountHT) + toMillimes(totals.taxAmount));
      }
    }
  });

  it('prices the lines and sums them', () => {
    const priced = totalOfLines([
      { unitPrice: 12.345, quantity: 3 },
      { unitPrice: decimal('0.5'), quantity: 0.5 },
      { unitPrice: '1' },
    ]);

    expect(priced.lines.map((line) => line.total)).toEqual([37.035, 0.25, 1]);
    expect(priced.amountHT).toBe(38.285);
    expect(priced.lines[2].quantity).toBe(1);
  });

  it('writes an amount for a machine and for a person', () => {
    expect(toMoneyString(12.345)).toBe('12.345');
    expect(toMoneyString(12.3)).toBe('12.300');
    expect(toMoneyString(0)).toBe('0.000');
    expect(toMoneyString(-0.5)).toBe('-0.500');
    expect(toMoneyString(null)).toBe('0.000');
    expect(toMoneyString(decimal('1234567.8'))).toBe('1234567.800');
    expect(formatMoney(12.345)).toBe('12,345 TND');
    expect(formatMoney(1234.5)).toBe('1 234,500 TND');
    expect(formatMoney(-1234567.891)).toBe('-1 234 567,891 TND');
    expect(formatMoney(0.001)).toBe('0,001 TND');
    expect(formatMoney(5, { currency: 'EUR' })).toBe('5,000 EUR');
    expect(formatMoney(5, { currency: false })).toBe('5,000');
  });

  it('prints the currency of the company settings', () => {
    applyLocale({ currency: 'EUR' });
    expect(formatMoney(5)).toBe('5,000 EUR');
    resetLocale();
    expect(formatMoney(5)).toBe('5,000 TND');
  });

  it('only whole millimes become an amount again', () => {
    expect(fromMillimes(12345)).toBe(12.345);
    expect(fromMillimes(-1)).toBe(-0.001);
    expect(fromMillimes(0)).toBe(0);
    expect(() => fromMillimes(1.5)).toThrow('whole number');
    expect(new MoneyError('x').name).toBe('MoneyError');
    // Every millime from -2.5 to 2.5 dinars survives the trip through a number and the text.
    for (let millimes = -2500; millimes <= 2500; millimes += 1) {
      expect(toMillimes(fromMillimes(millimes))).toBe(millimes);
      expect(toMoneyString(fromMillimes(millimes))).toBe(toMoneyString(String(millimes / 1000)));
    }
  });

  it('amounts up to a million dinars survive the trip through a number and the text', () => {
    let seed = 12345;

    for (let at = 0; at < 3000; at += 1) {
      // A small deterministic generator: the same amounts on every run.
      seed = (seed * 1103515245 + 12345) % 2147483648;

      const millimes = (seed % 2_000_000_000) - 1_000_000_000;
      const amount = fromMillimes(millimes);

      expect(toMillimes(amount)).toBe(millimes);
      expect(money(toMoneyString(amount))).toBe(amount);
      expect(toMoneyString(amount)).toBe(toMoneyString(String(amount)));
    }
  });

  it('shares and compares the same way whatever the sign of the divisor', () => {
    expect(ratioPercent(1, 3)).toBe(33.33);
    expect(ratioPercent(-1, 3)).toBe(-33.33);
    expect(ratioPercent(1, -3)).toBe(-33.33);
    expect(ratioPercent(-1, -3)).toBe(33.33);
    expect(ratioPercent(2, 3)).toBe(66.67);
    expect(ratioPercent(2, -3)).toBe(-66.67);
  });

  it('adds a list of any length without spreading it into arguments', () => {
    const many = new Array(300_000).fill(0.001);

    expect(sumMoneyOf(many)).toBe(300);
    expect(sumMoneyOf([])).toBe(0);
  });
});
