import { isolate } from '../i18n';
import { DayOfWeek, PaymentStatus, QuoteStatus, Status } from '../../../../generated/prisma/client';
import { createErrorTranslator, translateErrorText } from './error-text';
import { ERRORS_AR } from './errors.ar';
import { VALUE_WORDS_AR } from './errors.values.ar';

/**
 * The dictionary of Arabic sentences is written like the rest of the Arabic of the product (P3-04): Arabic letters and punctuation, one
 * word for one thing (the glossary), no French in it, and a `{n}` for each value the French sentence has.
 */

const ENTRIES = Object.entries(ERRORS_AR);
const HOLE = '{}';

/** Latin words that Arabic text of the product may hold: the brand, abbreviations, and the names of the picture formats. */
const LATIN_ALLOWED = ['Smart-Dépannage', 'SMS', 'GPS', 'PDF', 'IBAN', 'JPEG', 'PNG', 'WebP', 'HEIC'];

/** The words the glossary bans for the customer, the technician and the job. */
const BANNED = ['الزبون', 'الحريف', 'الحرفي', 'العملية', 'تقني'];

const holesOf = (key: string): number => key.split(HOLE).length - 1;
const referencesOf = (value: string): number[] => [...value.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));

describe('the dictionary of Arabic sentences', () => {
  it('has the sentences of the server, and some to spare for the check below to mean something', () => {
    expect(ENTRIES.length).toBeGreaterThan(400);
  });

  it('writes its keys and values without spaces at the ends or two in a row', () => {
    const bad = ENTRIES.filter(([key, value]) => key !== key.trim() || value !== value.trim() || /\s{2,}/.test(value) || /\s{2,}/.test(key));

    expect(bad.map(([key]) => key)).toEqual([]);
  });

  it('gives every sentence in Arabic letters', () => {
    const bad = ENTRIES.filter(([, value]) => !/[؀-ۿ]/.test(value));

    expect(bad.map(([key]) => key)).toEqual([]);
  });

  it('holds no Latin word but the brand, the abbreviations and the picture formats (a value is a different matter: it is put in at run time)', () => {
    const bad = ENTRIES.filter(([, value]) => {
      const rest = LATIN_ALLOWED.reduce((text, word) => text.split(word).join(' '), value);

      return /[A-Za-zÀ-ÿ]{2,}/.test(rest);
    });

    expect(bad.map(([key, value]) => `${key} => ${value}`)).toEqual([]);
  });

  it('writes digits 0 to 9, and Arabic punctuation (، ؟ ؛), never , ? ; in the Arabic', () => {
    const bad = ENTRIES.filter(([, value]) => /[٠-٩۰-۹]/.test(value) || /[,?;]/.test(value));

    expect(bad.map(([key, value]) => `${key} => ${value}`)).toEqual([]);
  });

  it('uses none of the words the glossary bans', () => {
    const bad = ENTRIES.flatMap(([key, value]) => BANNED.filter((word) => value.includes(word)).map((word) => `${word}: ${key}`));

    expect(bad).toEqual([]);
  });

  it('has as many {n} in the Arabic as holes in the French key, numbered from 1, each one used', () => {
    const bad = ENTRIES.filter(([key, value]) => {
      const wanted = Array.from({ length: holesOf(key) }, (_, index) => index + 1);
      const used = [...new Set(referencesOf(value))].sort((a, b) => a - b);

      return JSON.stringify(used) !== JSON.stringify(wanted);
    });

    expect(bad.map(([key]) => key)).toEqual([]);
  });

  it('has no other brace in the Arabic than the {n}, and no brace in a key that is not a hole', () => {
    const badValues = ENTRIES.filter(([, value]) => /[{}]/.test(value.replace(/\{\d+\}/g, '')));
    const badKeys = ENTRIES.filter(([key]) => /[{}]/.test(key.split(HOLE).join('')));

    expect(badValues.map(([key]) => key)).toEqual([]);
    expect(badKeys.map(([key]) => key)).toEqual([]);
  });

  it('sets apart the dates written inside a sentence, which would otherwise be shown in the order of the right-to-left text', () => {
    const [, value] = ENTRIES.find(([key]) => key.includes('2026-10-31T10:00:00Z')) as [string, string];

    for (const example of ['2026-10-31', '2026-10-31T10:00:00Z']) {
      expect(value).toContain(`\u2068${example}\u2069`);
    }
  });

  it('writes a dinar amount د.ت, not DT or TND', () => {
    const bad = ENTRIES.filter(([, value]) => /\b(DT|TND)\b/.test(value));

    expect(bad.map(([key]) => key)).toEqual([]);
  });

  it('has no two keys that differ only by their holes (a sentence could not tell which one it is)', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];

    for (const [key] of ENTRIES) {
      const shape = key.split(HOLE).join('\u0000');
      const other = seen.get(shape);

      if (other !== undefined) clash.push(`${other} / ${key}`);

      seen.set(shape, key);
    }

    expect(clash).toEqual([]);
  });

  it('translates each of its sentences to its own Arabic (a pattern is found again by the sentence it describes)', () => {
    const wrong: string[] = [];

    for (const [key, value] of ENTRIES) {
      const sample = key.split(HOLE).reduce((text, part, index) => (index === 0 ? part : `${text}${index * 111}${part}`), '');
      const expected = value.replace(/\{(\d+)\}/g, (_, index: string) => isolate(Number(index) * 111));
      const found = translateErrorText(sample);

      if (found !== expected) wrong.push(`${sample} => ${found}`);
    }

    expect(wrong).toEqual([]);
  });
});

