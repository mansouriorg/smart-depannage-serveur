import { DEFAULT_LOCALE, LOCALE_HEADER, Locale, localeOf } from '../i18n';
import { Permission, can } from '../../auth/permissions';

/**
 * The language an app says it shows, or null when the request does not say (no header, or a language the product does not speak).
 * `requestLocale` answers French in both cases; this tells the two apart, for the places where "no header" must change nothing.
 */
export function declaredLocale(request: { headers?: Record<string, string | string[] | undefined> } | null | undefined): Locale | null {
  const raw = request?.headers?.[LOCALE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return localeOf(value);
}

/**
 * The language to write to a person. The back office is always written to in French, whatever the account says (the dashboard
 * stays French). Anybody else gets the language they chose; a person who chose none (or a row that does not say) gets French.
 * `fallback` is for a destination with no account at all (a phone number or an address typed in a form): the language of the
 * request that caused the message.
 */
export function recipientLocale(
  user: { role?: string | null; locale?: unknown } | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!user) return fallback;

  if (user.role && can(user.role, Permission.BACK_OFFICE_ACCESS)) return DEFAULT_LOCALE;

  return localeOf(user.locale) ?? DEFAULT_LOCALE;
}

/** The language to write to an account that is known only by its id. Never throws: a row that cannot be read means French. */
export async function localeOfUser(
  // Anything with a `user` table: the PrismaService, a transaction, or the stand-in of a spec.
  db: any,
  userId: number | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Promise<Locale> {
  if (typeof userId !== 'number' || typeof db?.user?.findUnique !== 'function') return fallback;

  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, locale: true } });

    return recipientLocale(user, fallback);
  } catch {
    return fallback;
  }
}
