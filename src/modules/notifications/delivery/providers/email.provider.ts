import { DeliveryConfig } from '../../../../config/delivery';
import { DeliveryError } from '../delivery-error';

export type OutgoingEmail = { to: string; subject: string; text: string };

export interface EmailProvider {
  readonly name: string;
  isConfigured(): boolean;
  send(message: OutgoingEmail): Promise<{ providerMessageId?: string }>;
}

/** The part of a nodemailer transporter that is used. */
export type MailTransport = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
};

/** Loaded on first use, so the rest of the server (and the tests) never need nodemailer. */
function createNodemailerTransport(options: Record<string, unknown>): MailTransport {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodemailer = require('nodemailer');

  return nodemailer.createTransport(options);
}

export class NoEmailProvider implements EmailProvider {
  readonly name = 'NONE';

  isConfigured() {
    return false;
  }

  async send(): Promise<{ providerMessageId?: string }> {
    throw new DeliveryError('E-mail provider not configured (SMTP_HOST)', false);
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'SMTP';
  private transport?: MailTransport;

  constructor(
    private readonly config: NonNullable<DeliveryConfig['email']>,
    private readonly makeTransport: (options: Record<string, unknown>) => MailTransport = createNodemailerTransport,
  ) {}

  isConfigured() {
    return Boolean(this.config.host && this.config.from);
  }

  private getTransport(): MailTransport {
    if (!this.transport) {
      this.transport = this.makeTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: this.config.user ? { user: this.config.user, pass: this.config.pass } : undefined,
        // With a login and no TLS from the start (port 587), STARTTLS is mandatory:
        // the password is never sent in the clear because the server forgot to offer it.
        requireTLS: Boolean(this.config.user) && !this.config.secure,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });
    }

    return this.transport;
  }

  async send(message: OutgoingEmail) {
    try {
      const info = await this.getTransport().sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });

      return { providerMessageId: info?.messageId };
    } catch (error: any) {
      // A 5xx answer from the mail server is a final "no" (unknown mailbox,
      // rejected message), and so is an address nodemailer refuses to build an
      // envelope for (EENVELOPE) unless the server answered with a 4xx, which is
      // "try later". Everything else (connection, timeout, 4xx, login) can pass
      // later. The error text can repeat the address: keep the code only.
      const code = Number(error?.responseCode);
      const temporary = code >= 400 && code < 500; // 450/451 greylisting: the same mail goes through later
      const permanent =
        (code >= 500 && code < 600 && error?.code !== 'EAUTH') ||
        (error?.code === 'EENVELOPE' && !temporary);

      throw new DeliveryError(
        `SMTP error (${error?.code ?? 'failed'}${code ? `, ${code}` : ''})`,
        !permanent,
      );
    }
  }
}

export function createEmailProvider(
  config: DeliveryConfig,
  makeTransport?: (options: Record<string, unknown>) => MailTransport,
): EmailProvider {
  return config.email ? new SmtpEmailProvider(config.email, makeTransport) : new NoEmailProvider();
}