describe('the translator', () => {
  it('matches a static sentence exactly, after trim(), and leaves any other text alone', () => {
    const translator = createErrorTranslator({ 'Date invalide.': 'التاريخ غير صالح.' });

    expect(translator.text('Date invalide.')).toBe('التاريخ غير صالح.');
    expect(translator.text('  Date invalide.\n')).toBe('التاريخ غير صالح.');
    expect(translator.text('Date invalide')).toBeNull();
    expect(translator.text('Date invalide. Encore.')).toBeNull();
    expect(translator.text('date invalide.')).toBeNull();
  });

  it('turns a key with holes into an anchored pattern: everything else is literal, a hole is at least one character', () => {
    const translator = createErrorTranslator({ 'Prix (en {} DT) + [{}]?': 'ب {1} و {2}' });

    expect(translator.text('Prix (en 12 DT) + [x]?')).toBe(`ب ${isolate('12')} و ${isolate('x')}`);
    expect(translator.text('Prix (en 12 DT) + []?')).toBeNull();
    expect(translator.text('Prix (en  DT) + [x]?')).toBeNull();
    expect(translator.text('Prix en 12 DT + x')).toBeNull();
    expect(translator.text('Le Prix (en 12 DT) + [x]?')).toBeNull();
    expect(translator.text('Prix (en 12 DT) + [x]? Encore')).toBeNull();
  });

  it('puts the captured values where the Arabic says, in any order, and sets each apart', () => {
    const translator = createErrorTranslator({ 'De {} à {}.': 'إلى {2} من {1}.' });

    expect(translator.text('De A à B.')).toBe(`إلى ${isolate('B')} من ${isolate('A')}.`);
    expect(isolate('B')).toBe('⁨B⁩');
  });

  it('takes the pattern with more fixed text when two fit', () => {
    const translator = createErrorTranslator({
      '{} est obligatoire.': 'عام {1}',
      'Le nom {} est obligatoire.': 'خاص {1}',
    });

    expect(translator.text('Le nom X est obligatoire.')).toBe(`خاص ${isolate('X')}`);
    expect(translator.text('Le prénom est obligatoire.')).toBe(`عام ${isolate('Le prénom')}`);
  });

  it('translates a value that is itself a known sentence or term, a list of terms, and writes the dinar in Arabic', () => {
    const translator = createErrorTranslator({
      'Pièce : {}': 'بطاقة: {1}',
      'Fichier trop gros.': 'الملف كبير.',
      'Parmi: {}.': 'من بين: {1}.',
      Plombier: 'سبّاك',
      Vitrier: 'زجّاج',
      'Il doit {}.': 'عليه {1}.',
    });

    expect(translator.text('Pièce : Fichier trop gros.')).toBe('بطاقة: الملف كبير.');
    expect(translator.text('Parmi: Plombier, Vitrier.')).toBe('من بين: سبّاك، زجّاج.');
    expect(translator.text('Parmi: Plombier, Inconnu.')).toBe(`من بين: ${isolate('Plombier, Inconnu')}.`);
    expect(translator.text('Il doit 1 250,000 TND.')).toBe(`عليه ${isolate('1 250,000')} د.ت.`);
    expect(translator.text('Il doit 12,500 DT.')).toBe(`عليه ${isolate('12,500')} د.ت.`);
  });

  it('a list of terms joined by commas and "et" is joined in Arabic by ، and a و against the last word', () => {
    const translator = createErrorTranslator({
      'D’abord {}.': 'أدخل أولًا: {1}.',
      'le nom': 'الاسم',
      'l’adresse': 'العنوان',
      'le numéro': 'الرقم',
    });

    expect(translator.text('D’abord le nom.')).toBe('أدخل أولًا: الاسم.');
    expect(translator.text('D’abord le nom et l’adresse.')).toBe('أدخل أولًا: الاسم والعنوان.');
    expect(translator.text('D’abord le nom, l’adresse et le numéro.')).toBe('أدخل أولًا: الاسم، العنوان والرقم.');
    expect(translator.text('D’abord le nom, l’adresse, le numéro.')).toBe('أدخل أولًا: الاسم، العنوان، الرقم.');
    // one entry unknown: the whole value is set apart as it came
    expect(translator.text('D’abord le nom et la rue.')).toBe(`أدخل أولًا: ${isolate('le nom et la rue')}.`);
  });

  it('the invoice mentions that are missing are named in Arabic, one by one, as the admin service writes them', () => {
    expect(translateErrorText('Les mentions ne peuvent pas être confirmées : renseignez d’abord le matricule fiscal.')).toBe('لا يمكن تأكيد البيانات القانونية: أدخل أولًا ما يلي: المعرّف الجبائي.');
    expect(translateErrorText('Les mentions ne peuvent pas être confirmées : renseignez d’abord l’adresse et le matricule fiscal.')).toBe('لا يمكن تأكيد البيانات القانونية: أدخل أولًا ما يلي: العنوان والمعرّف الجبائي.');
    expect(translateErrorText('Les mentions ne peuvent pas être confirmées : renseignez d’abord le nom de l’entreprise, l’adresse et le matricule fiscal.')).toBe(
      'لا يمكن تأكيد البيانات القانونية: أدخل أولًا ما يلي: اسم الشركة، العنوان والمعرّف الجبائي.',
    );
  });

  it('the trades are called in a refusal as the apps call them (the shared catalogue, trades.label)', () => {
    const asTheAppsSay: Record<string, string> = {
      Plombier: 'سبّاك',
      Menuisier: 'نجّار',
      Serrurier: 'فنّي أقفال',
      'Électricien': 'كهربائي',
      Chauffagiste: 'فنّي تدفئة',
      Vitrier: 'فنّي زجاج',
      Climaticien: 'فنّي تكييف',
      Autre: 'أخرى',
    };

    for (const [french, arabic] of Object.entries(asTheAppsSay)) expect(`${french}: ${translateErrorText(french)}`).toBe(`${french}: ${arabic}`);
  });

  it('a rate with its percent sign is one left-to-right piece: the sign stays against the figure in a line of Arabic', () => {
    const text = translateErrorText('Le taux de TVA 19 % n’est pas l’un des taux de l’entreprise (7 %).') as string;

    expect(text).toBe(`نسبة الأداء على القيمة المضافة \u2066${isolate('19')} %\u2069 ليست من النسب المعتمدة لدى الشركة (\u2066${isolate('7')} %\u2069).`);
  });

  it('a rate limit says how many minutes are left after a colon, so that no word has to agree with the number', () => {
    expect(translateErrorText('Trop de tentatives. Réessayez dans 12 minutes.')).toBe(`محاولات كثيرة جدًا. أعد المحاولة لاحقًا (الدقائق المتبقية: ${isolate('12')}).`);
  });

  it('a status or a day that a sentence names is its Arabic word, not the code', () => {
    expect(translateErrorText('Vous ne pouvez pas faire passer cette demande de ARTISAN_ARRIVED à CANCELLED.')).toBe('لا يمكنك نقل هذا الطلب من وصل إلى ملغى.');
    expect(translateErrorText('Cette action n’est plus possible: la demande est en statut IN_PROGRESS.')).toBe('لم يعد هذا الإجراء ممكنًا: حالة الطلب هي قيد التنفيذ.');
    expect(translateErrorText('Ce devis ne peut pas être modifié car son statut est ACCEPTED.')).toBe('لا يمكن تعديل عرض السعر هذا لأنّ حالته: مقبول.');
    expect(translateErrorText('Ce paiement ne peut pas être confirmé car son statut est AWAITING_CONFIRMATION.')).toBe('لا يمكن تأكيد هذا الدفع لأنّ حالته: في انتظار التأكيد.');
    expect(translateErrorText('Créneau MONDAY 18:00-08:00: l’heure de fin doit être après l’heure de début.')).toBe(
      `فترة يوم الاثنين: من ${isolate('18:00')} إلى ${isolate('08:00')}، يجب أن يكون وقت النهاية بعد وقت البداية.`,
    );
  });

  it('a code that is not a known word is set apart as it is (a name that happens to look like one stays a name only if it is not exactly one)', () => {
    expect(translateErrorText('Ce devis ne peut pas être modifié car son statut est NOT_A_STATUS.')).toBe(`لا يمكن تعديل عرض السعر هذا لأنّ حالته: ${isolate('NOT_A_STATUS')}.`);
    // inherited names of an object are not words
    expect(translateErrorText('Ce devis ne peut pas être modifié car son statut est constructor.')).toBe(`لا يمكن تعديل عرض السعر هذا لأنّ حالته: ${isolate('constructor')}.`);
    expect(translateErrorText('Ce devis ne peut pas être modifié car son statut est toString.')).toBe(`لا يمكن تعديل عرض السعر هذا لأنّ حالته: ${isolate('toString')}.`);
  });

  it('an amount keeps its figure inside the isolate and the unit outside: a mark that starts with Arabic would reverse the groups of digits', () => {
    const translator = createErrorTranslator({ 'Il doit {}.': 'عليه {1}.' });

    for (const amount of ['1 234,500 TND', '12,500 DT', '-3,000 TND']) {
      const text = translator.text(`Il doit ${amount}.`) as string;
      const inside = text.slice(text.indexOf('\u2068') + 1, text.indexOf('\u2069'));

      expect(`${amount}: ${/[؀-ۿ]/.test(inside)}`).toBe(`${amount}: false`);
      expect(text.endsWith('د.ت.')).toBe(true);
    }
  });

  it('a text longer than any sentence of the dictionary is not matched at all, so that a long value cannot keep the server busy', () => {
    const translator = createErrorTranslator({ 'Le paramètre « {} » doit être compris entre {} et {}.': '{1} {2} {3}' });
    const long = `Le paramètre « ${'é'.repeat(40_000)} » doit être compris entre 1 et`;
    const started = Date.now();

    expect(translator.text(long)).toBe(null);
    expect(translator.text(`${long} 2.`)).toBe(null);
    expect(translator.response({ statusCode: 400, message: long })).toEqual({ statusCode: 400, message: long });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('the longest sentence of the dictionary is far below the limit, and a value of a few hundred characters still translates', () => {
    const longest = Math.max(...ENTRIES.map(([key]) => key.length));

    expect(longest).toBeLessThan(400);

    const translator = createErrorTranslator({ 'Le nom {} est obligatoire.': 'الاسم {1} مطلوب.' });

    expect(translator.text(`Le nom ${'x'.repeat(300)} est obligatoire.`)).toBe(`الاسم ${isolate('x'.repeat(300))} مطلوب.`);
  });

  it('translates sentences written one after the other with a space, only when every one is known', () => {
    const translator = createErrorTranslator({
      'La position est fausse. Reprenez la photo.': 'الموقع خاطئ. أعد التقاط الصورة.',
      'Trop loin ({} m).': 'بعيد جدًا ({1} م).',
      'Photo déjà utilisée.': 'صورة مستخدمة.',
    });

    expect(translator.text('Photo déjà utilisée. Trop loin (30 m). La position est fausse. Reprenez la photo.')).toBe(`صورة مستخدمة. بعيد جدًا (${isolate('30')} م). الموقع خاطئ. أعد التقاط الصورة.`);
    expect(translator.text('Photo déjà utilisée. Inconnue.')).toBeNull();
  });

  it('translates the message of a body, a list of messages and the issues; the same object comes back when nothing is known', () => {
    const translator = createErrorTranslator({ 'Date invalide.': 'التاريخ غير صالح.', 'Occupé.': 'مشغول.' });
    const body = { statusCode: 400, message: ['Date invalide.', 'Autre.'], error: 'Bad Request', issues: ['Occupé.', 'Date invalide.'], retryAfterSeconds: 5 };
    const unknown = { statusCode: 400, message: 'Autre.', error: 'Bad Request' };

    const translated = translator.response(body) as typeof body;

    expect(translated).toEqual({ statusCode: 400, message: ['التاريخ غير صالح.', 'Autre.'], error: 'Bad Request', issues: ['مشغول.', 'التاريخ غير صالح.'], retryAfterSeconds: 5 });
    expect(Object.keys(translated)).toEqual(Object.keys(body));
    expect(body.message).toEqual(['Date invalide.', 'Autre.']);
    expect(translator.response(unknown)).toBe(unknown);
    expect(translator.response('Autre.')).toBe('Autre.');
    expect(translator.response('Date invalide.')).toBe('التاريخ غير صالح.');
  });

  it('leaves alone what is not a sentence or a body', () => {
    const translator = createErrorTranslator({ 'Date invalide.': 'x' });

    expect(translator.response(null)).toBe(null);
    expect(translator.response(undefined)).toBe(undefined);
    expect(translator.response(42)).toBe(42);
    expect(translator.response(['Date invalide.'])).toEqual(['Date invalide.']);
    expect(translator.response({ message: 42, issues: 'Date invalide.x' })).toEqual({ message: 42, issues: 'Date invalide.x' });
  });
});

describe('the words of the codes a sentence can name', () => {
  it('has a word for every status of a job, of a quote and of a payment, and for every day of the week', () => {
    const missing = [...Object.values(Status), ...Object.values(QuoteStatus), ...Object.values(PaymentStatus), ...Object.values(DayOfWeek)].filter((code) => !(code in VALUE_WORDS_AR));

    expect(missing).toEqual([]);
  });

  it('has no word for a code that no enum has any more', () => {
    const codes = new Set<string>([...Object.values(Status), ...Object.values(QuoteStatus), ...Object.values(PaymentStatus), ...Object.values(DayOfWeek)]);

    expect(Object.keys(VALUE_WORDS_AR).filter((code) => !codes.has(code))).toEqual([]);
  });

  it('writes each one in Arabic letters only, without a Latin letter, a banned word or a space at the ends', () => {
    for (const [code, word] of Object.entries(VALUE_WORDS_AR)) {
      expect(`${code}: ${/[؀-ۿ]/.test(word)}`).toBe(`${code}: true`);
      expect(`${code}: ${/[A-Za-zÀ-ÿ]/.test(word)}`).toBe(`${code}: false`);
      expect(`${code}: ${word === word.trim()}`).toBe(`${code}: true`);
      for (const banned of BANNED) expect(`${code}: ${word.includes(banned)}`).toBe(`${code}: false`);
    }
  });

  it('reads a job’s status as the apps do', () => {
    // the words of the phone app and of the website (shared catalogue `status.labels`), which the person sees next to the sentence
    expect(VALUE_WORDS_AR.ARTISAN_ON_THE_WAY).toBe('في الطريق');
    expect(VALUE_WORDS_AR.WAITING_CLIENT_VALIDATION).toBe('في انتظار التأكيد');
    expect(VALUE_WORDS_AR.COMPLETED).toBe('تم الإنجاز');
    expect(VALUE_WORDS_AR.DISPUTED).toBe('نزاع');
  });
});
