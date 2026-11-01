/**
 * The languages of the product and how a message is put together (P3-04).
 *
 * French is the language every message was written in; Arabic is read right to left. This one file is copied as it is into the
 * shared package (`generated/i18n.ts`), so the server, the website and the phone app tell the languages apart, read the
 * direction and put values into a message in one way. It imports nothing, so it runs in the browser and in React Native as well
 * as in Node.
 */

export const LOCALES = ['fr', 'ar'] as const;

export type Locale = (typeof LOCALES)[number];

/** The language of everybody who has not chosen one, and of the dashboard (it stays French). */
export const DEFAULT_LOCALE: Locale = 'fr';

/** Each language written in itself, for a switch: a visitor who cannot read the current language still finds theirs. */
export const LOCALE_NAMES: Record<Locale, string> = { fr: 'Français', ar: 'العربية' };

/** The header that an app sends on every call to say which language it shows: `X-App-Locale: ar`. */
export const LOCALE_HEADER = 'x-app-locale';

/** The cookie in which the website keeps the visitor's choice. */
export const LOCALE_COOKIE = 'locale';

/**
 * The tag the browser and the phone use to format dates and numbers. Tunisian ones: Arabic as it is written in Tunisia (the
 * months are janvier, février... in Arabic letters, and the digits are 0 to 9, not the Arabic-Indic ones) and French with the dinar.
 */
