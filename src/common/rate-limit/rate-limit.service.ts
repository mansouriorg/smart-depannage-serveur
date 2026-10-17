import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { readDeliveryConfig } from '../../config/delivery';
import { toE164 } from '../../modules/notifications/delivery/contact';

import {
  FailureRule,
  HitResult,
  RateLimiter,
  WindowRule,
} from './rate-limiter';

/** Shared rules, so the numbers live in one place. */
export const RATE_RULES = {
  /**
   * Wrong password for one account from one client address. Locks only that
   * client: someone who types an admin's email five times must not be able to
   * lock the admin out.
   */
  loginFailuresPerClient: {
    maxFailures: 5,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /**
   * Wrong passwords for one account from any address. Much higher than the
   * per-client rule: it only trips when many addresses attack one account.
   */
  loginFailuresPerAccount: {
    maxFailures: 30,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /**
   * Wrong "current password" typed while asking for something that needs it
   * (changing the password, the e-mail or the phone). Counted per account: a
   * stolen session must not be able to guess the password at machine speed.
   */
  passwordConfirmFailures: {
    maxFailures: 5,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /** Wrong one-time code for one phone / user. */
  otpFailures: {
    maxFailures: 5,
    windowMs: 10 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /** Reset links requested for one email (silent, no error is shown). */
  forgotPasswordPerEmail: {
    limit: 3,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * Requests to change an e-mail or a phone number from one account. The
   * messages themselves are capped by codeSendPerTarget; this caps the tries,
   * including those refused before anything is sent ("address already used"),
   * so the route cannot be used to ask which addresses and numbers exist.
   */
  contactChangeAttempts: {
    limit: 15,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /** SMS / email codes sent to one phone / user (SMS cost and spam). */
  codeSendPerTarget: {
    limit: 3,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * Messages one ADDRESS or NUMBER may receive from the contact-change and
   * activation flows, whoever asks. Higher than what one requester may send
   * (codeSendPerTarget, counted per account or per client address), so a single
   * troublemaker cannot use up the quota of the real owner and keep them out.
   */
  codeSendPerDestination: {
    limit: 10,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * The SMS that tells the person in charge about a new request (ADMIN_ALERT_PHONE),
   * counted for the whole server: whatever visitors or accounts do, it stays a
   * handful of paid SMS an hour, not one per request.
   */
  adminAlertSms: {
    limit: 20,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * Messages that a public form (guest request, artisan application) sends to
   * whatever phone number or e-mail address was typed into it.
   */
  publicSendPerTarget: {
    limit: 3,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * Photo uploads through the tracking link of one request (a call may carry
   * several pictures). Counted per request, on top of the limit per visitor
   * address: a link shared around cannot fill the disk.
   */
  guestPhotoUploads: {
    limit: 10,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /**
   * Problems reported through the tracking link of one request. Each one opens a
   * complaint that staff must read, so a few a day are plenty; the durable cap
   * (GUEST_COMPLAINT_CEILING in the guest service) is counted in the database.
   */
  guestProblemReports: {
    limit: 3,
    windowMs: 24 * 60 * 60_000,
  } satisfies WindowRule,
} as const;

/**
 * One inbox, one name: lower case, no "+tag" ("a+1@x.tn" and "a+2@x.tn" are the
 * same mailbox), and no dots in Gmail addresses (a.b@gmail.com is ab@gmail.com).
 * Null when it is not an address.
 */
export function canonicalEmail(value: string): string | null {
  const email = String(value ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');

  if (at < 1 || at === email.length - 1) return null;

  let local = email.slice(0, at).split('+')[0];
  let domain = email.slice(at + 1);

  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');

  return local ? `${local}@${domain}` : null;
}

@Injectable()
export class RateLimitService {
  private readonly limiter = new RateLimiter();

  /** Counts a call; throws 429 when over the limit. */
  assertWithin(key: string, rule: WindowRule): void {
    const result = this.limiter.hit(key, rule);

    if (!result.allowed) {
      this.throwTooMany(result.retryAfterMs);
    }
  }

  /** Counts a call and returns false (instead of throwing) when over the limit. */
  tryConsume(key: string, rule: WindowRule): boolean {
    return this.limiter.hit(key, rule).allowed;
  }

  /**
   * A public form can name any phone number or e-mail address, so what it
   * sends is capped per destination: the site cannot be used to flood
   * somebody, or to run up the SMS bill. Counts one message to this target and
   * returns false when the target already got its share; the caller then just
   * does not send (and does not tell the visitor, who could be probing).
   */
  allowSendTo(kind: 'sms' | 'email', target: string): boolean {
    const destination =
      kind === 'email' ? canonicalEmail(target) : toE164(target, readDeliveryConfig(process.env).defaultCountryCode);

    // Not something a message can be sent to: nothing is sent, and nothing shares a counter by accident.
    if (!destination) return false;

    return this.tryConsume(`public-send:${kind}:${destination}`, RATE_RULES.publicSendPerTarget);
  }

  /** Counts a call and returns the full result, including the time left. */
  consume(key: string, rule: WindowRule): HitResult {
    return this.limiter.hit(key, rule);
  }

  /** Throws 429 while the key is locked after repeated failures. */
  assertNotLocked(key: string): void {
    const lockedForMs = this.limiter.lockedForMs(key);

    if (lockedForMs > 0) {
      this.throwTooMany(lockedForMs);
    }
  }

  registerFailure(key: string, rule: FailureRule): void {
    this.limiter.registerFailure(key, rule);
  }

  clear(key: string): void {
    this.limiter.clear(key);
  }

  private throwTooMany(retryAfterMs: number): never {
    const retryAfterSeconds = Math.max(Math.ceil(retryAfterMs / 1000), 1);
    const minutes = Math.ceil(retryAfterSeconds / 60);

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message:
          minutes > 1
            ? `Trop de tentatives. Réessayez dans ${minutes} minutes.`
            : 'Trop de tentatives. Réessayez dans une minute.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
