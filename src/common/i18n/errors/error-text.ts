import { isolate } from '../i18n';
import { ERRORS_AR } from './errors.ar';
import { VALUE_WORDS_AR } from './errors.values.ar';

/**
 * Turns the French sentence of a refusal into its Arabic one (P3-04).
 *
 * The dictionary (`errors.ar.ts`) is keyed by the sentence as the source writes it. A sentence with a value in it (a template
 * literal in the source) is a pattern: the value is a hole `{}` in the key, and `{1}`, `{2}`... in the Arabic say where each captured
 * value goes, so the Arabic can put them in its own order. A sentence that is not in the dictionary is not touched.
 */

export const HOLE = '{}';

interface Pattern {
  value: string;
  regex: RegExp;
  /** The length of the fixed text: of two patterns that fit, the one with more of it is the more precise. */
  fixed: number;
}

export interface ErrorTranslator {
  /** The Arabic sentence, or null when the dictionary does not know it. */
  text(text: string): string | null;
  /** The body of a refusal (`{ statusCode, message, error, issues }`, or just the text) with its sentences in Arabic: the same object when none changed. */
  response(response: unknown): unknown;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An amount the server wrote ("1 250,000 TND", "12,500 DT"): the dinar is written د.ت in Arabic. */
const AMOUNT = /^(-?\d[\d   ]*(?:[.,]\d+)?)\s(?:TND|DT)$/;

/** Where a text can be cut into sentences: after a full stop, a question mark or an exclamation mark and a space. */
const SENTENCE_END = /[.!?…] /g;
const MAX_SENTENCES = 12;

/**
 * The longest text matched against the dictionary. The longest sentence in it is 225 characters and a value (a name, a parameter)
 * is cut far below this where it enters; the patterns have several lazy holes, whose time grows quickly with the length of the text.
 */
const MAX_TEXT = 1000;

export function createErrorTranslator(dictionary: Readonly<Record<string, string>>, words: Readonly<Record<string, string>> = {}): ErrorTranslator {
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];

  for (const [key, value] of Object.entries(dictionary)) {
    if (!key.includes(HOLE)) {
      exact.set(key, value);
      continue;
    }

    const parts = key.split(HOLE);

    patterns.push({
      value,
      regex: new RegExp(`^${parts.map(escapeRegex).join('(.+?)')}$`, 's'),
      fixed: parts.join('').length,
    });
  }

  // The most precise first, so that "Le service « {} » n’est plus proposé." wins over a shorter pattern that also fits.
  patterns.sort((a, b) => b.fixed - a.fixed);

  /**
   * A value taken out of a sentence, put into the Arabic one: a sentence or a term inside a sentence is translated, so is a list of
   * terms ("Plombier, Vitrier"), a code a person reads (a status, a day) is its word, a dinar amount is written in Arabic, the rest
   * (a number, a name) is set apart.
   */
  function value(captured: string): string {
    const inner = single(captured);

    if (inner !== null) return inner;

    const word = Object.prototype.hasOwnProperty.call(words, captured) ? words[captured] : undefined;

    if (word !== undefined) return word;

    // "a, b et c": each entry a known term; Arabic joins with ، and puts the و of the last one against its word
    const pieces = captured.split(/(, | et )/);
    const entries = pieces.filter((_, index) => index % 2 === 0).map(single);

    if (entries.length > 1 && entries.every((entry): entry is string => entry !== null)) {
      return entries.reduce((joined, entry, index) => (index === 0 ? entry : `${joined}${pieces[index * 2 - 1] === ' et ' ? ' و' : '، '}${entry}`), '');
    }

    const amount = AMOUNT.exec(captured);

    // The figure is set apart and the unit stays outside: an isolate that starts with Arabic runs right to left and reverses the digit groups.
    return amount ? `${isolate(amount[1])} د.ت` : isolate(captured);
  }

  /** One sentence: written as it is in the dictionary, or matching one of its patterns. */
  function single(text: string): string | null {
    const trimmed = text.trim();

    if (trimmed.length > MAX_TEXT) return null;

    const known = exact.get(trimmed);

    if (known !== undefined) return known;

    for (const pattern of patterns) {
      const match = pattern.regex.exec(trimmed);

      if (!match) continue;

      const captured = match.slice(1);

      return pattern.value.replace(/\{(\d+)\}/g, (_, index: string) => (captured[Number(index) - 1] === undefined ? '' : value(captured[Number(index) - 1])));
    }

    return null;
  }

  /** Several sentences written one after the other with a space (the reasons a photo was refused): each one, if every one is known. */
  function joined(text: string): string | null {
    const trimmed = text.trim();
    const cuts = [0, ...[...trimmed.matchAll(SENTENCE_END)].map((m) => (m.index as number) + m[0].length), trimmed.length];

    if (cuts.length < 3 || cuts.length > MAX_SENTENCES + 2) return null;

    // translated[k]: the Arabic of trimmed.slice(0, cuts[k]), or null when it cannot be cut into known sentences
    const translated: (string[] | null)[] = [[]];

    for (let to = 1; to < cuts.length; to += 1) {
      translated[to] = null;

      for (let from = 0; from < to && translated[to] === null; from += 1) {
        const before = translated[from];

        if (before === null) continue;

        const sentence = single(trimmed.slice(cuts[from], cuts[to]));

        if (sentence !== null) translated[to] = [...before, sentence];
      }
    }

    const whole = translated[cuts.length - 1];

    return whole && whole.length > 1 ? whole.join(' ') : null;
  }

  function text(sentence: string): string | null {
    return single(sentence) ?? joined(sentence);
  }

  function list(values: unknown[]): unknown[] | null {
    let changed = false;
    const out = values.map((entry) => {
      const translated = typeof entry === 'string' ? text(entry) : null;

      if (translated === null) return entry;

      changed = true;

      return translated;
    });

    return changed ? out : null;
  }

  function response(body: unknown): unknown {
    if (typeof body === 'string') return text(body) ?? body;

    if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;

    // A copy that keeps the order of the fields: Nest sends the object as it is.
    const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    let changed = false;

    for (const field of ['message', 'issues']) {
      const found = copy[field];

      if (typeof found === 'string') {
        const translated = text(found);

        if (translated !== null) {
          copy[field] = translated;
          changed = true;
        }
      } else if (Array.isArray(found)) {
        const translated = list(found);

        if (translated !== null) {
          copy[field] = translated;
          changed = true;
        }
      }
    }

    return changed ? copy : body;
  }

  return { text, response };
}

const translator = createErrorTranslator(ERRORS_AR, VALUE_WORDS_AR);

/** The Arabic of a French sentence of the server, or null when there is none. */
export const translateErrorText = (sentence: string): string | null => translator.text(sentence);

/** A refusal's body with its sentences in Arabic; the very same object when nothing in it has a translation. */
export const translateErrorResponse = (body: unknown): unknown => translator.response(body);
