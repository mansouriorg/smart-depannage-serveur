import { adminAlertPhone, deliveryConfigProblems, readDeliveryConfig } from './delivery';
import { validateEnv } from './env';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  FRONTEND_URL: 'https://www.example.tn',
};

describe('readDeliveryConfig', () => {
  it('with nothing set: no SMS, no e-mail, Expo push, Tunisian numbers', () => {
    const config = readDeliveryConfig({});

    expect(config.sms.provider).toBe('none');
    expect(config.email).toBe(null);
    expect(config.push.provider).toBe('expo');
    expect(config.defaultCountryCode).toBe('216');
    expect(config.outbox.workerEnabled).toBe(true);
    expect(config.outbox.maxAttempts).toBe(5);
    expect(config.debugLogBodies).toBe(false);
  });

  it('reads SMTP: port 465 means implicit TLS unless said otherwise', () => {
    const smtp = (extra: Record<string, string>) =>
      readDeliveryConfig({ SMTP_HOST: 'smtp.example.tn', SMTP_FROM: 'a@example.tn', ...extra }).email!;

    expect(smtp({}).port).toBe(587);
    expect(smtp({}).secure).toBe(false);
    expect(smtp({ SMTP_PORT: '465' }).secure).toBe(true);
    expect(smtp({ SMTP_PORT: '465', SMTP_SECURE: 'false' }).secure).toBe(false);
    expect(smtp({ SMTP_USER: 'u', SMTP_PASS: 'p' }).user).toBe('u');
  });

  it('an unknown SMS provider is treated as none', () => {
    expect(readDeliveryConfig({ SMS_PROVIDER: 'carrier-pigeon' }).sms.provider).toBe('none');
    expect(readDeliveryConfig({ SMS_PROVIDER: 'Twilio' }).sms.provider).toBe('twilio');
  });

  it('the worker is off in tests and when asked', () => {
    expect(readDeliveryConfig({ NODE_ENV: 'test' }).outbox.workerEnabled).toBe(false);
    expect(readDeliveryConfig({ OUTBOX_WORKER: 'off' }).outbox.workerEnabled).toBe(false);
    expect(readDeliveryConfig({ OUTBOX_WORKER: 'false' }).outbox.workerEnabled).toBe(false);
    expect(readDeliveryConfig({ OUTBOX_WORKER: '0' }).outbox.workerEnabled).toBe(false);
    expect(readDeliveryConfig({ OUTBOX_WORKER: 'on' }).outbox.workerEnabled).toBe(true);
  });

  it('message bodies in the log: only when asked, never in production', () => {
    expect(readDeliveryConfig({ DELIVERY_DEBUG_LOG: 'true' }).debugLogBodies).toBe(true);
    expect(readDeliveryConfig({ DELIVERY_DEBUG_LOG: 'true', NODE_ENV: 'production' }).debugLogBodies).toBe(false);
    expect(readDeliveryConfig({ NODE_ENV: 'development' }).debugLogBodies).toBe(false);
  });

  it('numbers out of range fall back to the default', () => {
    expect(readDeliveryConfig({ OUTBOX_MAX_ATTEMPTS: '0' }).outbox.maxAttempts).toBe(5);
    expect(readDeliveryConfig({ OUTBOX_MAX_ATTEMPTS: 'many' }).outbox.maxAttempts).toBe(5);
    expect(readDeliveryConfig({ OUTBOX_MAX_ATTEMPTS: '8' }).outbox.maxAttempts).toBe(8);
  });
});

describe('deliveryConfigProblems', () => {
  it('nothing set is fine: delivery is optional', () => {
    expect(deliveryConfigProblems({})).toEqual([]);
  });

  it('Twilio needs its credentials and a sender', () => {
    const problems = deliveryConfigProblems({ SMS_PROVIDER: 'twilio' });

    expect(problems.length).toBe(3);

    expect(
      deliveryConfigProblems({
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 't',
        TWILIO_MESSAGING_SERVICE_SID: 'MG1',
      }),
    ).toEqual([]);
  });

  it('the generic gateway needs a URL, https in production', () => {
    expect(deliveryConfigProblems({ SMS_PROVIDER: 'http' }).length).toBe(1);
    expect(deliveryConfigProblems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'not a url' }).length).toBe(1);
    expect(deliveryConfigProblems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'http://localhost:9000/sms' })).toEqual([]);
    expect(
      deliveryConfigProblems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'http://gw.example.tn/sms', NODE_ENV: 'production' }).length,
    ).toBe(1);
    expect(deliveryConfigProblems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://gw.example.tn/sms', NODE_ENV: 'production' })).toEqual([]);
  });

  it('SMTP needs a sender, a sane port and both or neither of user and password', () => {
    expect(deliveryConfigProblems({ SMTP_HOST: 'smtp.example.tn' }).length).toBe(1);
    expect(deliveryConfigProblems({ SMTP_HOST: 'smtp.example.tn', SMTP_FROM: 'a@b.tn', SMTP_PORT: 'abc' }).length).toBe(1);
    expect(deliveryConfigProblems({ SMTP_HOST: 'smtp.example.tn', SMTP_FROM: 'a@b.tn', SMTP_USER: 'u' }).length).toBe(1);
    expect(deliveryConfigProblems({ SMTP_HOST: 'smtp.example.tn', SMTP_FROM: 'a@b.tn', SMTP_USER: 'u', SMTP_PASS: 'p' })).toEqual([]);
  });

  it('unknown providers and a bad country code are reported', () => {
    expect(deliveryConfigProblems({ SMS_PROVIDER: 'x', PUSH_PROVIDER: 'y', DEFAULT_PHONE_COUNTRY_CODE: 'tn' }).length).toBe(3);
  });
});

describe('validateEnv includes the delivery checks', () => {
  it('a bad delivery variable stops the server from starting, with the others listed', () => {
    expect(() => validateEnv({ ...BASE_ENV, SMS_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => validateEnv({ ...BASE_ENV })).not.toThrow();
  });
});

describe('ADMIN_ALERT_PHONE', () => {
  it('nobody is texted unless a number is configured', () => {
    expect(adminAlertPhone({})).toBe('');
    expect(adminAlertPhone({ ADMIN_ALERT_PHONE: '  +21622123456 ' })).toBe('+21622123456');
  });

  it('a mistyped number stops the server at start-up, an empty one does not', () => {
    expect(deliveryConfigProblems({})).toEqual([]);
    expect(deliveryConfigProblems({ ADMIN_ALERT_PHONE: '+216 22 123 456' })).toEqual([]);
    expect(deliveryConfigProblems({ ADMIN_ALERT_PHONE: '22123456' })).toEqual([]);
    expect(deliveryConfigProblems({ ADMIN_ALERT_PHONE: 'call me' }).length).toBe(1);
    expect(deliveryConfigProblems({ ADMIN_ALERT_PHONE: '12' }).length).toBe(1);
  });
});
