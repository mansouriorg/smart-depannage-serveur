import { DEFAULT_LOCALE, LOCALE_HEADER, Locale, localeOf } from './i18n';

/**
 * The language an app says it shows (P3-04): the `X-App-Locale` header of the request, "fr" when it is missing or names a language
 * the product does not speak. The dashboard never sends it, so it always gets French, whatever language its browser is set to.
 */
export function requestLocale(request: { headers?: Record<string, string | string[] | undefined> } | null | undefined): Locale {
  const raw = request?.headers?.[LOCALE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return localeOf(value) ?? DEFAULT_LOCALE;
}
