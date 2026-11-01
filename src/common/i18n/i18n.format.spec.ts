import { INTL_TAGS, formatMessage, forgetPluralRules, messageArguments, pluralFormOf } from './i18n';

describe('putting values into a message (P3-04)', () => {
  it('a message with no value is returned as it is', () => {
    expect(formatMessage('fr', 'Merci de votre confiance.')).toBe('Merci de votre confiance.');
    expect(formatMessage('ar', 'شكرا لثقتكم.')).toBe('شكرا لثقتكم.');
  });

  it('values go where they are named, in either language, numbers as plain digits', () => {
    expect(formatMessage('fr', 'Bonjour {name}, il y a {n} messages.', { name: 'Sami', n: 1234 })).toBe('Bonjour Sami, il y a 1234 messages.');
    expect(formatMessage('ar', 'مرحبا {name}، لديك {n} رسائل', { name: 'سامي', n: 12 })).toBe('مرحبا سامي، لديك 12 رسائل');
  });

  it('a value that is missing, null or undefined is nothing, never the word undefined', () => {
    expect(formatMessage('fr', 'A{x}B{y}C{z}', { x: null, y: undefined })).toBe('ABC');
  });

  it('the same value can be used twice, and a zero is a zero', () => {
    expect(formatMessage('fr', '{n} et {n}', { n: 0 })).toBe('0 et 0');
  });

  it('a template that was already parsed gives the same answer the second time', () => {
    const template = 'Code: {code}';

    expect(formatMessage('fr', template, { code: '1234' })).toBe('Code: 1234');
    expect(formatMessage('fr', template, { code: '9999' })).toBe('Code: 9999');
  });

  describe('plural forms', () => {
    const photos = '{count, plural, =0{Aucune photo} one{{count} photo} other{{count} photos}}';

    it('French: 0 is the exact form, 1 is one, the rest other', () => {
      expect(formatMessage('fr', photos, { count: 0 })).toBe('Aucune photo');
      expect(formatMessage('fr', photos, { count: 1 })).toBe('1 photo');
      expect(formatMessage('fr', photos, { count: 2 })).toBe('2 photos');
      expect(formatMessage('fr', photos, { count: 40 })).toBe('40 photos');
    });

    it('French: without an exact zero, 0 reads as one (a French zero is singular)', () => {
      expect(formatMessage('fr', '{n, plural, one{{n} heure} other{{n} heures}}', { n: 0 })).toBe('0 heure');
    });

    const arabic = '{count, plural, =0{لا توجد صور} one{صورة واحدة} two{صورتان} few{{count} صور} many{{count} صورة} other{{count} صورة}}';

    it('Arabic: one, two, few (3 to 10), many (11 to 99), other (100 and the like)', () => {
      expect(formatMessage('ar', arabic, { count: 0 })).toBe('لا توجد صور');
      expect(formatMessage('ar', arabic, { count: 1 })).toBe('صورة واحدة');
      expect(formatMessage('ar', arabic, { count: 2 })).toBe('صورتان');
      expect(formatMessage('ar', arabic, { count: 3 })).toBe('3 صور');
      expect(formatMessage('ar', arabic, { count: 10 })).toBe('10 صور');
      expect(formatMessage('ar', arabic, { count: 11 })).toBe('11 صورة');
      expect(formatMessage('ar', arabic, { count: 99 })).toBe('99 صورة');
      expect(formatMessage('ar', arabic, { count: 100 })).toBe('100 صورة');
      expect(formatMessage('ar', arabic, { count: 103 })).toBe('103 صور');
    });

    it('a number given as text counts the same; a text that is not a number takes the other form', () => {
      expect(formatMessage('fr', photos, { count: '1' })).toBe('1 photo');
      expect(formatMessage('fr', photos, { count: 'beaucoup' })).toBe('beaucoup photos');
      expect(formatMessage('fr', photos, {})).toBe(' photos');
    });

    it('a form the language does not have is skipped for other', () => {
      expect(formatMessage('fr', '{n, plural, one{un} other{plusieurs}}', { n: 5 })).toBe('plusieurs');
    });

    it('plural forms can sit inside a longer sentence, with values around them', () => {
      expect(formatMessage('fr', 'Vous avez {n, plural, one{{n} visite} other{{n} visites}} prévues, {name}.', { n: 3, name: 'Ali' })).toBe(
        'Vous avez 3 visites prévues, Ali.',
      );
    });
  });

  describe('apostrophes and braces', () => {
    it('a lone apostrophe is an apostrophe, and two are one', () => {
      expect(formatMessage('fr', "l'adresse d''un client")).toBe("l'adresse d'un client");
    });

    it("'{' and '}' write those characters", () => {
      expect(formatMessage('fr', "Écrivez '{code}' tel quel, puis {code}", { code: 'X' })).toBe('Écrivez {code} tel quel, puis X');
    });
  });

  describe('what is refused', () => {
    it.each([
      { name: 'an unclosed value', template: 'Bonjour {name' },
      { name: 'a closing brace alone', template: 'Bonjour }' },
      { name: 'a name with a dash', template: '{a-b}' },
      { name: 'a format other than plural', template: '{n, number}' },
      { name: 'a select', template: '{g, select, a{x} other{y}}' },
      { name: 'a plural with no other form', template: '{n, plural, one{un}}' },
      { name: 'an unknown plural form', template: '{n, plural, few2{un} other{x}}' },
      { name: 'a plural with no braces', template: '{n, plural, one}' },
    ])('$name', ({ template }) => {
      expect(() => formatMessage('fr', template, { name: 'x', n: 1 })).toThrow();
    });
  });

  describe('the values a message takes', () => {
    it('lists them sorted, once each, inside plural forms too', () => {
      expect(messageArguments('{b} {a} {b}')).toEqual(['a', 'b']);
      expect(messageArguments('{n, plural, one{{n} visite chez {name}} other{{n} visites}}')).toEqual(['n', 'name']);
      expect(messageArguments('Aucune valeur.')).toEqual([]);
    });
  });
});

