import { BadRequestException, ConflictException } from '@nestjs/common';

import { readDeliveryConfig } from '../../config/delivery';
import { toE164 } from '../../modules/notifications/delivery/contact';

/**
 * One phone number, one account (P1-03, step 4).
 *
 * `User.phone` keeps what the person typed ("22 123 456"); `User.phoneKey` keeps
 * the same number in one canonical spelling ("+21622123456") and carries the
 * UNIQUE constraint. The two columns are always written together, through
 * phoneColumns(): a guard spec fails the build if a User write sets `phone`
 * without it.
 */

export const INVALID_PHONE_MESSAGE = 'Numéro de téléphone invalide.';
export const PHONE_TAKEN_MESSAGE = 'Ce numéro de téléphone est déjà utilisé.';
export const EMAIL_TAKEN_MESSAGE = 'Cet email est déjà utilisé.';
export const EMAIL_OR_PHONE_TAKEN_MESSAGE =
  'Cet email ou ce numéro de téléphone est déjà utilisé.';

/** "22 123 456" → "+21622123456"; null when it is empty or cannot be a phone number. */
export function phoneKeyOf(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();

  if (!text) return null;

  return toE164(text, readDeliveryConfig(process.env).defaultCountryCode);
}

export type PhoneColumns = { phone: string | null; phoneKey: string | null };

/**
 * The two columns to write for a phone number. Empty means "no number".
 * A number that cannot be a phone number is refused (400): it could never
 * receive an SMS and it could never be compared with another.
 */
export function phoneColumns(raw: string | null | undefined): PhoneColumns {
  const text = String(raw ?? '').trim();

  if (!text) return { phone: null, phoneKey: null };

  const phoneKey = phoneKeyOf(text);

  if (!phoneKey) {
    throw new BadRequestException(INVALID_PHONE_MESSAGE);
  }

  return { phone: text, phoneKey };
}

/**
 * `where` clause for "the account that has this number". Matches the canonical
 * key and, for rows written before the key existed (or that lost a duplicate
 * in the backfill), the text as it was typed.
 */
export function phoneWhere(raw: string | null | undefined):
  | { OR: Array<{ phoneKey: string } | { phone: string; deletedAt: null }> }
  | { phone: string; deletedAt: null }
  | { id: { in: number[] } } {
  const text = String(raw ?? '').trim();

  // Nothing to look for matches NOTHING. A where clause that silently lost its
  // phone condition would match every account.
  if (!text) return { id: { in: [] } };

  const key = phoneKeyOf(text);

  // The text is the fallback for rows without a key (written before the key existed).
  // A deleted account has given its number up: it never counts as the holder.
  return key
    ? { OR: [{ phoneKey: key }, { phone: text, deletedAt: null }] }
    : { phone: text, deletedAt: null };
}

/** True for Prisma's "unique constraint failed" error (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (error as any)?.code === 'P2002';
}

/**
 * Which column a P2002 is about. Prisma reports it in `meta.target` (classic
 * engine) or inside the driver error (driver adapters), so the whole `meta` is
 * searched instead of one shape.
 */
/** True when the error says which column (or constraint) was violated, whichever shape it has. */
function violationNamesAColumn(error: unknown): boolean {
  try {
    const e = error as any;
    const meta = e?.meta ?? {};

    return Boolean(
      meta.target ||
        meta.constraint ||
        meta.driverAdapterError?.cause?.constraint ||
        /Unique constraint failed on the (fields|constraint)/i.test(String(e?.message ?? '')),
    );
  } catch {
    return false;
  }
}

function violationMentions(error: unknown, field: string): boolean {
  try {
    const e = error as any;

    // The message of a Prisma error may start with the code of the failing call
    // (which can mention any column), so only the sentence that names the
    // violated column is read.
    const sentence = String(e?.message ?? '').match(/Unique constraint failed on the (?:fields?|constraint):?[^\n]*/i)?.[0] ?? '';

    return JSON.stringify([e?.meta ?? {}, e?.cause ?? {}]).includes(field) || sentence.includes(field);
  } catch {
    return false;
  }
}

/**
 * Turns "unique constraint failed" on a User write into the 409 the person
 * should see; anything else is rethrown untouched. Call it in the `catch` of a
 * User write (and only there: it assumes the column is e-mail or phone).
 */
export function rethrowContactConflict(error: unknown): never {
  if (isUniqueViolation(error)) {
    if (violationMentions(error, 'phoneKey')) {
      throw new ConflictException(PHONE_TAKEN_MESSAGE);
    }

    if (violationMentions(error, 'email')) {
      throw new ConflictException(EMAIL_TAKEN_MESSAGE);
    }

    // A User row has only two unique details besides its id, so a violation that
    // names no column at all (the shape differs between Prisma engines and driver
    // adapters) is still one of the two. One that names another column is not ours.
    if (!violationNamesAColumn(error)) {
      throw new ConflictException(EMAIL_OR_PHONE_TAKEN_MESSAGE);
    }
  }

  throw error;
}
