import { resetLocale } from '../../common/locale/locale';
import { PRINTED_SETTINGS, STAMP_DUTY_MAX, assertConfiguredRate, canonicalJson, isConfiguredRate, printedCompanyOf, printedSettingsChanged } from './invoice-legal';

/** What a document prints about the company and when the accountant's confirmation stops holding (P2-07). */
const settings = (extra: Record<string, unknown> = {}) => ({
  companyName: 'Smart-Dépannage SARL',
  companyPhone: '+216 71 000 000',
  companyEmail: 'facturation@smart-depannage.tn',
  companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis',
  matriculeFiscal: '1234567/A/M/000',
  registreCommerce: 'B01234562026',
  rib: '08006012345678901234',
  invoiceLegalMentions: 'SARL au capital de 10 000 TND.',
  paymentTerms: 'Paiement à réception.',
  stampDuty: 1,
  defaultTaxRate: 19,
  taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }],
  invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'),
  ...extra,
});

describe('what is printed about the company', () => {
  it('reads every field from the settings, trimmed', () => {
    expect(printedCompanyOf(settings({ companyAddress: '  12 Avenue  ' }))).toEqual({
      companyName: 'Smart-Dépannage SARL',
      companyPhone: '+216 71 000 000',
      companyEmail: 'facturation@smart-depannage.tn',
      companyAddress: '12 Avenue',
      companyTaxId: '1234567/A/M/000',
      companyRegistre: 'B01234562026',
      companyRib: '08006012345678901234',
      legalMentions: 'SARL au capital de 10 000 TND.',
      paymentTerms: 'Paiement à réception.',
      stampDuty: 1,
      mentionsConfirmed: true,
    });
  });

  it('prints nothing it does not know: no settings, blank texts', () => {
    for (const given of [null, undefined, {}, { companyAddress: '   ', registreCommerce: '', rib: null, invoiceLegalMentions: undefined }]) {
      const printed = printedCompanyOf(given as any);

      expect([printed.companyAddress, printed.companyRegistre, printed.companyRib, printed.legalMentions, printed.paymentTerms, printed.stampDuty, printed.mentionsConfirmed]).toEqual([null, null, null, null, null, 0, false]);
    }
  });

  it('says the mentions are confirmed only when the settings carry the day of the confirmation', () => {
    expect(printedCompanyOf(settings()).mentionsConfirmed).toBe(true);
    expect(printedCompanyOf(settings({ invoiceRulesConfirmedAt: null })).mentionsConfirmed).toBe(false);
  });

  it('reads the stamp duty to the millime', () => {
    expect(printedCompanyOf(settings({ stampDuty: '0.600' })).stampDuty).toBe(0.6);
    expect(printedCompanyOf(settings({ stampDuty: 0.0004 })).stampDuty).toBe(0);
  });
});

