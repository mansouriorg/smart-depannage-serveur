import { Locale, isolate } from '../i18n';
import { currencyCode } from '../../locale/locale';
import { MoneyInput, formatMoney } from '../../money/money';

/** The currencies as an Arabic sentence writes them: the Tunisian dinar is د.ت, any other keeps its code. */
const ARABIC_CURRENCY: Record<string, string> = { TND: 'د.ت' };

/**
 * An amount for a message. French is exactly what `formatMoney` always wrote ("1 234,500 TND"). Arabic keeps the same figure
 * (the digits are 0 to 9, the decimals a comma, the thousands a space: what the customer sees on the invoice) set apart as one
 * left-to-right value, followed by the currency in Arabic ("1 234,500 د.ت").
 */
export function moneyIn(locale: Locale, value: MoneyInput, currency?: string | null): string {
  if (locale !== 'ar') return currency === undefined || currency === null ? formatMoney(value) : formatMoney(value, { currency });

  const code = currency ?? currencyCode();

  return `${isolate(formatMoney(value, { currency: false }))} ${ARABIC_CURRENCY[code] ?? isolate(code)}`;
}

const FRENCH_MOMENT = /^(\d{2}\/\d{2}\/\d{4}) à (\d{2}:\d{2})$/;

/** The word between the day and the hour of a moment in Arabic. */
const AT_HOUR = 'الساعة';

/**
 * A moment already written for a person ("19/10/2026 à 08:00", what `formatLocalDateTime` makes) in a language. In Arabic the date
 * and the hour are two left-to-right values joined by a word; anything that is not that shape is set apart as it is.
 */
export function whenIn(locale: Locale, when: string): string {
  if (locale !== 'ar') return when;

  const match = FRENCH_MOMENT.exec(when);

  return match ? `${isolate(match[1])} ${AT_HOUR} ${isolate(match[2])}` : isolate(when);
}
