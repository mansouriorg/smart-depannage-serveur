/** Phone numbers and e-mail addresses: formatting for providers, hiding for logs. */
import { randomUUID } from 'crypto';

/**
 * A phone number as providers want it (E.164: "+21622123456"), or null when it
 * cannot be one. National numbers get the default country code; "00216..." and
 * "216..." written without a plus are understood.
 */
export function toE164(raw: string, defaultCountryCode = '216'): string | null {
  let value = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  const country = defaultCountryCode.replace(/\D/g, '');

  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }

  if (value.startsWith('+')) {
    let digits = value.slice(1);

    // "+216 0 22123456": a national "0" written after the country code is not part of the number.
    if (country && digits.startsWith(`${country}0`)) {
      digits = `${country}${digits.slice(country.length).replace(/^0+/, '')}`;
    }

    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  // "21622123456": the country code is already there (a national number is 8 digits)
  if (country && value.startsWith(country) && value.length >= country.length + 8) {
    const rest = value.slice(country.length).replace(/^0+/, '');
    const digits = `${country}${rest}`;

    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }

  const national = value.replace(/^0+/, '');
  const full = `${country}${national}`;

  return national && /^[1-9]\d{7,14}$/.test(full) ? `+${full}` : null;
}

/**
 * False for what cannot receive mail: no address, no "@", or a reserved domain.
 * Guests created from the website get a made-up address
 * ("guest_<id>@guest.smart-depannage.local") because the table needs one; mail
 * to it can only bounce.
 */
export function isDeliverableEmail(value: string | null | undefined): boolean {
  const email = String(value ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');

  if (at < 1 || at === email.length - 1) return false;

  if (isMadeUpGuestEmail(email)) return false;

  const domain = email.slice(at + 1);

  if (!domain.includes('.') || /\s/.test(email)) return false;

  const last = domain.slice(domain.lastIndexOf('.') + 1);

  // .local, .invalid, .test, .example and .localhost are reserved: no mailbox can exist there
  return !['local', 'invalid', 'test', 'example', 'localhost'].includes(last);
}

/**
 * The address a guest profile gets when the person gave no e-mail: it only exists
 * because the table needs one. Two shapes exist: the current one
 * ("guest_<uuid>@guest.smart-depannage.local") and the one the legacy route made
 * ("guest_<number>@smart-depannage.com", a real domain: mail to it would go nowhere).
 */
export function isMadeUpGuestEmail(value: string | null | undefined): boolean {
  const email = String(value ?? '').trim().toLowerCase();

  return email.endsWith('@guest.smart-depannage.local') || /^guest_\d+@smart-depannage\.com$/.test(email);
}

/** A new made-up address for a guest profile that has no mailbox of its own. */
export function newMadeUpGuestEmail(): string {
  return `guest_${randomUUID()}@guest.smart-depannage.local`;
}

/** "+216 ***** 456": enough to recognise the number, not to use it. */
export function maskPhone(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/[^\d+]/g, '');

  if (digits.length < 6) return '***';

  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(digits.length - 7, 1))}${digits.slice(-3)}`;
}

/** "a***@e***.tn" */
export function maskEmail(value: string | null | undefined): string {
  const [local = '', domain = ''] = String(value ?? '').split('@');

  if (!local || !domain) return '***';

  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';

  return `${local[0]}***@${host[0] ?? ''}***${tld}`;
}
