import {
  DEFAULT_LOCALE,
  DEFAULT_TAX_RATES,
  applyLocale,
  currencyCode,
  getLocale,
  isValidCurrency,
  isValidRate,
  isValidTimeZone,
  loadedLocale,
  parseTaxRates,
  resetLocale,
  resolveLocale,
  TaxRateOption,
} from './locale';
import { normalizeMatriculeFiscal, normalizeRib } from './company-identity';
import { getBusinessTimeZone } from '../../config/env';

describe('the locale of the business (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('answers for Tunisia until the settings are read', () => {
    expect(loadedLocale()).toBeNull();
    expect(getLocale().currency).toBe('TND');
    expect(getLocale().timeZone).toBe('Africa/Tunis');
    expect(getLocale().defaultTaxRate).toBe(19);
    expect(getLocale().taxRates.map((rate) => rate.rate)).toEqual([19, 13, 7, 0]);
    expect(currencyCode()).toBe('TND');
    expect(DEFAULT_TAX_RATES.length).toBe(4);
  });

  it('the defaults cannot be changed by a caller', () => {
    expect(Object.isFrozen(DEFAULT_LOCALE)).toBe(true);

    try {
      (DEFAULT_LOCALE as { currency: string }).currency = 'EUR';
    } catch {
      // A frozen object refuses the write, loudly in strict mode and silently otherwise.
    }

    expect(DEFAULT_LOCALE.currency).toBe('TND');
    expect(getLocale().currency).toBe('TND');

    const applied = applyLocale({ currency: 'EUR' });

    expect(() => applied.taxRates.push({ code: 'X', label: 'x', rate: 1 })).toThrow();
    expect(() => (DEFAULT_TAX_RATES as TaxRateOption[]).push({ code: 'X', label: 'x', rate: 1 })).toThrow();
    expect(Object.isFrozen(applied.taxRates[0])).toBe(true);
    expect(getLocale().taxRates.length).toBe(4);
    expect(DEFAULT_TAX_RATES.length).toBe(4);
  });

  it('validates a currency, a time zone and a rate', () => {
    expect(isValidCurrency('TND')).toBe(true);
    expect(isValidCurrency('tnd')).toBe(false);
    expect(isValidCurrency('TNDD')).toBe(false);
    expect(isValidCurrency(5)).toBe(false);
    expect(isValidTimeZone('Africa/Tunis')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidRate(19)).toBe(true);
    expect(isValidRate(7.5)).toBe(true);
    expect(isValidRate(0)).toBe(true);
    expect(isValidRate(100)).toBe(true);
    expect(isValidRate(100.01)).toBe(false);
    expect(isValidRate(-1)).toBe(false);
    expect(isValidRate(19.005)).toBe(false);
    expect(isValidRate(NaN)).toBe(false);
    expect(isValidRate('19')).toBe(false);
  });

  it('a list of rates is taken whole or refused whole', () => {
    expect(parseTaxRates([{ code: 'A', label: ' Un ', rate: 5 }])).toEqual([{ code: 'A', label: 'Un', rate: 5 }]);
    expect(parseTaxRates([{ code: 'A', rate: 5 }])[0].label).toBe('5 %');
    expect(() => parseTaxRates([])).toThrow('at least one rate');
    expect(() => parseTaxRates('x')).toThrow('at least one rate');
    expect(() => parseTaxRates([null])).toThrow('an object');
    expect(() => parseTaxRates([{ code: 'a b', rate: 5 }])).toThrow('code');
    expect(() => parseTaxRates([{ code: 'A', rate: 5 }, { code: 'A', rate: 6 }])).toThrow('twice');
    expect(() => parseTaxRates([{ code: 'A', rate: 101 }])).toThrow('rate');
    expect(() => parseTaxRates([{ code: 'A', rate: '5' }])).toThrow('rate');
  });

  it('applies the settings and keeps the missing ones as they were', () => {
    applyLocale({ currency: 'EUR', timezone: 'Europe/Paris', defaultTaxRate: 20, taxRates: [{ code: 'STANDARD', label: 'TVA 20 %', rate: 20 }] });
    expect(loadedLocale()?.currency).toBe('EUR');
    expect(getLocale().timeZone).toBe('Europe/Paris');
    expect(getLocale().defaultTaxRate).toBe(20);

    applyLocale({ currency: 'TND' });
    expect(getLocale().currency).toBe('TND');
    expect(getLocale().timeZone).toBe('Europe/Paris');
    expect(getLocale().taxRates.length).toBe(1);
  });

  it('the default rate must be one of the rates of the list', () => {
    expect(() => applyLocale({ defaultTaxRate: 20 })).toThrow('not one of the rates');
    expect(() => applyLocale({ taxRates: [{ code: 'A', rate: 5 }] })).toThrow('not one of the rates');
    expect(loadedLocale()).toBeNull();
    expect(getLocale().defaultTaxRate).toBe(19);
  });

  it('a refused value changes nothing at all', () => {
    applyLocale({ currency: 'EUR' });

    for (const bad of [{ currency: 'euro' }, { timezone: 'Nowhere/City' }, { defaultTaxRate: 'abc' }, { defaultTaxRate: 150 }, { taxRates: 'x' }]) {
      expect(() => applyLocale({ currency: 'USD', ...bad } as never)).toThrow();
      expect(getLocale().currency).toBe('EUR');
    }
  });

  it('resolveLocale checks without applying', () => {
    expect(resolveLocale({ currency: 'EUR' }).currency).toBe('EUR');
    expect(getLocale().currency).toBe('TND');
    expect(loadedLocale()).toBeNull();
    expect(() => resolveLocale({ currency: 'x' })).toThrow('currency');
    expect(resolveLocale({ defaultTaxRate: '13' }).defaultTaxRate).toBe(13);
    expect(resolveLocale({ defaultTaxRate: { toString: () => '7' } }).defaultTaxRate).toBe(7);
  });

  it('the business time zone is the one of the settings once they are read, else the variable, else Tunis', () => {
    const before = process.env.BUSINESS_TIMEZONE;

    try {
      delete process.env.BUSINESS_TIMEZONE;
      expect(getBusinessTimeZone()).toBe('Africa/Tunis');
      process.env.BUSINESS_TIMEZONE = 'Europe/Paris';
      expect(getBusinessTimeZone()).toBe('Europe/Paris');
      applyLocale({ timezone: 'Africa/Casablanca' });
      expect(getBusinessTimeZone()).toBe('Africa/Casablanca');
      resetLocale();
      expect(getBusinessTimeZone()).toBe('Europe/Paris');
    } finally {
      if (before === undefined) delete process.env.BUSINESS_TIMEZONE;
      else process.env.BUSINESS_TIMEZONE = before;
    }
  });
});

