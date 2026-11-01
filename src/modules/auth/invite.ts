import { PrismaService } from '../../prisma/prisma.service';

import { MESSAGES, recipientLocale, say } from '../../common/i18n/messages';

import { PASSWORD_SETUP_TTL_MS, issuePasswordSetupLink } from './password-setup';

/**
 * The invitation of an artisan to choose a password (P1-11): one function for the two ways an
 * artisan account comes to exist without a password chosen by its owner.
 *
 *  - `approved`: an applicant whose application the back office accepted;
 *  - `created`: an artisan the back office added by hand (the "Add technician" form).
 *
 * Both used to have their own copy of the same code (the token, the e-mail, the SMS), and a third
 * one sat in the older application chain. The link is the regular single-use password-reset token
 * (24 h, a newer one revokes the previous one), sent by e-mail and, when there is a number, by SMS.
 * While no mail server is configured (`isEmailSimulated`) the mail cannot arrive, so the link is
 * returned to the staff member, who hands it over in person or by message. It is never returned
 * otherwise: whoever reads the answer of the route could take over the account.
 */
export type InviteReason = 'approved' | 'created';

type Notifier = {
  sendEmail: (to: string, subject: string, content: string, options?: any) => Promise<unknown>;
  sendSms: (to: string, content: string, options?: any) => Promise<unknown>;
  isEmailSimulated: () => boolean;
};

export type InviteDeps = { prisma: PrismaService; notifications: Notifier };

/** `locale`: the language the technician chose (French when the row does not say; the invitation of an accepted applicant is in the language they applied in). */
export type InviteTarget = { id: number; email: string; name: string; phone?: string | null; locale?: string | null };

export async function inviteArtisan(
  deps: InviteDeps,
  user: InviteTarget,
  reason: InviteReason,
): Promise<{ passwordSetupUrl?: string }> {
  const link = await issuePasswordSetupLink(deps.prisma, user.id);

  const approved = reason === 'approved';
  // An invited technician is not staff: their own language, French when they have not chosen.
  const locale = recipientLocale({ locale: user.locale });

  await deps.notifications.sendEmail(
    user.email,
    approved
      ? say(MESSAGES.application.approved.inviteSubject, locale)
      : say(MESSAGES.auth.passwordSetup.subject, locale),
    approved
      ? say(MESSAGES.application.approved.inviteBody, locale, { link })
      : say(MESSAGES.auth.passwordSetup.bodyWithLifetime, locale, { link }),
    {
      userId: user.id,
      locale,
      template: {
        key: approved ? 'artisan.application_approved' : 'auth.password_setup',
        vars: { name: user.name, link },
      },
      validForMs: PASSWORD_SETUP_TTL_MS,
      replaces: `auth:PASSWORD_RESET:${user.id}`,
    },
  );

  if (user.phone) {
    await deps.notifications.sendSms(
      user.phone,
      approved
        ? say(MESSAGES.application.approved.inviteSms, locale, { link })
        : say(MESSAGES.auth.passwordSetup.sms, locale, { link }),
      {
        userId: user.id,
        validForMs: PASSWORD_SETUP_TTL_MS,
        replaces: `auth:PASSWORD_RESET_SMS:${user.id}`,
      },
    );
  }

  return deps.notifications.isEmailSimulated() ? { passwordSetupUrl: link } : {};
}
