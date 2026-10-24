/**
 * An amount in words, in French, for the line "Arrêtée la présente facture à la somme de ..." that Tunisian invoices carry (P2-07).
 * Dinars and millimes (three decimals); an amount in another currency has no words here.
 *
 * The spelling is the traditional one: hyphens between the tens and the units ("quarante-deux"), "et" in "vingt et un" and
 * "soixante et onze" but not in "quatre-vingt-un" or "cent un"; "quatre-vingts" and "deux cents" take an s only when nothing follows
 * them, and "mille" never does ("quatre-vingt mille", "deux cent mille"); a whole number of millions or billions takes "de" ("un million
 * de dinars"), and a number with something after the millions does not ("un million deux cent mille dinars").
 */

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function belowHundred(n: number, final: boolean): string {
  if (n < 17) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;

  if (n < 70) {
    const tens = Math.floor(n / 10);
    const units = n % 10;

    if (units === 0) return TENS[tens];

    return units === 1 ? `${TENS[tens]} et un` : `${TENS[tens]}-${UNITS[units]}`;
  }

  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${belowHundred(n - 60, false)}`;
  if (n === 80) return final ? 'quatre-vingts' : 'quatre-vingt';

  return `quatre-vingt-${belowHundred(n - 80, false)}`;
}

/** 0 to 999. `final`: nothing follows the number (not even "mille"), so "cent" and "quatre-vingt" take their s. */
function belowThousand(n: number, final: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds === 0) return belowHundred(rest, final);

  const head = hundreds === 1 ? 'cent' : `${UNITS[hundreds]} cent${rest === 0 && final ? 's' : ''}`;

  return rest === 0 ? head : `${head} ${belowHundred(rest, final)}`;
}

export function integerInWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${value} is not a whole number from 0`);
  if (value === 0) return UNITS[0];

  const billions = Math.floor(value / 1e9);
  const millions = Math.floor((value % 1e9) / 1e6);
  const thousands = Math.floor((value % 1e6) / 1e3);
  const rest = value % 1e3;
  const parts: string[] = [];

  if (billions) parts.push(`${belowThousand(billions, true)} milliard${billions > 1 ? 's' : ''}`);
  if (millions) parts.push(`${belowThousand(millions, true)} million${millions > 1 ? 's' : ''}`);
  if (thousands) parts.push(thousands === 1 ? 'mille' : `${belowThousand(thousands, false)} mille`);
  if (rest) parts.push(belowThousand(rest, true));

  return parts.join(' ');
}

/** "cent dix-neuf dinars et cinq cents millimes"; null for a currency that has no words here, or an amount that is not one. */
export function amountInWords(amount: number, currency: string): string | null {
  if (currency !== 'TND') return null;

  const millimes = Math.round(amount * 1000);

  if (!Number.isSafeInteger(millimes) || millimes < 0) return null;

  const dinars = Math.floor(millimes / 1000);
  const rest = millimes % 1000;

  // Beyond a thousand billion the scale names run out (the amounts of the database stop far below).
  if (dinars >= 1e12) return null;

  // "un million de dinars", "deux milliards de dinars": a whole number of millions or billions takes "de" before the noun.
  const joiner = dinars >= 1e6 && dinars % 1e6 === 0 ? ' de' : '';
  const dinarWords = `${integerInWords(dinars)}${joiner} dinar${dinars > 1 ? 's' : ''}`;
  const millimeWords = `${integerInWords(rest)} millime${rest > 1 ? 's' : ''}`;

  if (rest === 0) return dinarWords;

  return dinars === 0 ? millimeWords : `${dinarWords} et ${millimeWords}`;
}