describe('what an invoice prints about the company (P2-01)', () => {
  it('writes a RIB as 20 digits', () => {
    expect(normalizeRib('08 006 0123456789012 34')).toBe('08006012345678901234');
    expect(normalizeRib('08-006-0123456789012-34')).toBe('08006012345678901234');
    expect(normalizeRib('12345678901234567890')).toBe('12345678901234567890');
    expect(() => normalizeRib('1234')).toThrow('20 digits');
    expect(() => normalizeRib('1234567890123456789A')).toThrow('20 digits');
    expect(() => normalizeRib('123456789012345678901')).toThrow('20 digits');
  });

  it('writes a matricule fiscal in one spelling and refuses what is not one', () => {
    expect(normalizeMatriculeFiscal('1234567a/m/000')).toBe('1234567A/M/000');
    expect(normalizeMatriculeFiscal(' 1234567 A / M / 000 ')).toBe('1234567A/M/000');
    expect(normalizeMatriculeFiscal('1234567A')).toBe('1234567A');
    // Both notations are in use: the control letter right after the digits, or after a slash.
    expect(normalizeMatriculeFiscal('1234567/a/a/m/000')).toBe('1234567/A/A/M/000');
    expect(normalizeMatriculeFiscal('1234567A/A/M/000')).toBe('1234567A/A/M/000');
    expect(() => normalizeMatriculeFiscal('1234567//A')).toThrow('seven digits');
    expect(() => normalizeMatriculeFiscal('ABC')).toThrow('seven digits');
    expect(() => normalizeMatriculeFiscal('123456A')).toThrow('seven digits');
    expect(() => normalizeMatriculeFiscal('1234567')).toThrow('seven digits');
    expect(() => normalizeMatriculeFiscal("1234567A'; DROP TABLE x")).toThrow('seven digits');
  });
});
