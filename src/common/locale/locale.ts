/**
 * Where the business is (P2-01): its currency, its time zone and its VAT rates, in one place.
 *
 * The values are kept in `CompanySettings` (the administrators edit them) and loaded into this module when the
 * server starts and every time the settings are saved, so that code that has no database at hand (a message, a
 * date window, a total) asks `getLocale()` and gets the same answer as everyone else. Until the settings are
 * loaded, and in a test, it answers for Tunisia: the dinar (TND, three decimals), the time of Tunis, and the VAT
 * rates of the country.
 *
 * Nothing in this file imports anything: `config/env.ts` and `common/money` import it, and it must not import them back.
 */

export interface TaxRateOption {
  /** What an invoice line says: STANDARD, REDUCED_13... */
  code: string;
  label: string;
  /** Percent, with at most two decimals. */
  rate: number;
}

export interface LocaleSettings {
  /** ISO 4217 code, three capital letters. */
  currency: string;
  /** IANA name of the zone in which the business reads its clocks. */
  timeZone: string;
  /** The rate (percent) a quote or an invoice takes when nobody gave one. */
  defaultTaxRate: number;
  taxRates: TaxRateOption[];
}

/** A setting that is not valid. `code` is the name of the setting ("defaultTaxRate", "taxRates[2]"): all a log line needs. */
export class LocaleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocaleError';
  }
}

function fail(message: string): never {
  throw new LocaleError(message.split(':')[0], message);
}

export const DEFAULT_CURRENCY = 'TND';
export const DEFAULT_TIME_ZONE = 'Africa/Tunis';

/**
 * Tunisian VAT: 19 % standard, 13 % and 7 % reduced, and 0 % for what is exempt. These are the rates the law is
 * recalled to give; the accountant confirms them for the invoices (P2-07), and the administrators can change them in the settings.
 */
export const DEFAULT_TAX_RATES: readonly TaxRateOption[] = Object.freeze(
  [
    { code: 'STANDARD', label: 'TVA 19 %', rate: 19 },
    { code: 'REDUCED_13', label: 'TVA 13 %', rate: 13 },
    { code: 'REDUCED_7', label: 'TVA 7 %', rate: 7 },
    { code: 'EXEMPT', label: 'Exonéré', rate: 0 },
  ].map((rate) => Object.freeze(rate)),
);

/** The settings, and the list of rates inside them, can be read by everyone and changed by nobody: only `applyLocale` replaces them. */
function frozen(settings: LocaleSettings): LocaleSettings {
  return Object.freeze({ ...settings, taxRates: Object.freeze(settings.taxRates.map((rate) => Object.freeze({ ...rate }))) as TaxRateOption[] });
}

export const DEFAULT_LOCALE: LocaleSettings = frozen({
  currency: DEFAULT_CURRENCY,
  timeZone: DEFAULT_TIME_ZONE,
  defaultTaxRate: 19,
  taxRates: DEFAULT_TAX_RATES.map((rate) => ({ ...rate })),
});

let current: LocaleSettings = DEFAULT_LOCALE;
let loaded = false;

export function isValidCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}

/** A percent as the database holds it: from 0 to 100 with at most two decimals. */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 && Math.round(value * 100) / 100 === value;
}

/**
 * Reads the list of rates from what the settings hold (a JSON column) or what an administrator sent. Anything that is
 * not a rate is a reason to refuse the whole list, never a rate that is quietly dropped: a missing rate on an invoice is worse than an error.
 */
export function parseTaxRates(value: unknown): TaxRateOption[] {
  if (!Array.isArray(value) || value.length === 0) fail('taxRates: a list of at least one rate is expected');

  const seen = new Set<string>();

  return value.map((entry, at) => {
    const item = entry as Partial<TaxRateOption> | null;

    if (!item || typeof item !== 'object') fail(`taxRates[${at}]: an object is expected`);
    if (typeof item.code !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(item.code)) fail(`taxRates[${at}].code: capital letters, digits and _ only`);
    if (seen.has(item.code)) fail(`taxRates[${at}].code: ${item.code} is there twice`);
    if (!isValidRate(item.rate)) fail(`taxRates[${at}].rate: a percent from 0 to 100 with at most two decimals`);

    seen.add(item.code);

    return { code: item.code, label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : `${item.rate} %`, rate: item.rate };
  });
}

export interface LocaleInput {
  currency?: string | null;
  timezone?: string | null;
  timeZone?: string | null;
  defaultTaxRate?: unknown;
  taxRates?: unknown;
}

/** Turns anything a Prisma Decimal or a form may hold into a plain number; NaN when it is not one. */
function numberOf(value: unknown): number {
  return value === null || value === undefined || value === '' ? NaN : Number(String(value));
}

/**
 * The settings that `input` would make, without making them: a value that is not valid is an error (the settings are not
 * half applied), a value that is missing keeps the one of `base`. The administrators' form is checked with this before
 * anything is written, and `applyLocale` makes them the ones the server reads once they are saved.
 */
export function resolveLocale(input: LocaleInput, base: LocaleSettings = loaded ? current : DEFAULT_LOCALE): LocaleSettings {
  const next: LocaleSettings = { ...base, taxRates: base.taxRates.map((rate) => ({ ...rate })) };

  if (input.currency !== undefined && input.currency !== null) {
    if (!isValidCurrency(input.currency)) fail('currency: three capital letters, like TND');

    next.currency = input.currency;
  }

  const zone = input.timezone ?? input.timeZone;

  if (zone !== undefined && zone !== null) {
    if (!isValidTimeZone(zone)) fail('timezone: not a time zone known to this server');

    next.timeZone = zone;
  }

  if (input.taxRates !== undefined && input.taxRates !== null) next.taxRates = parseTaxRates(input.taxRates);

  if (input.defaultTaxRate !== undefined && input.defaultTaxRate !== null) {
    const rate = numberOf(input.defaultTaxRate);

    if (!isValidRate(rate)) fail('defaultTaxRate: a percent from 0 to 100 with at most two decimals');

    next.defaultTaxRate = rate;
  }

  if (!next.taxRates.some((entry) => entry.rate === next.defaultTaxRate)) {
    fail(`defaultTaxRate: ${next.defaultTaxRate} is not one of the rates of the list (${next.taxRates.map((entry) => entry.rate).join(', ')})`);
  }

  return frozen(next);
}

/** Makes the settings the ones every part of the server reads (see `resolveLocale` for what is refused). */
export function applyLocale(input: LocaleInput): LocaleSettings {
  current = resolveLocale(input);
  loaded = true;

  return current;
}

export function getLocale(): LocaleSettings {
  return current;
}

/** The settings as they were read from the database, or null while the server has not read them (and in a test). */
export function loadedLocale(): LocaleSettings | null {
  return loaded ? current : null;
}

export function currencyCode(): string {
  return current.currency;
}

/** For tests: back to the defaults, as if the settings had not been read. */
export function resetLocale(): void {
  current = DEFAULT_LOCALE;
  loaded = false;
}
