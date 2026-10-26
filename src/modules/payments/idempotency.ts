/**
 * Idempotency keys (P2-10). A caller that may repeat a request (a phone that lost the answer, a second click, a retry of a proxy) sends
 * a key with it (the `Idempotency-Key` header); the same key is the same request, answered with what the first one made, once.
 *
 * The key is kept with a scope that says whose it is (`c12:` a signed-in customer, `g340:` the holder of the tracking link of job 340,
 * `r58:` the refunds of payment 58), so that two people who chose the same key do not meet.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

export const KEY_WORDS = {
  invalid: 'La clé d’idempotence est invalide : 100 caractères au plus, des lettres, des chiffres et _ . : -',
  used: 'Cette clé d’idempotence a déjà servi pour une autre demande.',
};

/** The key as it is kept, or undefined when the caller sent none (an empty header is no key). */
export function readIdempotencyKey(raw: unknown, scope: string): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === undefined || value === null) return undefined;

  const text = typeof value === 'string' ? value.trim() : '';

  if (text === '') return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) throw new BadRequestException(KEY_WORDS.invalid);

  return `${scope}:${text}`;
}

/**
 * A key found taken at the last moment: the database refuses a second row with the same key (two requests of one caller at once, for
 * two different jobs, are not under the same lock). The answer is the one for a key used for another request, not a server error.
 */
export function asKeyConflict(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  return code === 'P2002' ? new ConflictException(KEY_WORDS.used) : error;
}
