import { generateLinkToken, generateSixDigitCode, hashLinkToken, hashOneTimeCode } from './one-time-code';

describe('one-time codes', () => {
  it('codes have six digits and do not start with 0', () => {
    for (let index = 0; index < 200; index++) {
      expect(/^[1-9]\d{5}$/.test(generateSixDigitCode())).toBe(true);
    }
  });

  it('the same digits give a different hash for every user, so two people can wait for the same code', () => {
    expect(hashOneTimeCode(1, 'phone-change', '123456') === hashOneTimeCode(2, 'phone-change', '123456')).toBe(false);
    expect(hashOneTimeCode(1, 'phone-change', '123456')).toBe(hashOneTimeCode(1, 'phone-change', ' 123456 '));
    expect(hashOneTimeCode(1, 'phone-change', '123456') === hashOneTimeCode(1, 'phone-change', '123457')).toBe(false);
  });

  it('the same digits for the same person but another purpose are another hash', () => {
    const purposes = ['phone-verification', 'phone-change', 'guest-activation'] as const;
    const hashes = purposes.map((purpose) => hashOneTimeCode(1, purpose, '123456'));

    expect(new Set(hashes).size).toBe(3);
  });

  it('a code hash is never the hash of a link token', () => {
    expect(hashOneTimeCode(1, 'phone-change', 'abc') === hashLinkToken('abc')).toBe(false);
  });

  it('link tokens are long and unique', () => {
    const first = generateLinkToken();

    expect(/^[a-f0-9]{64}$/.test(first)).toBe(true);
    expect(first === generateLinkToken()).toBe(false);
    expect(hashLinkToken(first)).toBe(hashLinkToken(first));
  });
});
