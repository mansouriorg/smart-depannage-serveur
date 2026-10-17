import { readDeliveryConfig } from '../../../../config/delivery';
import { DeliveryError } from '../delivery-error';
import { SmtpEmailProvider } from './email.provider';
import { FetchLike } from './http';
import { ExpoPushProvider } from './push.provider';
import { HttpSmsProvider, NoSmsProvider, TwilioSmsProvider, createSmsProvider } from './sms.provider';

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

/** A fetch that answers with the given (status, body) in turn and remembers the calls. */
function fakeFetch(...answers: Array<[number, string] | Error>) {
  const calls: Call[] = [];
  let i = 0;

  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, ...init });
    const answer = answers[Math.min(i++, answers.length - 1)];

    if (answer instanceof Error) throw answer;

    return { ok: answer[0] < 300, status: answer[0], text: async () => answer[1] };
  };

  return { fetchFn, calls };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to fail');
}

const twilio = { accountSid: 'AC123', authToken: 'secret-token', from: '+15005550006', messagingServiceSid: '' };

describe('Twilio', () => {
  it('sends a form-encoded message with basic auth and returns the message sid', async () => {
    const { fetchFn, calls } = fakeFetch([201, JSON.stringify({ sid: 'SM42', status: 'queued' })]);
    const provider = new TwilioSmsProvider(twilio, fetchFn);

    const result = await provider.send('+21622123456', 'Code 123456');

    expect(result.providerMessageId).toBe('SM42');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers!.Authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);

    const form = new URLSearchParams(calls[0].body);
    expect(form.get('To')).toBe('+21622123456');
    expect(form.get('Body')).toBe('Code 123456');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('MessagingServiceSid')).toBe(null);
  });

  it('a messaging service replaces the sender number', async () => {
    const { fetchFn, calls } = fakeFetch([201, '{}']);
    await new TwilioSmsProvider({ ...twilio, from: '', messagingServiceSid: 'MG9' }, fetchFn).send('+21622123456', 'x');

    const form = new URLSearchParams(calls[0].body);
    expect(form.get('MessagingServiceSid')).toBe('MG9');
    expect(form.get('From')).toBe(null);
  });

  it('a refused number is final, an overloaded service can be retried, and the error never holds the number', async () => {
    const refused = await failure(
      new TwilioSmsProvider(twilio, fakeFetch([400, JSON.stringify({ code: 21211, message: 'Invalid To +21622123456' })]).fetchFn).send('+21622123456', 'x'),
    );
    expect(refused instanceof DeliveryError).toBe(true);
    expect(refused.retryable).toBe(false);
    expect(refused.message).toContain('21211');
    expect(refused.message).not.toContain('21622123456');

    for (const status of [429, 500, 503]) {
      const error = await failure(new TwilioSmsProvider(twilio, fakeFetch([status, '{}']).fetchFn).send('+21622123456', 'x'));
      expect(error.retryable).toBe(true);
    }
  });

  it('a network failure can be retried and does not leak the URL or credentials', async () => {
    const error = await failure(
      new TwilioSmsProvider(twilio, fakeFetch(Object.assign(new Error('connect ECONNRESET api.twilio.com'), { code: 'ECONNRESET' })).fetchFn).send('+21622123456', 'x'),
    );

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNRESET');
    expect(error.message).not.toContain('twilio.com');
  });

  it('is configured only with credentials and a sender', () => {
    expect(new TwilioSmsProvider(twilio).isConfigured()).toBe(true);
    expect(new TwilioSmsProvider({ ...twilio, from: '' }).isConfigured()).toBe(false);
    expect(new TwilioSmsProvider({ ...twilio, authToken: '' }).isConfigured()).toBe(false);
  });
});

