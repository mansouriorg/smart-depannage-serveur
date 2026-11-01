import { INTL_TAGS, formatMessage, isolate, messageArguments } from '../i18n';
import { MESSAGES, MessageDef, allMessages, notice, reference, say } from './index';

const FSI = '⁨';
const PDI = '⁩';

const entries = allMessages();

/** The values a caller writes before the message sees them (an amount, a moment, a length of time, a sentence): never isolated twice. */
const PRE_WRITTEN = new Set(['amount', 'sum', 'when', 'lead', 'count', 'hours', 'minutes', 'greeting', 'next', 'what']);

/**
 * A link is never set apart: a phone makes it tappable by the characters around it, and the marks of an
 * isolate that sit against the address can become part of what is opened (a one-time token that ends with an invisible mark is refused).
 * A link comes after a colon at the end of a line, where the direction of the text already leaves it readable.
 * Nor is a one-time code: it is six digits that the person reads and copies from a plain SMS, and an invisible mark around them
 * can follow the copy into the field that takes the code. Digits are left to right in any case.
 */
const NEVER_ISOLATED = new Set(['link', 'code']);

/** The only Latin words an Arabic text may keep (BRIEF-COMMON): the brand and the names of things that have no Arabic name. */
const LATIN_ALLOWED = /Smart-Dépannage|SMS|GPS|PDF|IBAN|QR|OTP|WhatsApp|Google|Apple|Maps|Waze/g;

/** Words the glossary bans for the customer, the technician and the job. */
const BANNED = ['الزبون', 'الحريف', 'الحرفي', 'العملية', 'تقني'];

/** Values to put in a message to read its words alone: Arabic text for every value, so that any Latin left is the message's own. */
function arabicValues(definition: MessageDef<any>, count = 2): Record<string, string | number> {
  const values: Record<string, string | number> = {};

  for (const name of messageArguments(definition.ar)) values[name] = name === 'count' ? count : 'س';

  return values;
}

describe('the messages of P3-04 exist in both languages', () => {
  it('there are messages, in the areas of the product', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(Object.keys(MESSAGES).sort()).toEqual([
      'application',
      'appointment',
      'auth',
      'chat',
      'complaint',
      'guest',
      'invoice',
      'mission',
      'offer',
      'payment',
      'quote',
    ]);
  });

  it('counts per area (a message added or dropped is a decision, so it shows here)', () => {
    const count = (area: string) => entries.filter((entry) => entry.area === area).length;

    expect({
      appointment: count('appointment'),
      application: count('application'),
      auth: count('auth'),
      chat: count('chat'),
      complaint: count('complaint'),
      guest: count('guest'),
      invoice: count('invoice'),
      mission: count('mission'),
      offer: count('offer'),
      payment: count('payment'),
      quote: count('quote'),
    }).toEqual({ appointment: 5, application: 11, auth: 21, chat: 3, complaint: 4, guest: 8, invoice: 5, mission: 39, offer: 2, payment: 6, quote: 7 });
    expect(entries.length).toBe(111);
  });

  it('keys are unique and each message has a text in French and in Arabic', () => {
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);

    for (const { key, definition } of entries) {
      expect(typeof definition.fr).toBe('string');
      expect(typeof definition.ar).toBe('string');
      expect(`${key}: ${definition.fr.trim() === ''}`).toBe(`${key}: false`);
      expect(`${key}: ${definition.ar.trim() === ''}`).toBe(`${key}: false`);
    }
  });

  it('both languages take the same values', () => {
    for (const { key, definition } of entries) {
      expect(`${key}: ${messageArguments(definition.ar).join(',')}`).toBe(`${key}: ${messageArguments(definition.fr).join(',')}`);
    }
  });

  it('every text is a message the formatter reads (a mistake in the braces throws here, not in a customer’s SMS)', () => {
    for (const { definition } of entries) {
      expect(typeof formatMessage('fr', definition.fr, valuesOf(definition))).toBe('string');
      expect(typeof formatMessage('ar', definition.ar, valuesOf(definition))).toBe('string');
    }
  });

  function valuesOf(definition: MessageDef<any>) {
    return arabicValues(definition);
  }

  it('no message uses a form the website and the app cannot read: no #, no tags, no spaces at the ends', () => {
    for (const { key, definition } of entries) {
      for (const language of ['fr', 'ar'] as const) {
        const text = definition[language];

        expect(`${key}.${language}: ${/[#<>]/.test(text)}`).toBe(`${key}.${language}: false`);
        expect(`${key}.${language}: ${text !== text.trim()}`).toBe(`${key}.${language}: false`);
        expect(`${key}.${language}: ${/ {2}/.test(text)}`).toBe(`${key}.${language}: false`);
      }
    }
  });

  it('a value that is not already written for the reader is set apart in Arabic (and a value written by the caller is not set apart twice)', () => {
    for (const { key, definition } of entries) {
      const flagged = definition.isolate ?? [];
      const names = messageArguments(definition.ar);

      for (const name of flagged) expect(`${key}: ${name} is a value of the message ${names.includes(name)}`).toBe(`${key}: ${name} is a value of the message true`);

      for (const name of names) {
        if (PRE_WRITTEN.has(name) || NEVER_ISOLATED.has(name)) {
          expect(`${key}: ${name} flagged ${flagged.includes(name as never)}`).toBe(`${key}: ${name} flagged false`);
        } else {
          expect(`${key}: ${name} flagged ${flagged.includes(name as never)}`).toBe(`${key}: ${name} flagged true`);
        }
      }
    }
  });
});

