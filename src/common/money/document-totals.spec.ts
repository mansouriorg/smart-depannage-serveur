import { applyLocale, resetLocale } from '../locale/locale';
import { requestAmount, requestTaxRate, totalsFromAmount, totalsFromItems } from './document-totals';

const line = (unitPrice: unknown, quantity: unknown = 1, label = 'Main d’œuvre') => ({ label, quantity, unitPrice });
/** A line exactly as given: `undefined` stays undefined (a default value would hide it). */
const raw = (fields: { unitPrice?: unknown; quantity?: unknown }) => ({ label: 'Main d’œuvre', ...fields });

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected a refusal');
}

describe('the totals of a quote and of an invoice (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('a quote of 12.345 TND is exactly 12.345, and its total adds up', () => {
    const exempt = totalsFromItems('quote', [line(12.345)], 0);

    expect(exempt.amountHT).toBe(12.345);
    expect(exempt.taxAmount).toBe(0);
    expect(exempt.amountTTC).toBe(12.345);
    expect(exempt.items[0].total).toBe(12.345);

    const standard = totalsFromItems('quote', [line(12.345)], undefined);

    expect(standard.taxRate).toBe(19);
    expect(standard.taxAmount).toBe(2.346);
    expect(standard.amountTTC).toBe(14.691);
  });

  it('prices each line to the millime before adding them', () => {
    const totals = totalsFromItems('quote', [line(0.1, 3), line(1.005, 100), line(12.345, 0.5)], 19);

    expect(totals.items.map((item) => item.total)).toEqual([0.3, 100.5, 6.173]);
    expect(totals.amountHT).toBe(106.973);
    expect(totals.taxAmount).toBe(20.325);
    expect(totals.amountTTC).toBe(127.298);
  });

  it('takes the rate of the settings when nobody gave one', () => {
    applyLocale({ defaultTaxRate: 13 });
    expect(totalsFromItems('quote', [line(100)], undefined).taxRate).toBe(13);
    expect(totalsFromItems('quote', [line(100)], null).amountTTC).toBe(113);
    expect(totalsFromItems('quote', [line(100)], '').amountTTC).toBe(113);
    expect(totalsFromItems('quote', [line(100)], 7).amountTTC).toBe(107);
    expect(totalsFromAmount(100, undefined).amountTTC).toBe(113);
  });

  it('refuses an empty document, a line without a label, a quantity or a price that cannot be', () => {
    expect(refusal(() => totalsFromItems('quote', [], 19))).toBe('Le devis doit contenir au moins une ligne.');
    expect(refusal(() => totalsFromItems('invoice', undefined, 19))).toBe('La facture doit contenir au moins une ligne.');
    expect(refusal(() => totalsFromItems('quote', [line(1, 1, '  ')], 19))).toBe('Chaque ligne du devis doit avoir un libellé.');
    expect(refusal(() => totalsFromItems('invoice', [line(1, 1, '')], 19))).toBe('Chaque ligne de facture doit avoir un libellé.');

    for (const quantity of [0, -1, NaN, 'abc', null, undefined, '']) {
      expect(refusal(() => totalsFromItems('quote', [raw({ unitPrice: 1, quantity })], 19))).toBe('La quantité doit être supérieure à 0.');
    }

    for (const price of [-0.001, NaN, 'abc', null, undefined, '', Infinity]) {
      expect(refusal(() => totalsFromItems('quote', [raw({ unitPrice: price, quantity: 1 })], 19))).toBe('Le prix unitaire doit être supérieur ou égal à 0.');
    }

    expect(totalsFromItems('quote', [line(0)], 19).amountTTC).toBe(0);
  });

  it('refuses a rate that is not a percent of two decimals, in the words of the document', () => {
    expect(refusal(() => totalsFromItems('quote', [line(1)], -1))).toBe('Le taux de TVA doit être supérieur ou égal à 0.');
    expect(refusal(() => totalsFromItems('quote', [line(1)], 'abc'))).toBe('Le taux de TVA doit être supérieur ou égal à 0.');
    expect(refusal(() => totalsFromItems('invoice', [line(1)], -1, 'Taux de TVA invalide.'))).toBe('Taux de TVA invalide.');
    expect(refusal(() => totalsFromItems('quote', [line(1)], 100.5))).toContain('entre 0 et 100');
    expect(refusal(() => totalsFromItems('quote', [line(1)], 19.005))).toContain('deux décimales');
    expect(totalsFromItems('quote', [line(100)], 7.5).taxAmount).toBe(7.5);
    expect(totalsFromItems('quote', [line(100)], '19').taxRate).toBe(19);
  });

  it('reads the rate of a row (a Decimal), and takes a blank rate for no rate, but never a list or a flag for 0 %', () => {
    const decimalRate = { constructor: { name: 'Decimal' }, toNumber: () => 19, toString: () => '19' };

    expect(totalsFromItems('quote', [line(100)], decimalRate).taxAmount).toBe(19);
    expect(totalsFromAmount(100, decimalRate).amountTTC).toBe(119);
    expect(requestTaxRate('   ', 'bad')).toBe(19);
    expect(requestTaxRate(undefined, 'bad')).toBe(19);
    expect(refusal(() => requestTaxRate([], 'bad'))).toBe('bad');
    expect(refusal(() => requestTaxRate(true, 'bad'))).toBe('bad');
    expect(refusal(() => requestTaxRate({}, 'bad'))).toBe('bad');
  });

  it('adds thousands of lines without spreading them into arguments', () => {
    const lines = new Array(150_000).fill(0).map(() => line(0.001));

    expect(totalsFromItems('invoice', lines, 0).amountHT).toBe(150);
  });

  it('refuses an amount a column cannot hold', () => {
    expect(refusal(() => totalsFromItems('quote', [line(99999999999.999, 2)], 19))).toBe('Le montant dépasse le maximum autorisé.');
    expect(refusal(() => totalsFromItems('quote', [line(90000000000)], 19))).toBe('Le montant dépasse le maximum autorisé.');
    expect(refusal(() => totalsFromAmount(99999999999, 19))).toBe('Le montant dépasse le maximum autorisé.');
    expect(totalsFromItems('quote', [line(99999999999.999)], 0).amountTTC).toBe(99999999999.999);
  });

  it('the totals of an amount without tax (an invoice made from a quote)', () => {
    expect(totalsFromAmount(12.345, 0)).toEqual({ amountHT: 12.345, taxRate: 0, taxAmount: 0, amountTTC: 12.345 });
    expect(totalsFromAmount({ toString: () => '12.345' }, 19)).toEqual({ amountHT: 12.345, taxRate: 19, taxAmount: 2.346, amountTTC: 14.691 });

    for (const bad of [0, -1, null, undefined, 'abc', NaN]) {
      expect(refusal(() => totalsFromAmount(bad, 19))).toBe('Montant HT invalide.');
    }

    expect(refusal(() => totalsFromAmount(1, -3))).toBe('Taux de TVA invalide.');
  });

  it('a person-typed amount is a refusal, never a quiet zero', () => {
    expect(requestAmount('12.345', 'x')).toBe(12.345);
    expect(refusal(() => requestAmount('abc', 'not an amount'))).toBe('not an amount');
    expect(refusal(() => requestAmount(null, 'not an amount'))).toBe('not an amount');
    expect(requestTaxRate(undefined, 'x')).toBe(19);
    expect(requestTaxRate(7, 'x', 19)).toBe(7);
    expect(requestTaxRate(undefined, 'x', '13')).toBe(13);
  });
});
