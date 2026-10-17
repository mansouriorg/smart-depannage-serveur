import { isDeliverableEmail, isMadeUpGuestEmail, maskEmail, maskPhone, toE164 } from './contact';

describe('toE164', () => {
  it('a Tunisian number written in the usual ways', () => {
    expect(toE164('22 123 456')).toBe('+21622123456');
    expect(toE164('22123456')).toBe('+21622123456');
    expect(toE164('+216 22 123 456')).toBe('+21622123456');
    expect(toE164('00216 22 123 456')).toBe('+21622123456');
    expect(toE164('216 22 123 456')).toBe('+21622123456');
    expect(toE164('(22) 123-456')).toBe('+21622123456');
  });

  it('a leading zero is dropped, another country is kept', () => {
    expect(toE164('022123456')).toBe('+21622123456');
    expect(toE164('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(toE164('0612345678', '33')).toBe('+33612345678');
  });

  it('a national zero written after the country code is not part of the number', () => {
    expect(toE164('+216 0 22123456')).toBe('+21622123456');
    expect(toE164('+2160022123456')).toBe('+21622123456');
    expect(toE164('00216 022123456')).toBe('+21622123456');
    expect(toE164('216022123456')).toBe('+21622123456');
    // other countries are left alone
    expect(toE164('+33 0612345678')).toBe('+330612345678');
  });

  it('a national number that starts like the country code is still national', () => {
    // 8 digits starting with 216: no room for a country code in front
    expect(toE164('21612345')).toBe('+21621612345');
  });

  it('refuses what cannot be a number', () => {
    expect(toE164('')).toBe(null);
    expect(toE164('abc')).toBe(null);
    expect(toE164('123')).toBe(null);
    expect(toE164('+0123456789')).toBe(null);
    expect(toE164('+21622')).toBe(null);
    expect(toE164('22 123 456 789 012 345 678')).toBe(null);
  });
});

describe('masking', () => {
  it('shows enough to recognise a number or an address, not to use it', () => {
    expect(maskPhone('+21622123456')).toBe('+216*****456');
    expect(maskPhone('12')).toBe('***');
    expect(maskEmail('amine@example.tn')).toBe('a***@e***.tn');
    expect(maskEmail('nonsense')).toBe('***');
    expect(maskEmail(null)).toBe('***');
  });
});

describe('isDeliverableEmail', () => {
  it('a normal address can receive mail', () => {
    expect(isDeliverableEmail('amine@gmail.com')).toBe(true);
    expect(isDeliverableEmail(' Amine.B@smart-depannage.tn ')).toBe(true);
  });

  it('the made-up address of a guest cannot, in either of its two shapes', () => {
    expect(isDeliverableEmail('guest_0b6e1f6a-1d1e-4c5b-9a53-2f9a7f3f0c11@guest.smart-depannage.local')).toBe(false);
    expect(isDeliverableEmail('guest_1712345678901@smart-depannage.com')).toBe(false);
    expect(isMadeUpGuestEmail('Guest_1712345678901@Smart-Depannage.com')).toBe(true);
    expect(isMadeUpGuestEmail('guest_amine@smart-depannage.com')).toBe(false);
    expect(isDeliverableEmail('guest_amine@smart-depannage.com')).toBe(true);
  });

  it('reserved and broken addresses cannot', () => {
    expect(isDeliverableEmail('a@b.invalid')).toBe(false);
    expect(isDeliverableEmail('a@localhost')).toBe(false);
    expect(isDeliverableEmail('a@b.test')).toBe(false);
    expect(isDeliverableEmail('a@b.example')).toBe(false);
    expect(isDeliverableEmail('nonsense')).toBe(false);
    expect(isDeliverableEmail('@b.tn')).toBe(false);
    expect(isDeliverableEmail('a@')).toBe(false);
    expect(isDeliverableEmail('a b@c.tn')).toBe(false);
    expect(isDeliverableEmail('')).toBe(false);
    expect(isDeliverableEmail(null)).toBe(false);
  });
});