export const INTL_TAGS: Record<Locale, string> = { fr: 'fr-TN', ar: 'ar-TN' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The supported language a value names, or null: "ar", "AR", "ar-TN", "fr_FR", " fr " all name one. Anything else (English,
 * nothing, an object) names none, and the caller chooses what to do (a stored choice, the default).
 */
export function localeOf(value: unknown): Locale | null {
  if (typeof value !== 'string') return null;

  const language = value.trim().toLowerCase().split(/[-_]/)[0];

  return isLocale(language) ? language : null;
}

/** The language a value names, or French. */
export function localeOrDefault(value: unknown): Locale {
  return localeOf(value) ?? DEFAULT_LOCALE;
}

/**
 * A value set apart from the text around it, so that a right-to-left sentence does not reorder it: a phone number, an amount,
 * a code, a name or an address written in Latin letters, put into an Arabic sentence. (The first-strong isolate and its closing mark
 * are invisible; a French sentence does not need them.)
 */
export function isolate(value: string | number): string {
  return `\u2068${value}\u2069`;
}

export type Direction = 'ltr' | 'rtl';

export function directionOf(locale: Locale): Direction {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function isRtl(locale: Locale): boolean {
  return directionOf(locale) === 'rtl';
}

/**
 * The first supported language of a browser's list ("en;q=0.8, ar-TN, fr;q=0.9" gives "ar": ar-TN has the weight 1 that a tag without q has, which is
 * more than the 0.9 of fr; the best-weighted language that the product speaks), or null when the list names none. Used once, to choose the language of a visitor who has not chosen.
 */
export function bestLocaleOf(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;

  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const weight = params.map((param) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)).find(Boolean);
      const q = weight ? Number(weight[1]) : 1;

      return { locale: localeOf(tag), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry): entry is { locale: Locale; q: number; index: number } => entry.locale !== null && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  return ranked.length ? ranked[0].locale : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Puts values into a message (P3-04). The messages of the product follow a small part of the ICU message syntax, the same one the
 * website's `next-intl` reads, so one text can be shown by the server, the website and the phone app:
 *
 *   "Bonjour {name}"                                                  a value
 *   "{count, plural, =0{Aucune photo} one{{count} photo} other{{count} photos}}"   a word that agrees with a number
 *
 * Arabic has six plural forms (zero, one, two, few, many, other); French has one, many and other, and `other` is required.
 * Nothing else is supported on purpose: no `#` (a number is written as `{count}`), no number or date formats (the caller
 * formats a value and passes the text), no tags, and no apostrophe quoting beyond `''` and `'{'`; a test of the catalogues
 * refuses every other use of `{`, `}`, `<`, `>`, `#` and a straight apostrophe, so the syntax cannot drift from what next-intl reads.
 *
 * A value that is missing is written as nothing, never as "undefined".
 */

export type MessageParams = Readonly<Record<string, string | number | null | undefined>>;

type Branch = { selector: string; body: Node[] };

type Node = string | { arg: string } | { arg: string; branches: Branch[] };

class Cursor {
  i = 0;
  constructor(readonly text: string) {}
}

const PLURAL_SELECTORS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** The text up to the next unquoted `{` or `}`; `''` is one apostrophe, and `'{'` / `'}'` are those characters. */
function readText(cursor: Cursor): string {
  let out = '';
  const { text } = cursor;

  while (cursor.i < text.length) {
    const ch = text[cursor.i];

    if (ch === '{' || ch === '}') break;

    if (ch === "'") {
      if (text[cursor.i + 1] === "'") {
        out += "'";
        cursor.i += 2;
        continue;
      }

      if (text[cursor.i + 1] === '{' || text[cursor.i + 1] === '}') {
        const close = text.indexOf("'", cursor.i + 2);
        const end = close === -1 ? text.length : close;

        out += text.slice(cursor.i + 1, end);
        cursor.i = close === -1 ? text.length : close + 1;
        continue;
      }
    }

    out += ch;
    cursor.i += 1;
  }

  return out;
}

function parseNodes(cursor: Cursor, nested: boolean): Node[] {
  const nodes: Node[] = [];

  for (;;) {
    const literal = readText(cursor);

    if (literal) nodes.push(literal);

    if (cursor.i >= cursor.text.length) {
      if (nested) throw new Error(`Message not closed: ${cursor.text}`);

      return nodes;
    }

    if (cursor.text[cursor.i] === '}') {
      if (!nested) throw new Error(`Unexpected "}" in message: ${cursor.text}`);

      return nodes;
    }

    nodes.push(parseArgument(cursor));
  }
}

function parseArgument(cursor: Cursor): Node {
  const { text } = cursor;
  const close = findArgumentEnd(text, cursor.i);
  const inner = text.slice(cursor.i + 1, close);
  const comma = inner.indexOf(',');

  if (comma === -1) {
    cursor.i = close + 1;

    return { arg: checkName(inner.trim(), text) };
  }

  const arg = checkName(inner.slice(0, comma).trim(), text);
  const rest = inner.slice(comma + 1).trimStart();

  if (!rest.startsWith('plural')) throw new Error(`Only plural is supported in a message: ${text}`);

  const afterKind = rest.slice('plural'.length).trimStart();

  if (!afterKind.startsWith(',')) throw new Error(`Malformed plural in message: ${text}`);

  const branches = parseBranches(afterKind.slice(1), text);

  cursor.i = close + 1;

  return { arg, branches };
}

/** The index of the `}` that closes the `{` at `start`, counting the braces between. */
function findArgumentEnd(text: string, start: number): number {
  let depth = 0;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === "'" && (text[i + 1] === '{' || text[i + 1] === '}')) {
      const close = text.indexOf("'", i + 2);

      i = close === -1 ? text.length : close;
      continue;
    }

    if (ch === '{') depth += 1;

    if (ch === '}') {
      depth -= 1;

      if (depth === 0) return i;
    }
  }

  throw new Error(`Message not closed: ${text}`);
}

