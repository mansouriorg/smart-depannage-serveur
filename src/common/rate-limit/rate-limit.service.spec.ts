import { canonicalEmail, RateLimitService } from './rate-limit.service';

describe('allowSendTo (what public forms may send to one destination)', () => {
  it('three messages an hour to one phone number, then no more', () => {
    const limits = new RateLimitService();

    expect(limits.allowSendTo('sms', '22123456')).toBe(true);
    expect(limits.allowSendTo('sms', '22123456')).toBe(true);
    expect(limits.allowSendTo('sms', '22123456')).toBe(true);
    expect(limits.allowSendTo('sms', '22123456')).toBe(false);
  });

  it('the same number written another way is the same destination', () => {
    const limits = new RateLimitService();

    for (const written of ['22123456', '22 123 456', '+216 22 123 456', '00216 22123456', '022123456']) {
      limits.allowSendTo('sms', written);
    }

    expect(limits.allowSendTo('sms', '(22) 123-456')).toBe(false);
  });

  it('an address is the same in any case, and phones and e-mails are counted apart', () => {
    const limits = new RateLimitService();

    for (let i = 0; i < 3; i++) limits.allowSendTo('email', i % 2 ? ' Sami@Example.tn ' : 'sami@example.tn');

    expect(limits.allowSendTo('email', 'SAMI@example.tn')).toBe(false);
    expect(limits.allowSendTo('email', 'someone-else@example.tn')).toBe(true);
    expect(limits.allowSendTo('sms', '22123456')).toBe(true);
  });

  it('aliases of one mailbox share a counter', () => {
    const limits = new RateLimitService();

    for (const alias of ['victim@gmail.com', 'v.i.c.t.i.m@gmail.com', 'victim+a@googlemail.com']) {
      limits.allowSendTo('email', alias);
    }

    expect(limits.allowSendTo('email', 'victim+zzz@gmail.com')).toBe(false);
    expect(canonicalEmail('Victim+Tag@Gmail.com')).toBe('victim@gmail.com');
    expect(canonicalEmail('a.b+x@company.tn')).toBe('a.b@company.tn'); // dots only count at Gmail
    expect(canonicalEmail('nonsense')).toBe(null);
    expect(canonicalEmail('+x@a.tn')).toBe(null);
  });

  it('something that is not a number or an address is never sent to', () => {
    const limits = new RateLimitService();

    expect(limits.allowSendTo('sms', '')).toBe(false);
    expect(limits.allowSendTo('sms', 'call me')).toBe(false);
    expect(limits.allowSendTo('email', 'nonsense')).toBe(false);
  });

  it('another country code in the settings is understood', () => {
    const before = process.env.DEFAULT_PHONE_COUNTRY_CODE;
    process.env.DEFAULT_PHONE_COUNTRY_CODE = '33';

    try {
      const limits = new RateLimitService();

      for (const written of ['+33612345678', '0612345678', '06 12 34 56 78']) limits.allowSendTo('sms', written);

      expect(limits.allowSendTo('sms', '0033612345678')).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DEFAULT_PHONE_COUNTRY_CODE;
      else process.env.DEFAULT_PHONE_COUNTRY_CODE = before;
    }
  });

  it('another number is not affected', () => {
    const limits = new RateLimitService();

    for (let i = 0; i < 5; i++) limits.allowSendTo('sms', '22123456');

    expect(limits.allowSendTo('sms', '99123456')).toBe(true);
  });
});
