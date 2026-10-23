import { lastValueFrom, of } from 'rxjs';

import { Decimal } from '../testing/decimal-double';
import { decimalsToNumbers, isDecimal } from './money-numbers';
import { MoneyNumbersInterceptor } from './money-numbers.interceptor';

describe('amounts leave the API as numbers (P2-01)', () => {
  it('knows a Decimal from everything else', () => {
    expect(isDecimal(new Decimal('12.345'))).toBe(true);
    expect(isDecimal(12.345)).toBe(false);
    expect(isDecimal('12.345')).toBe(false);
    expect(isDecimal(null)).toBe(false);
    expect(isDecimal({ toNumber: () => 1 })).toBe(false);
    expect(isDecimal(new Date())).toBe(false);
  });

  it('a Decimal is not a number, and JSON writes it as a text: that is what the conversion is for', () => {
    const amount = new Decimal('12.345');

    expect(typeof amount).toBe('object');
    expect(JSON.stringify({ amount })).toBe('{"amount":"12.345"}');
    expect(JSON.stringify(decimalsToNumbers({ amount }))).toBe('{"amount":12.345}');
    expect((amount as any) + (amount as any)).toBe('12.34512.345');
  });

  it('converts at every depth of arrays and plain objects, and leaves the rest', () => {
    const when = new Date('2026-10-23T10:00:00Z');
    const file = Buffer.from('x');
    const input = {
      amountHT: new Decimal('12.345'),
      taxRate: new Decimal('19'),
      none: null,
      text: 'abc',
      count: 3,
      when,
      file,
      items: [{ unitPrice: new Decimal('0.5'), total: new Decimal('0.001') }, [new Decimal('-3.2')]],
      nested: { deeper: { deepest: { amount: new Decimal('7.5') } } },
    };

    const out: any = decimalsToNumbers(input);

    expect(out.amountHT).toBe(12.345);
    expect(out.taxRate).toBe(19);
    expect(out.none).toBeNull();
    expect(out.text).toBe('abc');
    expect(out.count).toBe(3);
    expect(out.when).toBe(when);
    expect(out.file).toBe(file);
    expect(out.items[0]).toEqual({ unitPrice: 0.5, total: 0.001 });
    expect(out.items[1]).toEqual([-3.2]);
    expect(out.nested.deeper.deepest.amount).toBe(7.5);
    // The input is untouched.
    expect(isDecimal(input.amountHT)).toBe(true);
    expect(isDecimal((input.items as any)[0].unitPrice)).toBe(true);
  });

  it('follows a deep answer to the bottom', () => {
    let deep: any = { amount: new Decimal('1.5') };

    for (let level = 0; level < 40; level += 1) deep = { child: deep };

    let node: any = decimalsToNumbers(deep);

    for (let level = 0; level < 40; level += 1) node = node.child;

    expect(node.amount).toBe(1.5);
  });

  it('a value shared twice is converted twice, and a loop does not run for ever', () => {
    const shared = { amount: new Decimal('2') };
    const out: any = decimalsToNumbers({ a: shared, b: shared });

    expect(out.a.amount).toBe(2);
    expect(out.b.amount).toBe(2);

    const loop: any = { name: 'loop' };

    loop.self = loop;
    expect(decimalsToNumbers(loop).self).toBe(loop);
  });

  it('keeps the three decimals of an amount through the trip', () => {
    for (let millimes = -3000; millimes <= 3000; millimes += 7) {
      const text = (millimes / 1000).toFixed(3);

      expect(String(decimalsToNumbers(new Decimal(text)))).toBe(String(Number(text)));
      expect(decimalsToNumbers(new Decimal(text)).toString()).toBe(String(Number(text)));
    }

    expect(decimalsToNumbers(new Decimal('99999999999.999'))).toBe(99999999999.999);
  });

  it('the interceptor converts what a route answers, and only for http', async () => {
    const interceptor = new MoneyNumbersInterceptor();
    const http: any = { getType: () => 'http' };
    const socket: any = { getType: () => 'ws' };
    const body = { quote: { amountTTC: new Decimal('14.691') }, list: [new Decimal('1.5')] };

    const answered: any = await lastValueFrom(interceptor.intercept(http, { handle: () => of(body) }) as any);

    expect(answered.quote.amountTTC).toBe(14.691);
    expect(answered.list).toEqual([1.5]);

    const untouched: any = await lastValueFrom(interceptor.intercept(socket, { handle: () => of(body) }) as any);

    expect(untouched).toBe(body);
  });
});
