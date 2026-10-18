import * as fs from 'fs';
import * as path from 'path';

import { parsePrismaSchema } from '../api-contract/prisma-schema';
import { readSource, stripComments } from '../testing/source-scan';
import {
  TRADES,
  TRADE_CODES,
  TRADE_LIST,
  TradeCode,
  isTradeCode,
  normalizeTradeText,
  serviceNameOf,
  textPointsToTrade,
  tradeKeywords,
  tradesNamedBy,
  tradesOfText,
} from './trades';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * P1-10: one table says which service type a word is. A trade the database knows and the table
 * does not (or the other way round) is what these tests are for: the table is the only place the
 * trades are written, so the three can never drift apart without a red test.
 */
describe('the table of trades is the list of service types (P1-10)', () => {
  it('has exactly the values of the ServiceType enum of the schema, in the same order', () => {
    const schema = parsePrismaSchema(read('prisma/schema.prisma'));

    expect([...TRADE_CODES]).toEqual(schema.enums.ServiceType);
  });

  it('describes every trade once, under its own code', () => {
    expect(Object.keys(TRADES)).toEqual([...TRADE_CODES]);
    expect(TRADE_LIST.map((trade) => trade.code)).toEqual([...TRADE_CODES]);

    for (const code of TRADE_CODES) {
      expect(TRADES[code].code).toBe(code);
      expect(TRADES[code].label.length > 0).toBe(true);
      expect(TRADES[code].service.length > 0).toBe(true);
      expect(TRADES[code].keywords.length > 0).toBe(true);
    }
  });

  it('gives the three real trades a service type of their own: heating, glazing, air conditioning', () => {
    expect(tradesNamedBy('Chauffagiste')).toEqual(['CHAUFFAGISTE']);
    expect(tradesNamedBy('Vitrier')).toEqual(['VITRIER']);
    expect(tradesNamedBy('Climatisation')).toEqual(['CLIMATICIEN']);
  });

  it('keeps a word for one trade only: no label, service or alias is shared', () => {
    const owner = new Map<string, TradeCode>();

    for (const trade of TRADE_LIST) {
      for (const name of [trade.code, trade.label, trade.service, ...trade.aliases]) {
        const key = normalizeTradeText(name);
        const known = owner.get(key);

        expect(known === undefined || known === trade.code).toBe(true);
        owner.set(key, trade.code);
      }
    }
  });

  it('writes the keywords already without accents or capitals (they are compared as they are)', () => {
    for (const trade of TRADE_LIST) {
      for (const keyword of trade.keywords) {
        expect(keyword).toBe(normalizeTradeText(keyword));
      }
    }
  });

  it('every trade has a category in the catalog seed, and the seed has no other', () => {
    const seeded = [...read('prisma/seed-service-catalog.ts').matchAll(/serviceType: ServiceType\.([A-Z]+),/g)].map((found) => found[1]);

    expect([...seeded].sort()).toEqual([...TRADE_CODES].sort());
  });

  it('every trade offered by an app or a form maps to a service type', () => {
    // The words of the admin "add a technician" list and of the website "join us" list.
    const offered: Array<[string, TradeCode]> = [
      ['Plombier', 'PLOMBIER'],
      ['Électricien', 'ELECTRICIEN'],
      ['Serrurier', 'SERRURIER'],
      ['Menuisier', 'MENUISIER'],
      ['Polyvalent', 'AUTRE'],
      ['Chauffagiste', 'CHAUFFAGISTE'],
      ['Vitrier', 'VITRIER'],
      ['Climatisation', 'CLIMATICIEN'],
    ];

    for (const [word, code] of offered) {
      expect(tradesOfText(word)).toEqual([code]);
    }
  });

  it('the service type list of the legacy request form is written from the table, not typed again', () => {
    const dto = stripComments(readSource('modules/interventions/dto/create-intervention.dto.ts'));

    expect(dto).toContain('TRADE_CODES.join');
    expect(dto).not.toContain('PLOMBIER, MENUISIER');
  });

  it('has no import and reads no process, so it can be copied as it is into the shared package', () => {
    const code = stripComments(readSource('common/trades/trades.ts'));

    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bprocess\b/);
    expect(code).not.toMatch(/\brequire\(/);
  });
});

