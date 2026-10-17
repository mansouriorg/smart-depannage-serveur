/**
 * Delivery configuration (P1-03): how e-mail, SMS and push messages leave the server.
 *
 * Nothing here is required: a channel without a provider simply does not send,
 * and says so once at start-up and in every outbox row it refuses.
 *
 *   SMS_PROVIDER                none (default) | twilio | http
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID
 *   SMS_HTTP_URL                any provider with a JSON API: POST {to, message, from}
 *   SMS_HTTP_AUTH_HEADER        full Authorization header value, e.g. "Bearer abc"
 *   SMS_HTTP_FROM               optional sender name or number
 *
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS
 *   SMTP_FROM                   "Smart Dépannage <no-reply@example.tn>" (needed with SMTP_HOST)
 *
 *   PUSH_PROVIDER               expo (default) | none
 *   EXPO_ACCESS_TOKEN           only if the Expo project enforces push security
 *
 *   DEFAULT_PHONE_COUNTRY_CODE  added to national numbers (default 216, Tunisia)
 *   ADMIN_ALERT_PHONE           phone that gets an SMS for each new request (empty = no alert SMS)
 *   OUTBOX_WORKER               off | false | 0: this process sends nothing and does not retry; messages wait in
 *                               the outbox for a process that has it on (default on)
 *   OUTBOX_POLL_MS              how often due messages are picked up (default 15000)
 *   OUTBOX_MAX_ATTEMPTS         tries before a message is given up (default 5)
 *   DELIVERY_DEBUG_LOG          "true" logs message bodies, never in production
 */

export type SmsProviderName = 'none' | 'twilio' | 'http';
export type PushProviderName = 'none' | 'expo';

export type DeliveryConfig = {
  sms: {
    provider: SmsProviderName;
    twilio: {
      accountSid: string;
      authToken: string;
      from: string;
      messagingServiceSid: string;
    };
    http: { url: string; authHeader: string; from: string };
  };
  /** null when SMTP_HOST is not set */
  email: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  } | null;
  push: { provider: PushProviderName; accessToken: string };
  defaultCountryCode: string;
  outbox: {
    workerEnabled: boolean;
    pollMs: number;
    maxAttempts: number;
    batchSize: number;
  };
  /** Message bodies in the log: only outside production, only when asked. */
  debugLogBodies: boolean;
};

type Env = Record<string, unknown>;

function text(env: Env, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);

  if (!raw) return fallback;

  const value = Number(raw);

  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isProduction(env: Env): boolean {
  return text(env, 'NODE_ENV').toLowerCase() === 'production';
}

export function readDeliveryConfig(env: Env = process.env): DeliveryConfig {
  const smsProvider = text(env, 'SMS_PROVIDER').toLowerCase();
  const pushProvider = text(env, 'PUSH_PROVIDER').toLowerCase();
  const smtpHost = text(env, 'SMTP_HOST');
  const smtpPort = integer(env, 'SMTP_PORT', 587, 1, 65535);
  const secureRaw = text(env, 'SMTP_SECURE').toLowerCase();

  return {
    sms: {
      provider: smsProvider === 'twilio' || smsProvider === 'http' ? smsProvider : 'none',
      twilio: {
        accountSid: text(env, 'TWILIO_ACCOUNT_SID'),
        authToken: text(env, 'TWILIO_AUTH_TOKEN'),
        from: text(env, 'TWILIO_FROM'),
        messagingServiceSid: text(env, 'TWILIO_MESSAGING_SERVICE_SID'),
      },
      http: {
        url: text(env, 'SMS_HTTP_URL'),
        authHeader: text(env, 'SMS_HTTP_AUTH_HEADER'),
        from: text(env, 'SMS_HTTP_FROM'),
      },
    },
    email: smtpHost
      ? {
          host: smtpHost,
          port: smtpPort,
          secure: secureRaw ? secureRaw === 'true' : smtpPort === 465,
          user: text(env, 'SMTP_USER'),
          pass: text(env, 'SMTP_PASS'),
          from: text(env, 'SMTP_FROM'),
        }
      : null,
    push: {
      provider: pushProvider === 'none' ? 'none' : 'expo',
      accessToken: text(env, 'EXPO_ACCESS_TOKEN'),
    },
    defaultCountryCode: text(env, 'DEFAULT_PHONE_COUNTRY_CODE').replace(/\D/g, '') || '216',
    outbox: {
      workerEnabled:
        !['off', 'false', '0', 'no'].includes(text(env, 'OUTBOX_WORKER').toLowerCase()) &&
        text(env, 'NODE_ENV').toLowerCase() !== 'test',
      pollMs: integer(env, 'OUTBOX_POLL_MS', 15000, 1000, 3_600_000),
      maxAttempts: integer(env, 'OUTBOX_MAX_ATTEMPTS', 5, 1, 20),
      batchSize: 20,
    },
    debugLogBodies:
      !isProduction(env) && text(env, 'DELIVERY_DEBUG_LOG').toLowerCase() === 'true',
  };
}

