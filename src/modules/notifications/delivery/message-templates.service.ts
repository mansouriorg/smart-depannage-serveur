import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

import { describeError } from './delivery-error';
import { renderTemplate } from './render-template';

type Vars = Record<string, string | number | boolean | null | undefined>;

export type RenderedMessage = {
  subject?: string;
  content: string;
  /** True when a template from the database was used. */
  fromTemplate: boolean;
};

const CACHE_MS = 60_000;

/**
 * Messages whose whole point is a code or a link: a template that edits the
 * placeholder away would send an empty promise ("Cliquez ici") that nobody can
 * use. At least one of these placeholders must appear, or the built-in text is
 * used instead.
 */
const MUST_CONTAIN_ONE_OF: Record<string, string[]> = {
  'auth.phone_code': ['code'],
  'auth.email_verification': ['link'],
  'auth.password_reset': ['link'],
  'auth.password_setup': ['link'],
  // The invitation of an applicant whose application was accepted (P1-11): the link is its point.
  'artisan.application_approved': ['link'],
  'guest.activation_email': ['link'],
  // The SMS carries the code only. The link goes to the mailbox: a link that proves
  // "you own this e-mail" must not also travel by SMS (P1-03, step 4).
  'guest.activation_sms': ['code'],
  'auth.email_change': ['link'],
  // The whole point of these two is the customer's link to follow the request (P1-04).
  'guest.tracking_sms': ['link'],
  'guest.tracking_email': ['link'],
};

function mentions(text: string, placeholder: string): boolean {
  return new RegExp(`\\{\\{\\s*${placeholder}\\s*\\}\\}`).test(text);
}

/**
 * The wording of messages lives in the NotificationTemplate table, so the team
 * can change it from the admin dashboard without a deployment. Keys:
 *   <NotificationType>.<CHANNEL>   e.g. QUOTE_SENT.EMAIL, PAYMENT_RECEIVED.SMS
 *   auth.email_verification  auth.phone_code  auth.password_reset
 *   auth.password_setup  guest.activation_email  guest.activation_sms
 *   artisan.application_approved (the link that follows an accepted application)
 *   auth.email_change (link to the NEW address)  auth.email_changed_notice (to the OLD one)
 *   auth.phone_changed_notice  auth.phone_released_notice
 *   guest.tracking_sms  guest.tracking_email  (the link to follow a request made with no account)
 * A key with no active template of the right type uses the built-in text, so
 * an empty table changes nothing.
 */
@Injectable()
export class MessageTemplatesService {
  private readonly logger = new Logger(MessageTemplatesService.name);
  private readonly cache = new Map<string, { at: number; template: any | null }>();
  private readonly warnedKeys = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  private async find(key: string): Promise<any | null> {
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.template;
    }

    let template: any | null = null;

    try {
      template = await this.prisma.notificationTemplate.findUnique({ where: { key } });
    } catch (error: any) {
      // A template problem must never stop a message from going out.
      this.logger.warn(`Template "${key}" could not be read (${describeError(error)})`);
    }

    this.cache.set(key, { at: Date.now(), template });

    return template;
  }

  /** Forget cached templates (after an admin edits one). */
  clearCache() {
    this.cache.clear();
    this.warnedKeys.clear();
  }

  async render(
    key: string,
    type: 'SMS' | 'EMAIL' | 'PUSH',
    vars: Vars,
    fallback: { subject?: string; content: string },
  ): Promise<RenderedMessage> {
    const template = await this.find(key);

    if (!template || !template.isActive || template.type !== type || !String(template.content ?? '').trim()) {
      return { subject: fallback.subject, content: fallback.content, fromTemplate: false };
    }

    const needed = MUST_CONTAIN_ONE_OF[key];

    if (needed && !needed.some((placeholder) => mentions(String(template.content), placeholder))) {
      if (!this.warnedKeys.has(key)) {
        this.warnedKeys.add(key);
        this.logger.warn(
          `Template "${key}" does not contain ${needed.map((name) => `{{${name}}}`).join(' or ')}: ` +
            'the built-in text is used until it does.',
        );
      }

      return { subject: fallback.subject, content: fallback.content, fromTemplate: false };
    }

    return {
      subject: template.subject ? renderTemplate(template.subject, vars) : fallback.subject,
      content: renderTemplate(template.content, vars),
      fromTemplate: true,
    };
  }
}