describe('which changes take the confirmation away', () => {
  const current = settings();

  it('is every setting a document prints', () => {
    expect([...PRINTED_SETTINGS].sort()).toEqual(
      ['companyAddress', 'companyEmail', 'companyName', 'companyPhone', 'defaultTaxRate', 'invoiceLegalMentions', 'matriculeFiscal', 'paymentTerms', 'registreCommerce', 'rib', 'stampDuty', 'taxRates'].sort(),
    );
  });

  it('is a printed field with another value', () => {
    for (const field of PRINTED_SETTINGS) {
      const other = field === 'stampDuty' ? 2 : field === 'defaultTaxRate' ? 13 : field === 'taxRates' ? [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'REDUCED', label: 'TVA 7 %', rate: 7 }] : 'autre valeur';

      expect(`${field}: ${printedSettingsChanged(current, { [field]: other })}`).toBe(`${field}: true`);
    }
  });

  it('is not the same value again, with other spaces, or the same number written otherwise', () => {
    expect(printedSettingsChanged(current, { companyAddress: ' 12 Avenue Habib Bourguiba, 1001 Tunis ', stampDuty: '1.000', defaultTaxRate: '19' })).toBe(false);
    expect(printedSettingsChanged(current, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }] })).toBe(false);
  });

  it('is not the list of rates again with the keys of each rate in another order (jsonb hands them back in an order of its own)', () => {
    const stored = settings({ taxRates: [{ rate: 19, code: 'STANDARD', label: 'TVA 19 %' }, { rate: 7, label: 'TVA 7 %', code: 'REDUCED' }] });

    expect(printedSettingsChanged(stored, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'REDUCED', label: 'TVA 7 %', rate: 7 }] })).toBe(false);
    // ... but another rate, another label, another order of the rates, or one more rate, is another list.
    expect(printedSettingsChanged(stored, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'REDUCED', label: 'TVA 7 %', rate: 6 }] })).toBe(true);
    expect(printedSettingsChanged(stored, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'REDUCED', label: 'TVA réduite', rate: 7 }] })).toBe(true);
    expect(printedSettingsChanged(stored, { taxRates: [{ code: 'REDUCED', label: 'TVA 7 %', rate: 7 }, { code: 'STANDARD', label: 'TVA 19 %', rate: 19 }] })).toBe(true);
    expect(printedSettingsChanged(stored, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }] })).toBe(true);
  });

  it('is not a field the request leaves out, nor a field no document prints', () => {
    expect(printedSettingsChanged(current, {})).toBe(false);
    expect(printedSettingsChanged(current, { companyAddress: undefined, smsSender: 'AUTRE', paymentMethods: ['CASH'] })).toBe(false);
  });

  it('is a text cleared, or a text given where there was none', () => {
    expect(printedSettingsChanged(current, { registreCommerce: '' })).toBe(true);
    expect(printedSettingsChanged(current, { registreCommerce: null })).toBe(true);
    expect(printedSettingsChanged({ ...current, paymentTerms: null }, { paymentTerms: 'À 30 jours' })).toBe(true);
    expect(printedSettingsChanged({ ...current, paymentTerms: null }, { paymentTerms: '  ' })).toBe(false);
  });
});

describe('the text a structured setting is compared by', () => {
  it('puts the keys of every object in the same order, at every depth, and keeps the order of a list', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[{"x":1,"y":2}]},"b":1}');
    expect(canonicalJson([{ b: 1, a: 2 }, { a: 2, b: 1 }])).toBe('[{"a":2,"b":1},{"a":2,"b":1}]');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('writes a key with no value as it is not there, and a value that is not an object as JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('à "x"')).toBe('"à \\"x\\""');
    expect(canonicalJson(19)).toBe('19');
  });
});

describe('the VAT rate an invoice takes', () => {
  beforeEach(() => resetLocale());

  it('is told apart from one the company does not list, with no refusal to catch', () => {
    for (const rate of [19, 13, 7, 0, '19', '7.0']) expect(isConfiguredRate(rate)).toBe(true);
    for (const rate of [18, 19.5, -1, 'abc', NaN, undefined, null]) expect(`${String(rate)}: ${isConfiguredRate(rate)}`).toBe(`${String(rate)}: false`);
  });

  it('is one of the rates the company lists (19, 13, 7 and 0 by default)', () => {
    for (const rate of [19, 13, 7, 0, '19', '7.0']) assertConfiguredRate(rate);
  });

  it('refuses any other rate, and says which ones are allowed', () => {
    for (const rate of [18, 19.5, -1, 20, '1e1']) {
      let message = '';

      try {
        assertConfiguredRate(rate);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('taux de TVA');
      expect(message).toContain('19 %, 13 %, 7 %, 0 %');
    }
  });

  it('refuses what is not a number', () => {
    let refused = 0;

    for (const rate of [undefined, null, 'abc', NaN]) {
      try {
        assertConfiguredRate(rate);
      } catch {
        refused += 1;
      }
    }

    expect(refused).toBe(4);
  });

  it('holds a stamp duty ceiling that is a typing-error guard, in dinars', () => {
    expect(STAMP_DUTY_MAX).toBe(100);
  });
});