/**
 * The phone number that gets an SMS when a new request comes in. Empty means
 * nobody is texted: the back office is told in the app instead. (This used to
 * be a made-up number written in the code, so every request sent a paid SMS to
 * a stranger.)
 */
export function adminAlertPhone(env: Env = process.env): string {
  return text(env, 'ADMIN_ALERT_PHONE');
}

/** Mistakes in the delivery variables, for validateEnv(). Unset variables are fine. */
export function deliveryConfigProblems(env: Env): string[] {
  const problems: string[] = [];

  const smsProvider = text(env, 'SMS_PROVIDER').toLowerCase();

  if (smsProvider && !['none', 'twilio', 'http'].includes(smsProvider)) {
    problems.push('SMS_PROVIDER must be "none", "twilio" or "http" (or empty).');
  }

  if (smsProvider === 'twilio') {
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) {
      if (!text(env, name)) problems.push(`${name} is required when SMS_PROVIDER=twilio.`);
    }

    if (!text(env, 'TWILIO_FROM') && !text(env, 'TWILIO_MESSAGING_SERVICE_SID')) {
      problems.push(
        'TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID is required when SMS_PROVIDER=twilio.',
      );
    }
  }

  if (smsProvider === 'http') {
    const url = text(env, 'SMS_HTTP_URL');

    if (!url) {
      problems.push('SMS_HTTP_URL is required when SMS_PROVIDER=http.');
    } else {
      try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !isProduction(env))) {
          problems.push('SMS_HTTP_URL must start with https:// (http:// is only accepted outside production).');
        }
      } catch {
        problems.push('SMS_HTTP_URL is not a valid URL.');
      }
    }
  }

  const pushProvider = text(env, 'PUSH_PROVIDER').toLowerCase();

  if (pushProvider && !['expo', 'none'].includes(pushProvider)) {
    problems.push('PUSH_PROVIDER must be "expo" or "none" (or empty).');
  }

  if (text(env, 'SMTP_HOST')) {
    if (!text(env, 'SMTP_FROM')) {
      problems.push('SMTP_FROM is required when SMTP_HOST is set (example: Smart Dépannage <no-reply@example.tn>).');
    }

    const port = text(env, 'SMTP_PORT');

    if (port && !(Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535)) {
      problems.push('SMTP_PORT must be a port number.');
    }

    if (!!text(env, 'SMTP_USER') !== !!text(env, 'SMTP_PASS')) {
      problems.push('SMTP_USER and SMTP_PASS go together: set both or neither.');
    }
  }

  const alertPhone = adminAlertPhone(env);

  if (alertPhone && !/^\+?\d{8,15}$/.test(alertPhone.replace(/[\s().-]/g, ''))) {
    problems.push('ADMIN_ALERT_PHONE must be a phone number such as +21622123456 (or empty for no alert SMS).');
  }

  const country = text(env, 'DEFAULT_PHONE_COUNTRY_CODE');

  if (country && !/^\+?\d{1,3}$/.test(country)) {
    problems.push('DEFAULT_PHONE_COUNTRY_CODE must be a country calling code such as 216.');
  }

  return problems;
}