describe('generic SMS gateway', () => {
  it('posts JSON with the authorization header', async () => {
    const { fetchFn, calls } = fakeFetch([200, JSON.stringify({ id: 'abc' })]);
    const provider = new HttpSmsProvider({ url: 'https://gw.example.tn/sms', authHeader: 'Bearer k', from: 'SmartDep' }, fetchFn);

    const result = await provider.send('+21622123456', 'Bonjour');

    expect(result.providerMessageId).toBe('abc');
    expect(calls[0].headers!.Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].body!)).toEqual({ to: '+21622123456', message: 'Bonjour', from: 'SmartDep' });
  });

  it('classifies failures like the others', async () => {
    const config = { url: 'https://gw.example.tn/sms', authHeader: '', from: '' };

    expect((await failure(new HttpSmsProvider(config, fakeFetch([401, '']).fetchFn).send('+21622123456', 'x'))).retryable).toBe(false);
    expect((await failure(new HttpSmsProvider(config, fakeFetch([502, '']).fetchFn).send('+21622123456', 'x'))).retryable).toBe(true);
  });
});

describe('no SMS provider', () => {
  it('refuses with a final error instead of pretending', async () => {
    const provider = createSmsProvider(readDeliveryConfig({}));

    expect(provider instanceof NoSmsProvider).toBe(true);
    expect(provider.isConfigured()).toBe(false);

    const error = await failure(provider.send('+21622123456', 'x'));
    expect(error.retryable).toBe(false);
  });
});