describe('plural forms in an engine that has no Intl.PluralRules (P3-04)', () => {
  const NUMBERS = [...Array.from({ length: 1300 }, (_, i) => i), 1e4, 1e5 + 1, 1e6, 1e6 + 2, 0.5, 1.5, 2.5, 11.5, -1, -2, -11, NaN];

  it('gives the form that Intl gives, for both languages, over the numbers of the product and a few strange ones', () => {
    for (const locale of ['fr', 'ar'] as const) {
      const real = new Intl.PluralRules(INTL_TAGS[locale]);

      for (const n of NUMBERS) {
        const expected = real.select(n);
        const got = pluralFormOf(locale, n);

        // CLDR also has "many" for French millions; no French message uses it, and "other" is what a message without it falls back to.
        if (locale === 'fr' && expected === 'many') continue;

        expect(`${locale} ${n}: ${got}`).toBe(`${locale} ${n}: ${expected}`);
      }
    }
  });

  const arabic = '{count, plural, =0{لا توجد صور} one{صورة واحدة} two{صورتان} few{{count} صور} many{{count} صورة} other{{count} صورة}}';
  const french = '{n, plural, one{{n} jour} other{{n} jours}}';

  function withoutIntlPluralRules(run: () => void): void {
    const original = Intl.PluralRules;

    forgetPluralRules();
    (Intl as unknown as { PluralRules: unknown }).PluralRules = undefined;

    try {
      run();
    } finally {
      (Intl as unknown as { PluralRules: unknown }).PluralRules = original;
      forgetPluralRules();
    }
  }

  it('a message with a plural is still drawn, in French and in Arabic', () => {
    withoutIntlPluralRules(() => {
      expect(formatMessage('fr', french, { n: 1 })).toBe('1 jour');
      expect(formatMessage('fr', french, { n: 3 })).toBe('3 jours');
      expect(formatMessage('ar', arabic, { count: 2 })).toBe('صورتان');
      expect(formatMessage('ar', arabic, { count: 5 })).toBe('5 صور');
      expect(formatMessage('ar', arabic, { count: 11 })).toBe('11 صورة');
      expect(formatMessage('ar', arabic, { count: 100 })).toBe('100 صورة');
    });
  });

  it('an engine that has the object but not the language falls back the same way', () => {
    const original = Intl.PluralRules;

    forgetPluralRules();
    (Intl as unknown as { PluralRules: unknown }).PluralRules = function () {
      throw new RangeError('Incorrect locale information provided');
    };

    try {
      expect(formatMessage('ar', arabic, { count: 3 })).toBe('3 صور');
      expect(formatMessage('fr', french, { n: 2 })).toBe('2 jours');
    } finally {
      (Intl as unknown as { PluralRules: unknown }).PluralRules = original;
      forgetPluralRules();
    }
  });

  it('an engine that has the rules is believed, not replaced by the fallback', () => {
    const original = Intl.PluralRules;

    forgetPluralRules();
    (Intl as unknown as { PluralRules: unknown }).PluralRules = function () {
      return { select: () => 'other' };
    };

    try {
      // The fallback would say "few" for 3 in Arabic and "one" for 1 in French; the engine here says "other" for everything.
      expect(formatMessage('ar', arabic, { count: 3 })).toBe('3 صورة');
      expect(formatMessage('fr', french, { n: 1 })).toBe('1 jours');
    } finally {
      (Intl as unknown as { PluralRules: unknown }).PluralRules = original;
      forgetPluralRules();
    }
  });

  it('with the real Intl back, the real rules are used again', () => {
    forgetPluralRules();

    expect(formatMessage('ar', arabic, { count: 5 })).toBe('5 صور');
  });
});
