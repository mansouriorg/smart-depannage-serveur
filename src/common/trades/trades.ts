/**
 * The trades of Smart-Dépannage (P1-10).
 *
 * One table answers "which service type is this word?". Before, a specialty was free text
 * ("Plombier", "Climatisation", "Polyvalent"), the service type of a job was an enum, and
 * nothing joined the two: the website offered "Chauffagiste", "Vitrier" and "Climatisation"
 * to applicants, but a job could only be PLOMBIER, MENUISIER, SERRURIER, ELECTRICIEN or AUTRE,
 * so those artisans could never be offered a job of their own trade.
 *
 * `TRADE_CODES` are the values of the `ServiceType` enum of the database. A test reads the
 * schema and fails when the two differ, and `matching.service.ts` hands a `ServiceType` to
 * `tradeKeywords`, so the compiler refuses an enum value that this table does not know.
 *
 * Nothing here imports anything or reads `process`: the file is copied as it is into the shared
 * package, where the apps use it for their lists of trades.
 */

export const TRADE_CODES = [
  'PLOMBIER',
  'MENUISIER',
  'SERRURIER',
  'ELECTRICIEN',
  'CHAUFFAGISTE',
  'VITRIER',
  'CLIMATICIEN',
  'AUTRE',
] as const;

export type TradeCode = (typeof TRADE_CODES)[number];

export interface Trade {
  code: TradeCode;
  /** The person: "Plombier". This is what a specialty is stored as. */
  label: string;
  /** The work: "Plomberie". This is the name of the category in the catalog. */
  service: string;
  /**
   * What a person can type or pick to mean exactly this trade. Compared whole, without accents,
   * capitals or punctuation (see `normalizeTradeText`). The code, the label and the service are
   * always accepted as well.
   */
  aliases: string[];
  /**
   * Words that point to the trade inside a longer text ("fuite d'eau", "pose de portes"). A word of
   * more than 5 letters counts when it begins a word of the text; a shorter one must be the whole
   * word, with or without a plural s ("cle", "bois", "clim"). The matching of artisans to jobs
   * reads these. Written without accents.
   */
  keywords: string[];
}

export const TRADES: Record<TradeCode, Trade> = {
  PLOMBIER: {
    code: 'PLOMBIER',
    label: 'Plombier',
    service: 'Plomberie',
    aliases: ['plombier', 'plomberie'],
    keywords: ['plombier', 'plomberie', 'fuite', 'canalisation', 'chauffe eau'],
  },
  MENUISIER: {
    code: 'MENUISIER',
    label: 'Menuisier',
    service: 'Menuiserie',
    aliases: ['menuisier', 'menuiserie'],
    keywords: ['menuisier', 'menuiserie', 'bois', 'porte', 'fenetre'],
  },
  SERRURIER: {
    code: 'SERRURIER',
    label: 'Serrurier',
    service: 'Serrurerie',
    aliases: ['serrurier', 'serrurerie'],
    keywords: ['serrurier', 'serrurerie', 'serrure', 'cle', 'clef', 'porte bloquee'],
  },
  ELECTRICIEN: {
    code: 'ELECTRICIEN',
    label: 'Électricien',
    service: 'Électricité',
    aliases: ['electricien', 'electricite'],
    keywords: ['electricien', 'electricite', 'panne electrique', 'tableau', 'prise'],
  },
  CHAUFFAGISTE: {
    code: 'CHAUFFAGISTE',
    label: 'Chauffagiste',
    service: 'Chauffage',
    aliases: ['chauffagiste', 'chauffage'],
    keywords: ['chauffagiste', 'chauffage', 'radiateur', 'chaudiere', 'thermostat'],
  },
  VITRIER: {
    code: 'VITRIER',
    label: 'Vitrier',
    service: 'Vitrerie',
    aliases: ['vitrier', 'vitrerie', 'miroitier'],
    keywords: ['vitrier', 'vitrerie', 'vitre', 'vitrage', 'verre', 'miroir', 'miroitier'],
  },
  CLIMATICIEN: {
    code: 'CLIMATICIEN',
    label: 'Climaticien',
    service: 'Climatisation',
    aliases: ['climaticien', 'climatisation', 'frigoriste'],
    keywords: ['climaticien', 'climatisation', 'climatiseur', 'clim', 'split', 'frigoriste'],
  },
  AUTRE: {
    code: 'AUTRE',
    label: 'Autre',
    service: 'Autre',
    aliases: ['autre', 'polyvalent', 'multiservice', 'multi service'],
    keywords: ['autre', 'general', 'multi service', 'depannage'],
  },
};

