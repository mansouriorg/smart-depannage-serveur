import { BadRequestException } from '@nestjs/common';

import { compareMoney, money, sumMoney, sumMoneyOf } from '../../common/money/money';
import { CREDIT_WORDS, creditNoteTotals, creditableOf } from './credit-note-totals';

const invoice = (over: Record<string, unknown> = {}) => ({ amountHT: 100, taxRate: 19, taxAmount: 19, amountTTC: 119, stampDuty: 0, ...over });

describe('the amounts of a credit note (P2-07)', () => {
  it('with no amount, it takes back everything that is left: the amounts of the invoice, the stamp duty with them', () => {
    const totals = creditNoteTotals(invoice({ stampDuty: 1 }), []);

    expect(totals).toEqual({ amountHT: 100, taxRate: 19, taxAmount: 19, amountTTC: 119, stampDuty: 1, closes: true });
  });

  it('a part is split at the rate of the invoice, and leaves the stamp duty with the invoice', () => {
    const totals = creditNoteTotals(invoice({ stampDuty: 1 }), [], 59.5);

    expect(totals).toEqual({ amountHT: 50, taxRate: 19, taxAmount: 9.5, amountTTC: 59.5, stampDuty: 0, closes: false });
  });

  it('the part that closes the invoice is what is left, to the millime, however the earlier parts were rounded', () => {
    const first = creditNoteTotals(invoice(), [], 33.333);
    const second = creditNoteTotals(invoice(), [first], 40.001);
    const last = creditNoteTotals(invoice(), [first, second]);

    expect(last.closes).toBe(true);
    expect(sumMoneyOf([first.amountHT, second.amountHT, last.amountHT])).toBe(100);
    expect(sumMoneyOf([first.taxAmount, second.taxAmount, last.taxAmount])).toBe(19);
    expect(sumMoneyOf([first.amountTTC, second.amountTTC, last.amountTTC])).toBe(119);
  });

  it('refuses an amount that is not above 0, or above what is left, or any amount once everything was taken back', () => {
    expect(() => creditNoteTotals(invoice(), [], 0)).toThrow(CREDIT_WORDS.amount);
    expect(() => creditNoteTotals(invoice(), [], -5)).toThrow(CREDIT_WORDS.amount);
    expect(() => creditNoteTotals(invoice(), [], 119.001)).toThrow(CREDIT_WORDS.tooMuch);
    expect(() => creditNoteTotals(invoice(), [{ amountTTC: 100, amountHT: 84.034, taxAmount: 15.966, stampDuty: 0 }], 19.001)).toThrow(CREDIT_WORDS.tooMuch);

    const all = creditNoteTotals(invoice(), []);

    expect(() => creditNoteTotals(invoice(), [all])).toThrow(CREDIT_WORDS.nothingLeft);

    let caught: unknown;

    try {
      creditNoteTotals(invoice(), [all]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
  });

  it('reads what is left of an invoice from its credit notes', () => {
    const first = creditNoteTotals(invoice({ stampDuty: 1 }), [], 50);

    expect(creditableOf(invoice({ stampDuty: 1 }), [first])).toEqual({ amountTTC: 69, amountHT: 100 - first.amountHT, taxAmount: 19 - first.taxAmount, stampDuty: 1 });
  });

  it('an amount as a text is read as an amount', () => {
    expect(creditNoteTotals(invoice(), [], '59.500').amountTTC).toBe(59.5);
  });

  it('a rate of 0 (an exempt invoice) takes back the whole amount as the amount without tax', () => {
    expect(creditNoteTotals({ amountHT: 80, taxRate: 0, taxAmount: 0, amountTTC: 80 }, [], 30)).toEqual({ amountHT: 30, taxRate: 0, taxAmount: 0, amountTTC: 30, stampDuty: 0, closes: false });
  });

  describe('whatever the rate, the parts and the closing part add up to the invoice to the millime and none goes over', () => {
    // A small deterministic generator, so that the cases are the same every run.
    let seed = 20261024;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return seed / 4294967296;
    };

    for (const rate of [0, 7, 13, 19, 5.5, 12.34]) {
      it(`rate ${rate} %`, () => {
        for (let round = 0; round < 150; round += 1) {
          const ht = money(Math.round(next() * 5_000_000) / 1000 + 0.001);
          const tax = money((ht * rate) / 100);
          const doc = { amountHT: ht, taxRate: rate, taxAmount: tax, amountTTC: sumMoney(ht, tax), stampDuty: round % 3 === 0 ? 1 : 0 };
          const notes: any[] = [];

          for (let part = 0; part < 4 && compareMoney(creditableOf(doc, notes).amountTTC, 0) > 0; part += 1) {
            const left = creditableOf(doc, notes).amountTTC;
            const asked = part === 3 || next() < 0.2 ? undefined : money(Math.max(0.001, Math.floor(next() * left * 1000) / 1000));
            const note = creditNoteTotals(doc, notes, asked);

            expect(compareMoney(note.amountTTC, 0)).toBe(1);
            expect(compareMoney(note.amountHT, 0)).toBeGreaterThanOrEqual(0);
            expect(compareMoney(note.taxAmount, 0)).toBeGreaterThanOrEqual(0);
            expect(sumMoney(note.amountHT, note.taxAmount)).toBe(note.amountTTC);
            notes.push(note);
          }

          const rest = creditableOf(doc, notes);

          if (rest.amountTTC === 0) {
            expect(rest.amountHT).toBe(0);
            expect(rest.taxAmount).toBe(0);
            expect(rest.stampDuty).toBe(0);
          } else {
            expect(compareMoney(rest.amountHT, 0)).toBeGreaterThanOrEqual(0);
            expect(compareMoney(rest.taxAmount, 0)).toBeGreaterThanOrEqual(0);
            expect(rest.stampDuty).toBe(doc.stampDuty);
          }
        }
      });
    }
  });
});
