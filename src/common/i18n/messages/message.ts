import { DEFAULT_LOCALE, Locale, MessageParams, formatMessage, isolate as isolateValue } from '../i18n';

/**
 * One text the server sends to a person, in both languages (P3-04).
 *
 * `fr` is the wording the server always had, character for character; `ar` is Modern Standard Arabic. Both are messages in the
 * syntax of `../i18n` (`{name}`, `{count, plural, ...}`). `isolate` names the values that are Latin letters, digits or a
 * mixed-language text (a name, an address, an amount, a phone number, a code, a link): in Arabic they are set apart so that
 * the right-to-left sentence around them does not reorder them. In French they are written as they are, so the French output
 * does not change by a single character.
 */
export interface MessageDef<P extends MessageParams = MessageParams> {
  readonly fr: string;
  readonly ar: string;
  readonly isolate?: ReadonlyArray<keyof P & string>;
}

/** Declares a message; the type argument lists the values it takes, and `isolate` can only name those. */
export function message<P extends MessageParams = {}>(definition: MessageDef<P>): MessageDef<P> {
  return definition;
}

type Arguments<P> = {} extends P ? [params?: P] : [params: P];

/** The characters that change the direction of the text around them: a value that carries one could close an isolate early. */
const DIRECTION_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** The message in a language, with its values in. */
export function say<P extends MessageParams>(definition: MessageDef<P>, locale: Locale, ...args: Arguments<P>): string {
  const params = (args[0] ?? {}) as P;

  if (locale !== 'ar' || !definition.isolate?.length) {
    return formatMessage(locale, definition[locale], params);
  }

  const set: Record<string, string | number | null | undefined> = { ...params };

  for (const name of definition.isolate) {
    const value = params[name];

    if (value === null || value === undefined) continue;

    const text = String(value).replace(DIRECTION_CONTROLS, '');

    if (text !== '') set[name] = isolateValue(text);
  }

  return formatMessage(locale, definition.ar, set);
}

/** A title and a text for a notice, in a language. */
export type NoticeTexts = (locale: Locale) => { title: string; message: string };

/**
 * A notice written for whoever reads it. `title` and `message` are the French ones, as the callers always passed them, so
 * a reader of the payload sees what it always saw; `texts` is how the notification service writes the same notice in the
 * language of its recipient (staff are always written to in French and never use it).
 */
export function notice(texts: NoticeTexts): { title: string; message: string; texts: NoticeTexts } {
  return { ...texts(DEFAULT_LOCALE), texts };
}

/** A job or a quote number the way a sentence writes it: "#12". One value, so that an Arabic sentence keeps it together. */
export function reference(id: number | string): string {
  return `#${id}`;
}
