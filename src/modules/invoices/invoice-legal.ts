/**
 * What an invoice and a credit note print about the company, kept on the document the day it is issued (P2-07).
 *
 * The mentions (address, trade register, legal lines, terms of payment), the VAT rates and the stamp duty (timbre fiscal) are
 * settings of the company, because the law decides them and the accountant confirms them: the server does not guess them. The
 * settings carry a date and a name when the accountant confirmed them; until then an invoice says so in its data
 * (`mentionsConfirmed: false`), so that the back office can find the invoices issued before the confirmation. Changing any of
 * what is printed takes the confirmation away again: what the accountant confirmed is a set of values, not a promise about later ones.
 */
import { BadRequestException } from '@nestjs/common';

import { money } from '../../common/money/money';
import { getLocale } from '../../common/locale/locale';

type Row = Record<string, any>;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;

  const trimmed = String(value).trim();

  return trimmed === '' ? null : trimmed;
};

/** What goes on a document, from the settings row (a company with no settings prints nothing it does not know). */
export function printedCompanyOf(settings: Row | null | undefined) {
  return {
    companyName: text(settings?.companyName),
    companyPhone: text(settings?.companyPhone),
    companyEmail: text(settings?.companyEmail),
    companyAddress: text(settings?.companyAddress),
    companyTaxId: text(settings?.matriculeFiscal),
    companyRegistre: text(settings?.registreCommerce),
    companyRib: text(settings?.rib),
    legalMentions: text(settings?.invoiceLegalMentions),
    paymentTerms: text(settings?.paymentTerms),
    stampDuty: money(settings?.stampDuty ?? 0),
    mentionsConfirmed: Boolean(settings?.invoiceRulesConfirmedAt),
  };
}

/** A stamp duty above this is a typing error, not a duty: refused (a wrong figure here is added to every invoice). */
export const STAMP_DUTY_MAX = 100;

/** The settings that a document prints: changing one of them takes the confirmation of the accountant away. */
export const PRINTED_SETTINGS: readonly string[] = [
  'companyName',
  'companyPhone',
  'companyEmail',
  'companyAddress',
  'matriculeFiscal',
  'registreCommerce',
  'rib',
  'invoiceLegalMentions',
  'paymentTerms',
  'stampDuty',
  'taxRates',
  'defaultTaxRate',
];

const NUMERIC_SETTINGS: readonly string[] = ['stampDuty', 'defaultTaxRate'];
const STRUCTURED_SETTINGS: readonly string[] = ['taxRates'];

/** A value as text with the keys of every object in the same order: PostgreSQL's jsonb hands keys back in an order of its own. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Row)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/** Whether a setting has the value it is asked to take (a number is compared as a number: 1 and "1.000" are the same stamp duty). */
function sameSetting(field: string, a: unknown, b: unknown): boolean {
  if (NUMERIC_SETTINGS.includes(field)) return Number(String(a ?? 0)) === Number(String(b ?? 0));
  if (STRUCTURED_SETTINGS.includes(field)) return canonicalJson(a ?? null) === canonicalJson(b ?? null);

  return (text(a) ?? '') === (text(b) ?? '');
}

/** Whether `changes` (the fields a request sets, `undefined` for a field it leaves) alter anything that is printed. */
export function printedSettingsChanged(current: Row, changes: Row): boolean {
  return PRINTED_SETTINGS.some((field) => changes[field] !== undefined && !sameSetting(field, changes[field], current[field]));
}

/** An invoice takes only the VAT rates the company has listed (and the accountant confirmed): a rate typed by hand is how a wrong one gets printed. */
export function isConfiguredRate(rate: unknown): boolean {
  return getLocale().taxRates.some((entry) => entry.rate === Number(String(rate)));
}

export function assertConfiguredRate(rate: unknown): void {
  const value = Number(String(rate));
  const rates = getLocale().taxRates.map((entry) => entry.rate);

  if (!isConfiguredRate(value)) {
    throw new BadRequestException(`Le taux de TVA ${value} % n’est pas l’un des taux de l’entreprise (${rates.join(' %, ')} %).`);
  }
}
