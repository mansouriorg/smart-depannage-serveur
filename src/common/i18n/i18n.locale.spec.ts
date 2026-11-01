import { DEFAULT_LOCALE, INTL_TAGS, LOCALES, LOCALE_NAMES, bestLocaleOf, directionOf, isLocale, isRtl, isolate, localeOf, localeOrDefault } from './i18n';

describe('the languages of the product (P3-04)', () => {
  it('there are two, French first, and French is the default', () => {
    expect([...LOCALES]).toEqual(['fr', 'ar']);
    expect(DEFAULT_LOCALE).toBe('fr');
  });

  it('Arabic reads right to left and French left to right', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('fr')).toBe('ltr');
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('fr')).toBe(false);
  });

  it('each language has its own name written in itself, and a Tunisian tag for dates and numbers', () => {
    expect(LOCALE_NAMES).toEqual({ fr: 'Français', ar: 'العربية' });
    expect(INTL_TAGS).toEqual({ fr: 'fr-TN', ar: 'ar-TN' });
  });

  it('the Arabic of Tunisia writes the digits 0 to 9 and the months of Tunisia', () => {
    expect(new Intl.NumberFormat(INTL_TAGS.ar, { useGrouping: false }).format(1234)).toBe('1234');
    expect(new Intl.DateTimeFormat(INTL_TAGS.ar, { month: 'long', timeZone: 'UTC' }).format(new Date('2026-01-15T12:00:00Z'))).toBe('جانفي');
  });

  it.each([
    { value: 'fr', expected: 'fr' },
    { value: 'ar', expected: 'ar' },
    { value: 'AR', expected: 'ar' },
    { value: 'ar-TN', expected: 'ar' },
    { value: 'fr_FR', expected: 'fr' },
    { value: ' fr ', expected: 'fr' },
    { value: 'ar-u-nu-latn', expected: 'ar' },
  ])('"$value" names $expected', ({ value, expected }) => {
    expect(localeOf(value)).toBe(expected);
    expect(isLocale(expected)).toBe(true);
  });

  it.each(['en', 'en-US', '', '   ', 'arabic', 'frfr', null, undefined, 12, {}, ['ar']])('%p names no supported language', (value) => {
    expect(localeOf(value)).toBe(null);
    expect(localeOrDefault(value)).toBe('fr');
  });

  it('isLocale accepts only the exact codes', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('AR')).toBe(false);
    expect(isLocale('ar-TN')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('the language a browser asks for', () => {
  it('takes the best weighted language the product speaks', () => {
    expect(bestLocaleOf('en;q=0.8, ar-TN, fr;q=0.9')).toBe('ar');
    expect(bestLocaleOf('fr;q=0.5, ar;q=0.9')).toBe('ar');
    expect(bestLocaleOf('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
  });

  it('on a tie keeps the order of the list', () => {
    expect(bestLocaleOf('ar, fr')).toBe('ar');
    expect(bestLocaleOf('fr, ar')).toBe('fr');
  });

  it('skips languages it does not speak and weights of zero', () => {
    expect(bestLocaleOf('en-US,en;q=0.9,de;q=0.8')).toBe(null);
    expect(bestLocaleOf('ar;q=0, fr;q=0.1')).toBe('fr');
    expect(bestLocaleOf('ar;q=0')).toBe(null);
  });

  it('answers null for nothing', () => {
    expect(bestLocaleOf(null)).toBe(null);
    expect(bestLocaleOf(undefined)).toBe(null);
    expect(bestLocaleOf('')).toBe(null);
    expect(bestLocaleOf('*')).toBe(null);
  });
});

describe('a value set apart in a right-to-left sentence', () => {
  it('is wrapped in the first-strong isolate and its closing mark, and nothing else changes', () => {
    expect(isolate('+216 22 123 456')).toBe('\u2068+216 22 123 456\u2069');
    expect(isolate(12.5)).toBe('\u206812.5\u2069');
  });
});