/** The trades in the order a list shows them. */
export const TRADE_LIST: Trade[] = TRADE_CODES.map((code) => TRADES[code]);

export function isTradeCode(value: unknown): value is TradeCode {
  return typeof value === 'string' && (TRADE_CODES as readonly string[]).includes(value);
}

/**
 * The work of a service type as a person reads it ("Plomberie" for PLOMBIER), for a screen that
 * would otherwise show the code. A text this table does not know is given back as it is.
 */
export function serviceNameOf(serviceType: string | null | undefined): string {
  return isTradeCode(serviceType) ? TRADES[serviceType].service : (serviceType ?? '');
}

/** The words that point to a trade inside a longer text. */
export function tradeKeywords(code: TradeCode): string[] {
  return TRADES[code].keywords;
}

/**
 * A text as it is compared: no accents, no capitals, punctuation as a space ("Chauffe-eau" and
 * "chauffe eau" are the same), one space between words.
 */
export function normalizeTradeText(value?: string | null): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s'’`"“”«»\-–—_/\\.,;:()[\]&+|*•!?]+/g, ' ')
    .trim();
}

const NAMES: Array<[TradeCode, Set<string>]> = TRADE_LIST.map((trade) => [
  trade.code,
  new Set(
    [trade.code, trade.label, trade.service, ...trade.aliases].map((name) => normalizeTradeText(name)),
  ),
]);

const KEYWORDS: Array<[TradeCode, string[]]> = TRADE_LIST.map((trade) => [
  trade.code,
  trade.keywords.map((keyword) => normalizeTradeText(keyword)),
]);

/** A keyword of this many letters or fewer has to be a whole word ("cle" is not "cleaning"). */
const SHORT_KEYWORD = 5;

/**
 * True when a text (already normalized) has one of the words. A long word counts when it begins
 * a word of the text ("fenetre" is in "fenetres"); a short one must be the whole word, with or
 * without a plural s ("clim" is not in "climbing", "bois" is not in "boisson").
 */
function hasWordStartingWith(padded: string, words: string[]): boolean {
  const text = `${padded} `;

  return words.some((word) =>
    word.length > SHORT_KEYWORD
      ? text.includes(` ${word}`)
      : text.includes(` ${word} `) || text.includes(` ${word}s `),
  );
}

/**
 * True when a text points to one trade, by the same rule as `tradesOfText` (so "Plomberie
 * générale" points to PLOMBIER and not to AUTRE). The matching of artisans to jobs asks this for
 * the service type of the job.
 */
export function textPointsToTrade(text: string | null | undefined, code: TradeCode): boolean {
  return tradesOfText(text).includes(code);
}

/** The trades a text names exactly: its code, its label, its service or one of its aliases. */
export function tradesNamedBy(text?: string | null): TradeCode[] {
  const wanted = normalizeTradeText(text);

  if (!wanted) return [];

  return NAMES.filter(([, names]) => names.has(wanted)).map(([code]) => code);
}

/**
 * The trades a text points to: the one it names exactly or, failing that, every trade with a
 * keyword of it in the text ("Pose de portes et fenêtres" -> MENUISIER). A keyword must begin a
 * word, not hide inside one ("entreprise générale" is not about a "prise"), and a short one must
 * be the whole word ("Cleaning" is not about a "clé", "climbing" not about a "clim").
 * "Autre" is the answer of last resort: "Plomberie générale" is a plumber, not a plumber and
 * "something else".
 */
export function tradesOfText(text?: string | null): TradeCode[] {
  const named = tradesNamedBy(text);

  if (named.length) return named;

  const padded = ` ${normalizeTradeText(text)}`;

  if (padded.trim() === '') return [];

  const found = KEYWORDS.filter(([, words]) => hasWordStartingWith(padded, words)).map(
    ([code]) => code,
  );
  const specific = found.filter((code) => code !== 'AUTRE');

  return specific.length ? specific : found;
}
