import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { describeError } from '../notifications/delivery/delivery-error';
import { deliveryAnswer } from '../notifications/delivery/delivery-answer';
import {
  isDeliverableEmail,
  maskEmail,
  maskPhone,
  newMadeUpGuestEmail,
} from '../notifications/delivery/contact';
import { getFrontendUrl } from '../../config/env';
import {
  canonicalEmail,
  RATE_RULES,
  RateLimitService,
} from '../../common/rate-limit/rate-limit.service';
import {
  EMAIL_TAKEN_MESSAGE,
  PHONE_TAKEN_MESSAGE,
  phoneColumns,
  phoneKeyOf,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';
import {
  generateLinkToken,
  generateSixDigitCode,
  hashLinkToken,
  hashOneTimeCode,
} from '../../common/auth/one-time-code';
import { AuthTokenType } from '../../../generated/prisma/client';
import { MESSAGES, localeOfUser, recipientLocale, say } from '../../common/i18n/messages';

const EMAIL_LINK_LIFE_MS = 60 * 60 * 1000;
const PHONE_CODE_LIFE_MS = 10 * 60 * 1000;

/** What the controller sends back to the caller code that needs to branch on it. */
export const CONTACT_CHANGE_REQUIRED = 'CONTACT_CHANGE_REQUIRES_VERIFICATION';

/**
 * The 400 answered when a plain profile update tries to change the e-mail or the
 * phone. `code` is stable, so an app can send the person to the right screen.
 */
export function contactChangeRequired(field: 'email' | 'phone'): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: CONTACT_CHANGE_REQUIRED,
    field,
    message:
      field === 'email'
        ? "Pour changer d'adresse e-mail, indiquez votre mot de passe actuel et confirmez la nouvelle adresse (POST /users/me/email-change)."
        : 'Pour changer de numéro de téléphone, indiquez votre mot de passe actuel et saisissez le code reçu par SMS (POST /users/me/phone-change).',
  });
}

/** What revoking tokens needs: the service's own client or the one of a running transaction. */
type TokenDb = { authToken: { updateMany: (args: any) => Promise<unknown> } };

type AccountRow = {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  phoneKey: string | null;
  password: string;
  isGuest: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  /** What the messages to this person are written in (P3-04); the role decides whether the back office gets French whatever this says. */
  role: string;
  locale: string;
};

/**
 * Changing the e-mail address or the phone number of an account (P1-03, step 4).
 *
 * Both are what a person uses to get back into their account (reset link, codes)
 * and what the platform uses to reach them, so a change needs two proofs:
 *   1. the CURRENT password (a stolen session alone is not enough), and
 *   2. a message to the NEW address / number that only its owner can read.
 * Until the second proof arrives, nothing changes on the account.
 *
 * Staff can still correct a contact by hand (prepareAdminChange): a customer who
 * lost their mailbox cannot prove anything, and the change is announced to the
 * old address.
 */
