import * as crypto from 'crypto';

/**
 * Six-digit codes sent by SMS (phone verification, phone change, guest
 * activation). There are only a million of them, so two people waiting for a
 * code at the same time can get the same one. AuthToken.tokenHash is UNIQUE,
 * which turned that coincidence into a server error. The code is therefore
 * hashed together with the id of the user it was made for AND what it is for:
 * the same digits give different hashes for two people, and for one person
 * waiting for two kinds of code (the code for the phone they have, the code
 * for the phone they are adding). A code only ever matches its own user and
 * its own purpose.
 */
export type CodePurpose = 'phone-verification' | 'phone-change' | 'guest-activation';

/** CSPRNG, not Math.random(): a 6 digit code is only as strong as its source. */
export function generateSixDigitCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function hashOneTimeCode(userId: number, purpose: CodePurpose, code: string): string {
  return crypto
    .createHash('sha256')
    .update(`code:${purpose}:${userId}:${String(code).trim()}`)
    .digest('hex');
}

/** A long random value for links (e-mail verification, e-mail change...). */
export function generateLinkToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashLinkToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