function parseBranches(source: string, whole: string): Branch[] {
  const branches: Branch[] = [];
  const cursor = new Cursor(source);

  for (;;) {
    while (/\s/.test(cursor.text[cursor.i] ?? '')) cursor.i += 1;

    if (cursor.i >= source.length) break;

    const open = source.indexOf('{', cursor.i);

    if (open === -1) throw new Error(`Malformed plural in message: ${whole}`);

    const selector = source.slice(cursor.i, open).trim();

    if (!/^=\d+$/.test(selector) && !PLURAL_SELECTORS.has(selector)) throw new Error(`Unknown plural form "${selector}" in message: ${whole}`);

    const end = findArgumentEnd(source, open);
    const body = parseNodes(new Cursor(source.slice(open + 1, end)), false);

    branches.push({ selector, body });
    cursor.i = end + 1;
  }

  if (!branches.some((branch) => branch.selector === 'other')) throw new Error(`A plural needs an "other" form: ${whole}`);

  return branches;
}

function checkName(name: string, whole: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Bad value name "${name}" in message: ${whole}`);

  return name;
}

const parsed = new Map<string, Node[]>();

function parseMessage(template: string): Node[] {
  let nodes = parsed.get(template);

  if (!nodes) {
    nodes = parseNodes(new Cursor(template), false);
    parsed.set(template, nodes);
  }

  return nodes;
}

export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

interface PluralSelector {
  select(count: number): string;
}

/**
 * The plural form of a number by the rules of CLDR, for an engine that has no `Intl.PluralRules` (the JavaScript engine of a phone app
 * may not: every message with a plural would then fail to be drawn, in French too). French: 0, 1 and what is between are "one", the
 * rest "other". Arabic: 0 "zero", 1 "one", 2 "two", 3 to 10 (the last two digits) "few", 11 to 99 "many", the rest and any fraction "other".
 */
export function pluralFormOf(locale: Locale, count: number): PluralForm {
  const n = Math.abs(count);

  if (locale === 'fr') return Math.floor(n) === 0 || Math.floor(n) === 1 ? 'one' : 'other';

  if (!Number.isInteger(n)) return 'other';

  if (n === 0) return 'zero';
  if (n === 1) return 'one';
  if (n === 2) return 'two';

  const lastTwo = n % 100;

  if (lastTwo >= 3 && lastTwo <= 10) return 'few';
  if (lastTwo >= 11) return 'many';

  return 'other';
}

const rules = new Map<Locale, PluralSelector>();

function pluralRules(locale: Locale): PluralSelector {
  let found = rules.get(locale);

  if (!found) {
    try {
      found = typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function' ? new Intl.PluralRules(INTL_TAGS[locale]) : undefined;
    } catch {
      found = undefined; // an engine that knows the object but not the language
    }

    found ??= { select: (count: number) => pluralFormOf(locale, count) };
    rules.set(locale, found);
  }

  return found;
}

/** Forgets the plural rules that were chosen, so that a test can change what `Intl` offers. */
export function forgetPluralRules(): void {
  rules.clear();
}

function show(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function render(nodes: readonly Node[], locale: Locale, params: MessageParams): string {
  let out = '';

  for (const node of nodes) {
    if (typeof node === 'string') {
      out += node;
    } else if (!('branches' in node)) {
      out += show(params[node.arg]);
    } else {
      const count = Number(params[node.arg]);
      const exact = Number.isFinite(count) ? node.branches.find((branch) => branch.selector === `=${count}`) : undefined;
      const form = Number.isFinite(count) ? pluralRules(locale).select(count) : 'other';
      const chosen = exact ?? node.branches.find((branch) => branch.selector === form) ?? node.branches.find((branch) => branch.selector === 'other');

      out += render(chosen ? chosen.body : [], locale, params);
    }
  }

  return out;
}

/** The message with its values in. Throws on a template that breaks the syntax above (the catalogue tests catch it first). */
export function formatMessage(locale: Locale, template: string, params: MessageParams = {}): string {
  return render(parseMessage(template), locale, params);
}

/** The names of the values a message takes, sorted: what French and Arabic must agree on. */
export function messageArguments(template: string): string[] {
  const names = new Set<string>();

  const walk = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;

      names.add(node.arg);

      if ('branches' in node) node.branches.forEach((branch) => walk(branch.body));
    }
  };

  walk(parseMessage(template));

  return [...names].sort();
}
