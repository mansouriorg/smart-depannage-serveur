import { DeliveryConfig } from '../../../../config/delivery';
import { DeliveryError, isRetryableStatus } from '../delivery-error';
import { callHttp, defaultFetch, FetchLike, parseJson } from './http';

export interface SmsProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** `to` is an E.164 number ("+21622123456"). */
  send(to: string, text: string): Promise<{ providerMessageId?: string }>;
}

/** No SMS provider chosen: every SMS is refused, loudly, instead of being logged. */
export class NoSmsProvider implements SmsProvider {
  readonly name = 'NONE';

  isConfigured() {
    return false;
  }

  async send(): Promise<{ providerMessageId?: string }> {
    throw new DeliveryError('SMS provider not configured (SMS_PROVIDER)', false);
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'TWILIO';

  constructor(
    private readonly config: DeliveryConfig['sms']['twilio'],
    private readonly fetchFn: FetchLike = defaultFetch(),
  ) {}

  isConfigured() {
    return Boolean(
      this.config.accountSid &&
        this.config.authToken &&
        (this.config.from || this.config.messagingServiceSid),
    );
  }

  async send(to: string, text: string) {
    const form = new URLSearchParams({ To: to, Body: text });

    if (this.config.messagingServiceSid) {
      form.set('MessagingServiceSid', this.config.messagingServiceSid);
    } else {
      form.set('From', this.config.from);
    }

    const credentials = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString('base64');

    const { status, body } = await callHttp(
      this.fetchFn,
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );

    const json = parseJson(body);

    if (status >= 200 && status < 300) {
      return { providerMessageId: typeof json?.sid === 'string' ? json.sid : undefined };
    }

    // Twilio error codes only: the message text can repeat the phone number.
    throw new DeliveryError(
      `Twilio refused the message (HTTP ${status}${json?.code ? `, code ${json.code}` : ''})`,
      isRetryableStatus(status),
    );
  }
}

/**
 * Any SMS provider with a JSON API: POST { to, message, from? } with an
 * Authorization header, any 2xx answer means accepted.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'HTTP';

  constructor(
    private readonly config: DeliveryConfig['sms']['http'],
    private readonly fetchFn: FetchLike = defaultFetch(),
  ) {}

  isConfigured() {
    return Boolean(this.config.url);
  }

  async send(to: string, text: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.config.authHeader) {
      headers.Authorization = this.config.authHeader;
    }

    const { status, body } = await callHttp(this.fetchFn, this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to,
        message: text,
        ...(this.config.from ? { from: this.config.from } : {}),
      }),
    });

    if (status >= 200 && status < 300) {
      const json = parseJson(body);
      const id = json?.id ?? json?.messageId ?? json?.message_id;

      return { providerMessageId: id !== undefined && id !== null ? String(id) : undefined };
    }

    throw new DeliveryError(`SMS gateway refused the message (HTTP ${status})`, isRetryableStatus(status));
  }
}

export function createSmsProvider(
  config: DeliveryConfig,
  fetchFn: FetchLike = defaultFetch(),
): SmsProvider {
  if (config.sms.provider === 'twilio') {
    return new TwilioSmsProvider(config.sms.twilio, fetchFn);
  }

  if (config.sms.provider === 'http') {
    return new HttpSmsProvider(config.sms.http, fetchFn);
  }

  return new NoSmsProvider();
}