@Injectable()
export class ContactChangeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContactChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Says at start-up when the phone keys are not in place yet: the columns are
   * missing (prisma db push / migrate not run) or accounts still have a number
   * without a key (npm run phones:backfill not run). Never stops the server.
   */
  async onApplicationBootstrap() {
    try {
      const withoutKeyCount = await this.prisma.user.count({
        // Deleted accounts keep the text of their number and no key, on purpose.
        where: { phone: { not: null }, phoneKey: null, deletedAt: null },
      });

      if (withoutKeyCount > 0) {
        this.logger.warn(
          `${withoutKeyCount} account(s) have a phone number but no phone key: run "npm run phones:backfill" ` +
            '(dry run first). Until then a number can be given to two accounts. Accounts the script lists ' +
            'as duplicates or invalid stay in this count until staff fix their number.',
        );
      }
    } catch (error: any) {
      this.logger.error(
        `User.phoneKey could not be read (${describeError(error)}): run "npx prisma db push" (or your migration) ` +
          'and "npm run phones:backfill" before using phone numbers.',
      );
    }
  }

  // ==========================================================
  // Checks shared by both flows
  // ==========================================================

  private async loadAccount(userId: number): Promise<AccountRow> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        phoneKey: true,
        password: true,
        isGuest: true,
        isActive: true,
        deletedAt: true,
        role: true,
        locale: true,
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé.');
    }

    if (user.isGuest) {
      throw new BadRequestException(
        'Activez votre compte avant de modifier vos coordonnées.',
      );
    }

    return user;
  }

  /** Wrong passwords are counted per account, whatever the route (see passwordConfirmFailures). */
  async assertCurrentPassword(
    user: { id: number; password: string },
    currentPassword: string,
  ): Promise<void> {
    const lockKey = `password-confirm:${user.id}`;

    this.rateLimit.assertNotLocked(lockKey);
    // Counted BEFORE the slow check, not after it: forty requests sent at once
    // would otherwise all pass the lock test while none had failed yet.
    this.rateLimit.registerFailure(lockKey, RATE_RULES.passwordConfirmFailures);

    const valid = await argon2
      .verify(user.password, String(currentPassword ?? ''))
      .catch(() => false);

    if (!valid) {
      throw new BadRequestException('Mot de passe actuel incorrect.');
    }

    this.rateLimit.clear(lockKey);
  }

  private tooManyMessages(): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message:
          'Trop de messages ont déjà été envoyés à cette adresse ou ce numéro. Réessayez plus tard.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async revoke(userId: number, types: AuthTokenType[], db?: TokenDb) {
    const tokens = db ? db.authToken : this.prisma.authToken;

    await tokens.updateMany({
      where: { userId, type: { in: types }, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ==========================================================
  // E-mail: ask, then confirm with the link sent to the new address
  // ==========================================================

  async requestEmailChange(
    userId: number,
    input: { newEmail: string; currentPassword: string },
  ) {
    const user = await this.loadAccount(userId);

    await this.assertCurrentPassword(user, input.currentPassword);

    this.rateLimit.assertWithin(
      `contact-change-try:${user.id}`,
      RATE_RULES.contactChangeAttempts,
    );

    const email = String(input.newEmail ?? '').trim().toLowerCase();

    if (!isDeliverableEmail(email)) {
      throw new BadRequestException('Adresse e-mail invalide.');
    }

    if (email === user.email) {
      throw new BadRequestException(
        "Cette adresse est déjà celle de votre compte.",
      );
    }

    const holder = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, isGuest: true },
    });

    // An address that only a guest profile has (somebody typed it on a public form) can
    // be claimed: the link below, read in that mailbox, is a better proof than the
    // form was (see confirmEmailChange). A real account's address cannot.
    if (holder && !holder.isGuest) {
      throw new ConflictException(EMAIL_TAKEN_MESSAGE);
    }

    // Per account (cost, spam) and per destination (somebody else's mailbox).
    this.rateLimit.assertWithin(
      `email-change:${user.id}`,
      RATE_RULES.codeSendPerTarget,
    );

    // One mailbox gets a few of these an hour whoever asks. The counter is this
    // flow's own: the public forms use another one, so they cannot use it up.
    const mailbox = canonicalEmail(email);

    if (!mailbox || !this.rateLimit.tryConsume(`contact-send:email:${mailbox}`, RATE_RULES.codeSendPerDestination)) {
      this.tooManyMessages();
    }

    const rawToken = generateLinkToken();

    await this.revoke(user.id, [AuthTokenType.EMAIL_CHANGE]);

    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type: AuthTokenType.EMAIL_CHANGE,
        tokenHash: hashLinkToken(rawToken),
        newValue: email,
        expiresAt: new Date(Date.now() + EMAIL_LINK_LIFE_MS),
      },
    });

    const link = `${getFrontendUrl()}/confirm-email-change?token=${rawToken}`;

    const locale = recipientLocale(user);

    const queued = await this.notifications.sendEmail(
      email,
      say(MESSAGES.auth.emailChange.subject, locale),
      say(MESSAGES.auth.emailChange.body, locale, { link }),
      {
        userId: user.id,
        locale,
        template: {
          key: 'auth.email_change',
          vars: { name: user.name, link },
        },
        validForMs: EMAIL_LINK_LIFE_MS,
        replaces: `auth:EMAIL_CHANGE:${user.id}`,
      },
    );

    return deliveryAnswer(
      queued,
      this.notifications.isEmailSimulated(),
      'email',
      'Un lien de confirmation a été envoyé à la nouvelle adresse. Votre adresse actuelle ne change qu’après ce clic.',
    );
  }

  async confirmEmailChange(token: string) {
    const record = await this.prisma.authToken.findFirst({
      where: {
        tokenHash: hashLinkToken(String(token ?? '')),
        type: AuthTokenType.EMAIL_CHANGE,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    const invalid = () =>
      new BadRequestException('Lien invalide ou expiré.');

    if (!record || !record.newValue) throw invalid();

    const user = record.user;

    if (user.isGuest || !user.isActive || user.deletedAt) throw invalid();

    const newEmail = record.newValue;
    const oldEmail = user.email;
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        // Single use, and safe when the link is clicked twice at the same moment.
        const claimed = await tx.authToken.updateMany({
          where: { id: record.id, usedAt: null, revokedAt: null },
          data: { usedAt: now, revokedAt: now },
        });

        if (claimed.count !== 1) throw invalid();

        // The link was read in the new mailbox. A guest profile that only has this
        // address because somebody typed it on a public form gives it up (it keeps its
        // requests, under an address nobody can read); a real account's address stays.
        const holder = await tx.user.findUnique({
          where: { email: newEmail },
          select: { id: true, isGuest: true },
        });

        if (holder && holder.id !== user.id) {
          if (!holder.isGuest) throw new ConflictException(EMAIL_TAKEN_MESSAGE);

          await tx.user.update({
            where: { id: holder.id },
            data: { email: newMadeUpGuestEmail() },
          });

          await this.revoke(holder.id, [AuthTokenType.GUEST_MAGIC_LINK], tx);
        }

        await tx.user.update({
          where: { id: user.id },
          data: { email: newEmail, emailVerifiedAt: now },
        });

        // Links that were sent to the OLD mailbox must not work any more:
        // whoever can still read it could otherwise reset the password.
        await tx.authToken.updateMany({
          where: {
            userId: user.id,
            type: {
              in: [
                AuthTokenType.PASSWORD_RESET,
                AuthTokenType.EMAIL_VERIFICATION,
                AuthTokenType.EMAIL_CHANGE,
              ],
            },
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
      });
    } catch (error) {
      rethrowContactConflict(error);
    }

    await this.noticeEmailChanged(user, oldEmail, newEmail, 'self');

    return { message: 'Adresse e-mail modifiée. Utilisez-la pour vous connecter.' };
  }

  // ==========================================================
  // Phone: ask, then confirm with the code sent to the new number
  // ==========================================================

  async requestPhoneChange(
    userId: number,
    input: { newPhone: string; currentPassword: string },
  ) {
    const user = await this.loadAccount(userId);

    await this.assertCurrentPassword(user, input.currentPassword);

    this.rateLimit.assertWithin(
      `contact-change-try:${user.id}`,
      RATE_RULES.contactChangeAttempts,
    );

    const { phone, phoneKey } = phoneColumns(input.newPhone);

    if (!phone || !phoneKey) {
      throw new BadRequestException('Numéro de téléphone invalide.');
    }

    if (phoneKey === user.phoneKey || phoneKey === phoneKeyOf(user.phone)) {
      throw new BadRequestException(
        'Ce numéro est déjà celui de votre compte.',
      );
    }

    // A number whose owner never proved it can be claimed by the person who does:
    // the code sent below is that proof (see confirmPhoneChange). A VERIFIED number
    // is not for sale.
    const holder = await this.prisma.user.findFirst({
      where: {
        ...phoneWhere(phone),
        NOT: { id: user.id },
        phoneVerifiedAt: { not: null },
      },
      select: { id: true },
    });

    if (holder) {
      throw new ConflictException(PHONE_TAKEN_MESSAGE);
    }

    this.rateLimit.assertWithin(
      `phone-change:${user.id}`,
      RATE_RULES.codeSendPerTarget,
    );

    if (!this.rateLimit.tryConsume(`contact-send:sms:${phoneKey}`, RATE_RULES.codeSendPerDestination)) {
      this.tooManyMessages();
    }

    const code = generateSixDigitCode();

    await this.revoke(user.id, [AuthTokenType.PHONE_CHANGE]);

    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type: AuthTokenType.PHONE_CHANGE,
        tokenHash: hashOneTimeCode(user.id, 'phone-change', code),
        newValue: phone,
        expiresAt: new Date(Date.now() + PHONE_CODE_LIFE_MS),
      },
    });

    const locale = recipientLocale(user);

    const queued = await this.notifications.sendSms(
      phone,
      say(MESSAGES.auth.phoneCode.sms, locale, { code }),
      {
        userId: user.id,
        locale,
        template: { key: 'auth.phone_code', vars: { name: user.name, code } },
        validForMs: PHONE_CODE_LIFE_MS,
        replaces: `auth:PHONE_CHANGE:${user.id}`,
      },
    );

    return deliveryAnswer(
      queued,
      this.notifications.isSmsSimulated(),
      'sms',
      'Un code a été envoyé par SMS au nouveau numéro. Votre numéro actuel ne change qu’après sa saisie.',
    );
  }

  async confirmPhoneChange(userId: number, code: string) {
    const lockKey = `otp:phone-change:${userId}`;

    this.rateLimit.assertNotLocked(lockKey);
    // Counted before the lookup (see assertCurrentPassword), cleared when the code is right.
    this.rateLimit.registerFailure(lockKey, RATE_RULES.otpFailures);

    const user = await this.loadAccount(userId);

    const record = await this.prisma.authToken.findFirst({
      where: {
        userId: user.id,
        type: AuthTokenType.PHONE_CHANGE,
        tokenHash: hashOneTimeCode(user.id, 'phone-change', code),
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!record || !record.newValue) {
      throw new BadRequestException('Code invalide ou expiré.');
    }

    this.rateLimit.clear(lockKey);

    const columns = phoneColumns(record.newValue);
    const oldPhone = user.phone;
    const now = new Date();
    let released: Array<{ id: number; name: string | null; email: string; role?: string; locale?: string }> = [];

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.authToken.updateMany({
          where: { id: record.id, usedAt: null, revokedAt: null },
          data: { usedAt: now, revokedAt: now },
        });

        if (claimed.count !== 1) {
          throw new BadRequestException('Code invalide ou expiré.');
        }

        // The code just proved this person owns the number. An account that holds it
        // without ever having proved it (a guest profile made from a public form, a
        // sign-up with somebody else's number) gives it up; one that proved it first
        // keeps it.
        const holders = await tx.user.findMany({
          where: { ...phoneWhere(columns.phone), NOT: { id: user.id } },
          select: { id: true, name: true, email: true, phone: true, phoneVerifiedAt: true, role: true, locale: true },
        });

        if (holders.some((holder) => holder.phoneVerifiedAt)) {
          throw new ConflictException(PHONE_TAKEN_MESSAGE);
        }

        for (const holder of holders) {
          // The requests of that account keep a way to call the person back: the
          // number moves to the request, as a guest request made without a profile number has it.
          if (holder.phone) {
            await tx.intervention.updateMany({
              where: { clientId: holder.id, contactPhone: null },
              data: { contactPhone: holder.phone },
            });
          }

          if (holder.name) {
            await tx.intervention.updateMany({
              where: { clientId: holder.id, contactName: null },
              data: { contactName: holder.name },
            });
          }

          await tx.user.update({
            where: { id: holder.id },
            data: { phone: null, phoneKey: null, phoneVerifiedAt: null },
          });
        }

        released = holders.map(({ id, name, email, role, locale }) => ({ id, name, email, role, locale }));

        await tx.user.update({
          where: { id: user.id },
          data: { ...columns, phoneVerifiedAt: now },
        });

        // A code sent to the old number must not verify anything any more.
        await tx.authToken.updateMany({
          where: {
            userId: user.id,
            type: {
              in: [AuthTokenType.PHONE_VERIFICATION, AuthTokenType.PHONE_CHANGE],
            },
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
      });
    } catch (error) {
      rethrowContactConflict(error);
    }

    await this.noticePhoneChanged(user, oldPhone, columns.phone);

    for (const other of released) {
      await this.noticePhoneReleased(other);
    }

    return { message: 'Numéro de téléphone modifié et vérifié.' };
  }

  // ==========================================================
  // Staff corrections (admin dashboard)
  // ==========================================================

  /**
   * Checks a contact correction made by staff and returns the columns to write.
   * Nothing is written here: the caller does its own update (inside its own
   * select/transaction) and then calls finishAdminChange. Verification flags
   * are reset because nobody has proved ownership of the new value.
   */
  async prepareAdminChange(
    current: {
      id: number;
      email: string;
      phone: string | null;
      phoneKey?: string | null;
    },
    input: { email?: string; phone?: string | null },
  ): Promise<{
    data: Record<string, unknown>;
    emailChangedFrom?: string;
    phoneChangedFrom?: string | null;
  }> {
    const data: Record<string, unknown> = {};
    let emailChangedFrom: string | undefined;
    let phoneChangedFrom: string | null | undefined;

    if (input.email !== undefined && input.email !== null) {
      const email = String(input.email).trim().toLowerCase();

      if (!isDeliverableEmail(email)) {
        throw new BadRequestException('Adresse e-mail invalide.');
      }

      if (email !== current.email) {
        const holder = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (holder && holder.id !== current.id) {
          throw new ConflictException(EMAIL_TAKEN_MESSAGE);
        }

        data.email = email;
        data.emailVerifiedAt = null;
        emailChangedFrom = current.email;
      }
    }

    // Posting the number the account already has (a form that sends everything) changes
    // nothing, even when that number could not be read as a phone number (an old record).
    const sameText = input.phone !== undefined && String(input.phone ?? '').trim() === (current.phone ?? '').trim();

    if (input.phone !== undefined && !sameText) {
      const columns = phoneColumns(input.phone);
      const currentKey = current.phoneKey ?? phoneKeyOf(current.phone);

      if (columns.phoneKey !== currentKey || columns.phone !== current.phone) {
        if (columns.phoneKey) {
          const holder = await this.prisma.user.findFirst({
            where: { ...phoneWhere(columns.phone), NOT: { id: current.id } },
            select: { id: true },
          });

          if (holder) {
            throw new ConflictException(PHONE_TAKEN_MESSAGE);
          }
        }

        data.phone = columns.phone;
        data.phoneKey = columns.phoneKey;

        // The same number typed differently is still the same, verified, number.
        if (columns.phoneKey !== currentKey) {
          data.phoneVerifiedAt = null;
          phoneChangedFrom = current.phone;
        }
      }
    }

    return { data, emailChangedFrom, phoneChangedFrom };
  }

  /**
   * Staff changed an e-mail or a phone: links and codes that went to the old mailbox
   * or number stop working (a guest's activation link included). Called inside the
   * same transaction as the update, so a change never stays in place with the old
   * links still alive.
   */
  async revokeAfterAdminChange(
    db: TokenDb,
    userId: number,
    result: { emailChangedFrom?: string; phoneChangedFrom?: string | null },
  ) {
    if (result.emailChangedFrom) {
      await this.revoke(
        userId,
        [
          AuthTokenType.PASSWORD_RESET,
          AuthTokenType.EMAIL_VERIFICATION,
          AuthTokenType.EMAIL_CHANGE,
          AuthTokenType.GUEST_MAGIC_LINK,
        ],
        db,
      );
    }

    if (result.phoneChangedFrom !== undefined) {
      await this.revoke(
        userId,
        [
          AuthTokenType.PHONE_VERIFICATION,
          AuthTokenType.PHONE_CHANGE,
          AuthTokenType.GUEST_OTP,
        ],
        db,
      );
    }
  }

  /** After the change was made: the person is told (never fails the change). */
  async noticeAfterAdminChange(
    user: { id: number; name?: string | null },
    result: { emailChangedFrom?: string; phoneChangedFrom?: string | null },
    updated: { email?: string; phone?: string | null },
  ) {
    // The notice is written in the language of the person it is about (French for the back office), read once for both.
    const locale = result.emailChangedFrom || result.phoneChangedFrom !== undefined ? await localeOfUser(this.prisma, user.id) : undefined;

    if (result.emailChangedFrom && updated.email) {
      await this.noticeEmailChanged(
        { ...user, locale },
        result.emailChangedFrom,
        updated.email,
        'support',
      );
    }

    if (result.phoneChangedFrom !== undefined) {
      // The notice goes to the account's e-mail address as it is now.
      const account = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { email: true },
      });

      if (account) {
        await this.noticePhoneChanged(
          { id: user.id, name: user.name ?? null, email: account.email, locale },
          result.phoneChangedFrom,
          updated.phone ?? null,
        );
      }
    }
  }

  // ==========================================================
  // Notices (never block, never fail the change that was already made)
  // ==========================================================

  private async noticeEmailChanged(
    user: { id: number; name?: string | null; role?: string | null; locale?: string | null },
    oldEmail: string,
    newEmail: string,
    by: 'self' | 'support',
  ) {
    if (!isDeliverableEmail(oldEmail)) return;

    try {
      const locale = recipientLocale(user);
      const body = by === 'support' ? MESSAGES.auth.emailChangedNotice.bodyBySupport : MESSAGES.auth.emailChangedNotice.body;

      await this.notifications.sendEmail(
        oldEmail,
        say(MESSAGES.auth.emailChangedNotice.subject, locale),
        say(body, locale, { newEmail: maskEmail(newEmail) }),
        {
          userId: user.id,
          locale,
          template: {
            key: 'auth.email_changed_notice',
            vars: { name: user.name, newEmail: maskEmail(newEmail), by },
          },
        },
      );
    } catch (error: any) {
      this.logger.warn(`E-mail change notice not queued (${describeError(error)})`);
    }
  }

  /** The number was claimed by somebody who proved they own it: the account that held it is told. */
  private async noticePhoneReleased(user: { id: number; name: string | null; email: string; role?: string | null; locale?: string | null }) {
    if (!isDeliverableEmail(user.email)) return;

    try {
      const locale = recipientLocale(user);

      await this.notifications.sendEmail(
        user.email,
        say(MESSAGES.auth.phoneReleasedNotice.subject, locale),
        say(MESSAGES.auth.phoneReleasedNotice.body, locale),
        {
          userId: user.id,
          locale,
          template: { key: 'auth.phone_released_notice', vars: { name: user.name } },
        },
      );
    } catch (error: any) {
      this.logger.warn(`Phone release notice not queued (${describeError(error)})`);
    }
  }

  private async noticePhoneChanged(
    user: { id: number; name: string | null; email: string; role?: string | null; locale?: string | null },
    oldPhone: string | null,
    newPhone: string | null,
  ) {
    if (!isDeliverableEmail(user.email)) return;

    try {
      const locale = recipientLocale(user);
      const notice = MESSAGES.auth.phoneChangedNotice;
      const body = newPhone
        ? oldPhone
          ? say(notice.bodyChangedFrom, locale, { newPhone: maskPhone(newPhone), oldPhone: maskPhone(oldPhone) })
          : say(notice.bodyChanged, locale, { newPhone: maskPhone(newPhone) })
        : oldPhone
          ? say(notice.bodyRemovedFrom, locale, { oldPhone: maskPhone(oldPhone) })
          : say(notice.bodyRemoved, locale);

      await this.notifications.sendEmail(user.email, say(notice.subject, locale), body, {
        userId: user.id,
        locale,
        template: {
          key: 'auth.phone_changed_notice',
          vars: {
            name: user.name,
            newPhone: newPhone ? maskPhone(newPhone) : '',
            oldPhone: oldPhone ? maskPhone(oldPhone) : '',
          },
        },
      });
    } catch (error: any) {
      this.logger.warn(`Phone change notice not queued (${describeError(error)})`);
    }
  }
}
