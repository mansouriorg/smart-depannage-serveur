import { declaredLocale, localeOfUser, moneyIn, recipientLocale, whenIn } from './index';

const FSI = '⁨';
const PDI = '⁩';

describe('the language a request declares (P3-04)', () => {
  it('reads the header of the apps', () => {
    expect(declaredLocale({ headers: { 'x-app-locale': 'ar' } })).toBe('ar');
    expect(declaredLocale({ headers: { 'x-app-locale': 'fr' } })).toBe('fr');
  });

  it('says nothing when the header is missing, empty or a language the product does not speak', () => {
    expect(declaredLocale({ headers: {} })).toBe(null);
    expect(declaredLocale({})).toBe(null);
    expect(declaredLocale(null)).toBe(null);
    expect(declaredLocale(undefined)).toBe(null);
    expect(declaredLocale({ headers: { 'x-app-locale': '' } })).toBe(null);
    expect(declaredLocale({ headers: { 'x-app-locale': 'en' } })).toBe(null);
    expect(declaredLocale({ headers: { 'x-app-locale': 'de' } })).toBe(null);
  });

  it('reads the language the way localeOf does: a region or a capital letter does not matter', () => {
    expect(declaredLocale({ headers: { 'x-app-locale': 'AR-TN' } })).toBe('ar');
    expect(declaredLocale({ headers: { 'x-app-locale': ' fr_FR ' } })).toBe('fr');
  });

  it('takes the first value when the header came twice', () => {
    expect(declaredLocale({ headers: { 'x-app-locale': ['ar', 'fr'] } })).toBe('ar');
  });
});

describe('the language to write to a person (P3-04)', () => {
  it('a customer or a technician gets the language they chose', () => {
    expect(recipientLocale({ role: 'CLIENT', locale: 'ar' })).toBe('ar');
    expect(recipientLocale({ role: 'ARTISAN', locale: 'ar' })).toBe('ar');
    expect(recipientLocale({ role: 'CLIENT', locale: 'fr' })).toBe('fr');
    expect(recipientLocale({ role: 'ARTISAN', locale: 'fr' })).toBe('fr');
  });

  it('French when they chose none, or when the row says something else', () => {
    expect(recipientLocale({ role: 'CLIENT' })).toBe('fr');
    expect(recipientLocale({ role: 'CLIENT', locale: null })).toBe('fr');
    expect(recipientLocale({ role: 'CLIENT', locale: 'en' })).toBe('fr');
    expect(recipientLocale({ locale: 'ar' })).toBe('ar');
  });

  it('an account that chose none stays French even when the request said Arabic: the request language is for destinations with no account', () => {
    expect(recipientLocale({ role: 'CLIENT' }, 'ar')).toBe('fr');
    expect(recipientLocale({ role: 'CLIENT', locale: null }, 'ar')).toBe('fr');
    expect(recipientLocale({ role: 'ARTISAN', locale: 'en' }, 'ar')).toBe('fr');
  });

  it('every role of the back office is written to in French, even one that stored Arabic', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT']) {
      expect(`${role}: ${recipientLocale({ role, locale: 'ar' })}`).toBe(`${role}: fr`);
    }
  });

  it('nobody known: the language of the request that caused the message, else French', () => {
    expect(recipientLocale(null)).toBe('fr');
    expect(recipientLocale(undefined, 'ar')).toBe('ar');
    expect(recipientLocale(null, 'fr')).toBe('fr');
  });

  it('an account that is known wins over the request: the person chose, the header is only a fallback', () => {
    expect(recipientLocale({ role: 'CLIENT', locale: 'fr' }, 'ar')).toBe('fr');
    expect(recipientLocale({ role: 'CLIENT', locale: 'ar' }, 'fr')).toBe('ar');
  });
});

describe('the language of an account known by its id (P3-04)', () => {
  const dbWith = (row: any) => ({ user: { findUnique: async () => row } });

  it('reads the account', async () => {
    expect(await localeOfUser(dbWith({ role: 'CLIENT', locale: 'ar' }), 5)).toBe('ar');
    expect(await localeOfUser(dbWith({ role: 'ARTISAN', locale: 'fr' }), 5)).toBe('fr');
  });

  it('staff are French', async () => {
    expect(await localeOfUser(dbWith({ role: 'SUPPORT', locale: 'ar' }), 5)).toBe('fr');
  });

  it('an account that is not found, or an id that is not a number, is the fallback', async () => {
    expect(await localeOfUser(dbWith(null), 5)).toBe('fr');
    expect(await localeOfUser(dbWith(null), 5, 'ar')).toBe('ar');
    expect(await localeOfUser(dbWith({ role: 'CLIENT', locale: 'ar' }), null)).toBe('fr');
    expect(await localeOfUser(dbWith({ role: 'CLIENT', locale: 'ar' }), undefined, 'ar')).toBe('ar');
  });

  it('never throws: a database that fails, or a stand-in with no user table, means French', async () => {
    const broken = { user: { findUnique: async () => { throw new Error('database is down'); } } };

    expect(await localeOfUser(broken, 5)).toBe('fr');
    expect(await localeOfUser({}, 5)).toBe('fr');
    expect(await localeOfUser(null, 5, 'ar')).toBe('ar');
  });

  it('asks for the role and the language only', async () => {
    let asked: any;
    const db = { user: { findUnique: async (args: any) => ((asked = args), { role: 'CLIENT', locale: 'ar' }) } };

    await localeOfUser(db, 7);

    expect(asked).toEqual({ where: { id: 7 }, select: { role: true, locale: true } });
  });
});

describe('an amount in a message (P3-04)', () => {
  it('French is what formatMoney always wrote', () => {
    expect(moneyIn('fr', 1234.5)).toBe('1 234,500 TND');
    expect(moneyIn('fr', 50)).toBe('50,000 TND');
    expect(moneyIn('fr', 50, 'EUR')).toBe('50,000 EUR');
  });

  it('Arabic keeps the figure, set apart, and says dinar in Arabic', () => {
    expect(moneyIn('ar', 1234.5)).toBe(`${FSI}1 234,500${PDI} د.ت`);
    expect(moneyIn('ar', 50)).toBe(`${FSI}50,000${PDI} د.ت`);
  });

  it('Arabic: another currency keeps its code, set apart', () => {
    expect(moneyIn('ar', 50, 'EUR')).toBe(`${FSI}50,000${PDI} ${FSI}EUR${PDI}`);
  });
});

describe('a moment in a message (P3-04)', () => {
  it('French is the text as it came', () => {
    expect(whenIn('fr', '19/10/2026 à 08:00')).toBe('19/10/2026 à 08:00');
  });

  it('Arabic: the day and the hour are two left-to-right values joined by a word', () => {
    expect(whenIn('ar', '19/10/2026 à 08:00')).toBe(`${FSI}19/10/2026${PDI} الساعة ${FSI}08:00${PDI}`);
  });

  it('Arabic: anything else is set apart as it is', () => {
    expect(whenIn('ar', 'demain')).toBe(`${FSI}demain${PDI}`);
  });
});