describe('reading a word (P1-10)', () => {
  it('compares without accents, capitals or punctuation', () => {
    expect(normalizeTradeText('  Électricité ')).toBe('electricite');
    expect(normalizeTradeText("Chauffe-eau / PLOMBERIE")).toBe('chauffe eau plomberie');
    expect(normalizeTradeText("L’électricien")).toBe('l electricien');
    expect(normalizeTradeText(null)).toBe('');
    expect(normalizeTradeText(undefined)).toBe('');
  });

  it('knows the code, the label, the service and the aliases of a trade', () => {
    for (const trade of TRADE_LIST) {
      for (const name of [trade.code, trade.label, trade.service, ...trade.aliases, trade.label.toUpperCase()]) {
        expect(tradesNamedBy(name)).toEqual([trade.code]);
      }
    }
  });

  it('names no trade for a word that is none, or for nothing', () => {
    expect(tradesNamedBy('Maçon')).toEqual([]);
    expect(tradesNamedBy('')).toEqual([]);
    expect(tradesNamedBy(null)).toEqual([]);
    expect(tradesOfText('   ')).toEqual([]);
    expect(tradesOfText(undefined)).toEqual([]);
  });

  it('finds the trade a longer text points to', () => {
    expect(tradesOfText('Pose de portes et fenêtres')).toEqual(['MENUISIER']);
    expect(tradesOfText('Fuite sous évier')).toEqual(['PLOMBIER']);
    expect(tradesOfText('Chauffe-eau électrique')).toEqual(['PLOMBIER']);
    expect(tradesOfText('Radiateur qui fuit')).toEqual(['CHAUFFAGISTE']);
    expect(tradesOfText('Remplacement de vitre cassée')).toEqual(['VITRIER']);
    expect(tradesOfText('Climatiseur split en panne')).toEqual(['CLIMATICIEN']);
  });

  it('returns every trade a text names, in the order of the table', () => {
    expect(tradesOfText('Plombier chauffagiste')).toEqual(['PLOMBIER', 'CHAUFFAGISTE']);
  });

  it('a keyword must begin a word, not hide inside one', () => {
    // "entreprise" holds "prise" (a socket), "oncle" holds "cle" (a key)
    expect(tradesOfText('entreprise générale')).toEqual(['AUTRE']);
    expect(tradesOfText('oncle')).toEqual([]);
    expect(tradesOfText('prises électriques')).toEqual(['ELECTRICIEN']);
    expect(tradesOfText('portes')).toEqual(['MENUISIER']);
  });

  it('a short keyword must be the whole word: "cleaning" is no key, "climbing" no air conditioner, "boisson" no wood', () => {
    expect(tradesOfText('Cleaning et nettoyage')).toEqual([]);
    expect(tradesOfText('climbing')).toEqual([]);
    expect(tradesOfText('boisson')).toEqual([]);
    expect(tradesOfText('Spécialiste du bois')).toEqual(['MENUISIER']);
    expect(tradesOfText('copie de clés')).toEqual(['SERRURIER']);
    expect(tradesOfText('une clef perdue')).toEqual(['SERRURIER']);
    expect(tradesOfText('pose de clim')).toEqual(['CLIMATICIEN']);
    expect(tradesOfText('installation de splits')).toEqual(['CLIMATICIEN']);
  });

  it('a quote, a bar or a bullet separates words like a comma does', () => {
    expect(tradesOfText('Plombier|Électricien')).toEqual(['PLOMBIER', 'ELECTRICIEN']);
    expect(tradesOfText('«Plombier»')).toEqual(['PLOMBIER']);
    expect(tradesOfText('"Vitrier" • Serrurier')).toEqual(['SERRURIER', 'VITRIER']);
    expect(normalizeTradeText('Chauffe-eau – Clim')).toBe('chauffe eau clim');
  });

  it('"Autre" is the answer of last resort: a text about a plumber who is general is a plumber', () => {
    expect(tradesOfText('Plomberie générale')).toEqual(['PLOMBIER']);
    expect(tradesOfText('Dépannage général')).toEqual(['AUTRE']);
  });

  it('says whether a text points to one given trade (what the matching asks)', () => {
    expect(textPointsToTrade('Spécialiste du chauffe-eau', 'PLOMBIER')).toBe(true);
    expect(textPointsToTrade('Spécialiste du chauffe-eau', 'CHAUFFAGISTE')).toBe(false);
    expect(textPointsToTrade('Climatisation', 'CLIMATICIEN')).toBe(true);
    expect(textPointsToTrade('Polyvalent', 'AUTRE')).toBe(true);
    expect(textPointsToTrade('Maçon', 'AUTRE')).toBe(false);
    expect(textPointsToTrade('', 'AUTRE')).toBe(false);
    expect(textPointsToTrade(null, 'PLOMBIER')).toBe(false);
  });

  it('the matching and the mission board read a text the same way: "Plomberie générale" is a plumber, not "Autre"', () => {
    for (const text of ['Plomberie générale', 'Électricité et dépannage', 'Dépannage général', 'Polyvalent', 'Maçon', 'Cleaning']) {
      for (const code of TRADE_CODES) {
        expect(textPointsToTrade(text, code)).toBe(tradesOfText(text).includes(code));
      }
    }

    expect(textPointsToTrade('Plomberie générale', 'AUTRE')).toBe(false);
    expect(textPointsToTrade('Plomberie générale', 'PLOMBIER')).toBe(true);
  });

  it('gives a screen the name of the work instead of the code', () => {
    expect(serviceNameOf('PLOMBIER')).toBe('Plomberie');
    expect(serviceNameOf('CLIMATICIEN')).toBe('Climatisation');
    expect(serviceNameOf('ELECTRICIEN')).toBe('Électricité');
    // a value this table does not know (an older server, a typo) is shown as it came
    expect(serviceNameOf('SOMETHING')).toBe('SOMETHING');
    expect(serviceNameOf(null)).toBe('');
    expect(serviceNameOf(undefined)).toBe('');
  });

  it('hands out the keywords of a trade', () => {
    expect(tradeKeywords('VITRIER')).toContain('vitrage');
    expect(isTradeCode('VITRIER')).toBe(true);
    expect(isTradeCode('Vitrier')).toBe(false);
    expect(isTradeCode(3)).toBe(false);
  });
});