describe('the Arabic is Arabic', () => {
  it('every Arabic text has Arabic letters, and no French word (only the brand and the few names the brief allows)', () => {
    for (const { key, definition } of entries) {
      for (let count = 0; count < 3; count += 1) {
        const text = say(definition, 'ar', arabicValues(definition, [1, 2, 5][count]) as never);
        const bare = text.replace(LATIN_ALLOWED, '');

        expect(`${key}: ${/[؀-ۿ]/.test(text)}`).toBe(`${key}: true`);
        expect(`${key}: ${(/[A-Za-zÀ-ÿ]/.exec(bare) ?? [''])[0]}`).toBe(`${key}: `);
      }
    }
  });

  it('Arabic punctuation (، and ؟), Latin digits, and none of the banned words', () => {
    for (const { key, definition } of entries) {
      const text = say(definition, 'ar', arabicValues(definition) as never);

      expect(`${key}: ${/[,?]/.test(text)}`).toBe(`${key}: false`);
      expect(`${key}: ${/[٠-٩۰-۹]/.test(text)}`).toBe(`${key}: false`);
      expect(`${key}: ${/'/.test(definition.ar)}`).toBe(`${key}: false`);

      for (const word of BANNED) expect(`${key}: ${text.includes(word)}`).toBe(`${key}: false`);
    }
  });

  it('an Arabic plural has the six forms of the language (one, two, few, many, other)', () => {
    const plurals = entries.filter((entry) => entry.definition.ar.includes('plural'));

    expect(plurals.length).toBeGreaterThan(0);

    for (const { key, definition } of plurals) {
      for (const form of ['one', 'two', 'few', 'many', 'other']) {
        expect(`${key}: ${definition.ar.includes(`${form}{`)}`).toBe(`${key}: true`);
      }
    }
  });

  it('a length of time is said the way Arabic says it: 1, 2, 3 to 10, 11 and more', () => {
    const minutes = MESSAGES.appointment.lead.minutes;
    const hours = MESSAGES.appointment.lead.hours;

    expect(say(minutes, 'ar', { count: 1 })).toBe('دقيقة');
    expect(say(minutes, 'ar', { count: 2 })).toBe('دقيقتين');
    expect(say(minutes, 'ar', { count: 5 })).toBe('5 دقائق');
    expect(say(minutes, 'ar', { count: 30 })).toBe('30 دقيقة');
    expect(say(hours, 'ar', { count: 2 })).toBe('ساعتين');
    expect(say(hours, 'ar', { count: 3 })).toBe('3 ساعات');
    expect(say(hours, 'ar', { count: 12 })).toBe('12 ساعة');
  });

  it('uses the words of the glossary: العميل for the customer, فنّي for the technician, عرض السعر for the quote', () => {
    expect(say(MESSAGES.quote.accepted.message, 'ar', { ref: '#12' })).toContain('العميل');
    expect(say(MESSAGES.quote.sent.title, 'ar')).toContain('عرض سعر');
    expect(say(MESSAGES.mission.assigned.clientTitle, 'ar')).toContain('فنّي');
  });
});

describe('values in an Arabic sentence', () => {
  it('a name, an address, a number, a link or a code is set apart in Arabic and written as it is in French', () => {
    const params = { ref: '#12', link: 'https://example.test/l/abc' };

    expect(say(MESSAGES.guest.tracking.sms, 'fr', params)).toBe(
      'Smart Dépannage: votre demande #12 est enregistrée. Suivez-la ici: https://example.test/l/abc',
    );
    expect(say(MESSAGES.guest.tracking.sms, 'ar', params)).toBe(
      `تم تسجيل طلبك ${FSI}#12${PDI} في Smart-Dépannage. تتبّعه من هنا: https://example.test/l/abc`,
    );
  });

  it('a link is written bare in Arabic, whichever message carries it: no mark of direction touches the address', () => {
    const link = 'https://www.smart-depannage.tn/x?token=0123456789abcdef';
    const withLink = entries.filter(({ definition }) => messageArguments(definition.ar).includes('link'));

    expect(withLink.length).toBeGreaterThanOrEqual(11);

    for (const { key, definition } of withLink) {
      const values: Record<string, string | number> = {};

      for (const name of messageArguments(definition.ar)) values[name] = name === 'link' ? link : name === 'count' ? 2 : 'س';

      const text = say(definition, 'ar', values as never);

      expect(`${key}: ${text.includes(link)}`).toBe(`${key}: true`);
      expect(`${key}: ${text.includes(`${FSI}${link}`) || text.includes(`${link}${PDI}`)}`).toBe(`${key}: false`);
    }
  });

  it('the isolate is the one of the shared i18n module', () => {
    expect(say(MESSAGES.mission.accepted.smsNamed, 'ar', { name: 'Ali' })).toContain(isolate('Ali'));
  });

  it('a value that carries a direction mark cannot close the isolate early', () => {
    const text = say(MESSAGES.mission.accepted.smsNamed, 'ar', { name: `Al${PDI}‮i` });

    expect(text.split(PDI).length).toBe(2);
    expect(text).toContain(`${FSI}Ali${PDI}`);
  });

  it('a value that is missing is nothing, never the word undefined, and is not wrapped in an empty isolate', () => {
    const text = say(MESSAGES.mission.accepted.smsNamed, 'ar', { name: null as never });

    expect(text).not.toMatch(/undefined|null/);
    expect(text).not.toContain(FSI);
  });

  it('French and Arabic keep a number or an id written by the caller as it came', () => {
    expect(say(MESSAGES.guest.tracking.body, 'fr', { greeting: 'Bonjour,', reference: 12, link: 'L' })).toContain('n°12');
    expect(say(MESSAGES.guest.tracking.body, 'ar', { greeting: 'مرحبًا،', reference: 12, link: 'L' })).toContain(`رقم ${FSI}12${PDI}`);
  });

  it('reference() writes a job number the way a sentence does', () => {
    expect(reference(12)).toBe('#12');
    expect(reference('34')).toBe('#34');
  });

  it('the Arabic tag of a language is the one of the shared module', () => {
    expect(INTL_TAGS.ar).toBe('ar-TN');
  });
});

describe('the Arabic SMS are short (P3-04)', () => {
  // The messages the server texts. An Arabic text goes out as UCS-2: 70 characters per part, 67 once it is cut in several. A limit of
  // 280 characters is at most four parts, and it holds with long values: a long link, a long name, a long address.
  const SMS_KEYS = entries.filter(({ key }) => /(^|\.)(sms|smsNamed|smsAfterStatusChange|smsAfterProof|inviteSms)$/.test(key));

  const WORST_CASE: Record<string, string | number> = {
    link: 'https://www.smart-depannage.tn/guest/activate?token=0123456789abcdef0123456789abcdef0123456789abcdef',
    name: 'Mohamed Ali Ben Abdessalem Trabelsi',
    ref: '#1234567',
    code: '123456',
    amount: '12 345 678,900 د.ت',
    address: '12 rue de Marseille, immeuble Les Jasmins, bloc B, 3e étage, appartement 12, La Marsa, Tunis',
  };

  it('the SMS messages are found: the tracking link, the codes, the invitations, the quote, the end of a job', () => {
    expect(SMS_KEYS.map((entry) => entry.key).sort()).toEqual([
      'application.approved.inviteSms',
      'application.received.sms',
      'auth.passwordSetup.sms',
      'auth.phoneCode.sms',
      'guest.activation.sms',
      'guest.tracking.sms',
      'mission.accepted.sms',
      'mission.accepted.smsNamed',
      'mission.completed.sms',
      'mission.completed.smsAfterProof',
      'mission.completed.smsAfterStatusChange',
      'quote.sent.sms',
    ]);
  });

  it('none is longer than 280 characters in Arabic with its values in', () => {
    for (const { key, definition } of SMS_KEYS) {
      const values: Record<string, string | number> = {};

      for (const name of messageArguments(definition.ar)) values[name] = WORST_CASE[name] ?? 'x';

      const text = say(definition, 'ar', values as never);

      expect(`${key}: ${text.length <= 280}`).toBe(`${key}: true`);
    }
  });

  it('an Arabic SMS begins with Arabic, and says who it is from', () => {
    for (const { key, definition } of SMS_KEYS) {
      const text = say(definition, 'ar', arabicValues(definition) as never);

      expect(`${key}: ${/^[؀-ۿ]/.test(text)}`).toBe(`${key}: true`);
      expect(`${key}: ${text.includes('Smart-Dépannage')}`).toBe(`${key}: ${definition.ar.includes('Smart-Dépannage')}`);
    }
  });
});

describe('notice(): a title and a text in the language of whoever reads it', () => {
  const sample = notice((locale) => ({
    title: say(MESSAGES.quote.sent.title, locale),
    message: say(MESSAGES.quote.sent.message, locale, { amount: '120,000 TND' }),
  }));

  it('title and message are the French ones, as callers always passed them', () => {
    expect(sample.title).toBe('Devis reçu');
    expect(sample.message).toBe('Un devis de 120,000 TND TTC vous a été envoyé.');
  });

  it('texts() writes the same notice in the language asked for', () => {
    expect(sample.texts('fr')).toEqual({ title: 'Devis reçu', message: 'Un devis de 120,000 TND TTC vous a été envoyé.' });
    expect(sample.texts('ar').title).toBe('وصلك عرض سعر');
    expect(sample.texts('ar').message).toContain('120,000 TND');
  });
});