describe('SMTP', () => {
  const config = { host: 'smtp.example.tn', port: 587, secure: false, user: 'u', pass: 'p', from: 'Smart <no-reply@example.tn>' };

  it('hands the message to the transport once, and builds the transport once', async () => {
    const sent: any[] = [];
    let built = 0;

    const provider = new SmtpEmailProvider(config, (options) => {
      built++;
      expect((options as any).host).toBe('smtp.example.tn');
      expect((options as any).auth).toEqual({ user: 'u', pass: 'p' });
      // a login over a connection that starts in clear text must upgrade to TLS or fail
      expect((options as any).requireTLS).toBe(true);
      return { sendMail: async (message) => (sent.push(message), { messageId: '<id1@example.tn>' }) };
    });

    const result = await provider.send({ to: 'a@b.tn', subject: 'Sujet', text: 'Corps' });
    await provider.send({ to: 'c@d.tn', subject: 'S2', text: 'C2' });

    expect(result.providerMessageId).toBe('<id1@example.tn>');
    expect(sent[0]).toEqual({ from: 'Smart <no-reply@example.tn>', to: 'a@b.tn', subject: 'Sujet', text: 'Corps' });
    expect(built).toBe(1);
  });

  it('no login when there is no user', () => {
    let options: any;
    const provider = new SmtpEmailProvider({ ...config, user: '', pass: '' }, (o) => {
      options = o;
      return { sendMail: async () => ({}) };
    });

    return provider.send({ to: 'a@b.tn', subject: 's', text: 't' }).then(() => {
      expect(options.auth).toBe(undefined);
      expect(options.requireTLS).toBe(false);
    });
  });

  it('no forced STARTTLS when the connection is TLS from the start', async () => {
    let options: any;
    const provider = new SmtpEmailProvider({ ...config, port: 465, secure: true }, (o) => {
      options = o;
      return { sendMail: async () => ({}) };
    });

    await provider.send({ to: 'a@b.tn', subject: 's', text: 't' });

    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
  });

  it('a 5xx answer is final, a timeout or a 4xx can be retried, a login failure can be retried', async () => {
    const failing = (error: any) =>
      new SmtpEmailProvider(config, () => ({
        sendMail: async () => {
          throw error;
        },
      }));
    const send = (error: any) => failure(failing(error).send({ to: 'a@b.tn', subject: 's', text: 't' }));

    expect((await send(Object.assign(new Error('550 5.1.1 a@b.tn unknown'), { responseCode: 550, code: 'EENVELOPE' }))).retryable).toBe(false);
    expect((await send(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).retryable).toBe(true);
    expect((await send(Object.assign(new Error('451 try later'), { responseCode: 451 }))).retryable).toBe(true);
    expect((await send(Object.assign(new Error('535 bad login'), { responseCode: 535, code: 'EAUTH' }))).retryable).toBe(true);

    // greylisting arrives as EENVELOPE with a 4xx answer: that one must be retried
    expect((await send(Object.assign(new Error('451 4.7.1 try later'), { responseCode: 451, code: 'EENVELOPE' }))).retryable).toBe(true);

    // an address nodemailer cannot build an envelope for is final even without an SMTP code
    expect((await send(Object.assign(new Error('No recipients defined'), { code: 'EENVELOPE' }))).retryable).toBe(false);

    // the address from the server's message never reaches the stored error
    const refused = await send(Object.assign(new Error('550 5.1.1 a@b.tn unknown'), { responseCode: 550, code: 'EENVELOPE' }));
    expect(refused.message).not.toContain('a@b.tn');
  });
});

describe('Expo push', () => {
  const config = { provider: 'expo' as const, accessToken: '' };
  const token = (n: number) => `ExponentPushToken[abc${n}]`;
  const ok = (id: string) => ({ status: 'ok', id });

  it('sends one request for the devices and reports each ticket', async () => {
    const { fetchFn, calls } = fakeFetch([
      200,
      JSON.stringify({ data: [ok('t1'), { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }] }),
    ]);

    const results = await new ExpoPushProvider(config, fetchFn).send([token(1), token(2)], {
      title: 'Titre',
      body: 'Corps',
      data: { interventionId: 5 },
    });

    expect(results).toEqual([
      { token: token(1), ok: true, ticketId: 't1' },
      { token: token(2), ok: false, gone: true, retryable: false, error: 'DeviceNotRegistered' },
    ]);

    const sent = JSON.parse(calls[0].body!);
    expect(sent.length).toBe(2);
    expect(sent[0]).toEqual({ to: token(1), title: 'Titre', body: 'Corps', data: { interventionId: 5 }, sound: 'default', priority: 'high' });
    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0].headers!.Authorization).toBe(undefined);
  });

  it('uses the access token when there is one', async () => {
    const { fetchFn, calls } = fakeFetch([200, JSON.stringify({ data: [ok('t')] })]);
    await new ExpoPushProvider({ provider: 'expo', accessToken: 'tok' }, fetchFn).send([token(1)], { title: 't', body: 'b' });

    expect(calls[0].headers!.Authorization).toBe('Bearer tok');
  });

  it('a value that is not an Expo token is reported but never switched off, and not sent', async () => {
    const { fetchFn, calls } = fakeFetch([200, JSON.stringify({ data: [ok('t')] })]);
    const results = await new ExpoPushProvider(config, fetchFn).send(['fcm-token-123', token(1)], { title: 't', body: 'b' });

    const other = results.find((r) => r.token === 'fcm-token-123')!;
    expect(other.ok).toBe(false);
    expect(other.gone).toBeUndefined();
    expect(other.retryable).toBe(false);
    expect(other.error).toBe('not an Expo push token');
    expect(JSON.parse(calls[0].body!).length).toBe(1);
  });

  it('more than 100 devices go in several requests', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => token(i));
    const first = JSON.stringify({ data: Array.from({ length: 100 }, (_, i) => ok(`a${i}`)) });
    const second = JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ok(`b${i}`)) });
    const { fetchFn, calls } = fakeFetch([200, first], [200, second]);

    const results = await new ExpoPushProvider(config, fetchFn).send(tokens, { title: 't', body: 'b' });

    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[0].body!).length).toBe(100);
    expect(JSON.parse(calls[1].body!).length).toBe(50);
    expect(results.filter((r) => r.ok).length).toBe(150);
  });

  it('a rate limit on one ticket can be retried; a missing ticket too', async () => {
    const { fetchFn } = fakeFetch([200, JSON.stringify({ data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }] })]);
    const [limited] = await new ExpoPushProvider(config, fetchFn).send([token(1)], { title: 't', body: 'b' });
    expect(limited.retryable).toBe(true);

    const [missing] = await new ExpoPushProvider(config, fakeFetch([200, JSON.stringify({ data: [] })]).fetchFn).send([token(1)], { title: 't', body: 'b' });
    expect(missing.retryable).toBe(true);
  });

  it('a failing push service: 5xx and 429 retry, 4xx is final', async () => {
    const send = (status: number) => failure(new ExpoPushProvider(config, fakeFetch([status, '']).fetchFn).send([token(1)], { title: 't', body: 'b' }));

    expect((await send(500)).retryable).toBe(true);
    expect((await send(429)).retryable).toBe(true);
    expect((await send(400)).retryable).toBe(false);
  });
});
