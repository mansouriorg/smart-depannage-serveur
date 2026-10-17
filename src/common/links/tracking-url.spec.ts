import { buildTrackingUrl, TRACKING_PATH } from './tracking-url';

describe('buildTrackingUrl (the one place a tracking link is made)', () => {
  it('points at the website page, with the request number and the token', () => {
    expect(buildTrackingUrl(42, 'abc123', 'https://www.example.tn')).toBe(
      'https://www.example.tn/demande/status?id=42&token=abc123',
    );
    expect(TRACKING_PATH).toBe('/demande/status');
  });

  it('a trailing slash on the website address does not double the slash', () => {
    expect(buildTrackingUrl(7, 'tok', 'https://www.example.tn///')).toBe(
      'https://www.example.tn/demande/status?id=7&token=tok',
    );
  });

  it('uses FRONTEND_URL, the website, not the API address', () => {
    const before = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'http://localhost:3001/';

    try {
      expect(buildTrackingUrl(1, 'tok')).toBe('http://localhost:3001/demande/status?id=1&token=tok');
    } finally {
      if (before === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = before;
    }
  });

  it('a token with special characters cannot break out of the query', () => {
    const url = buildTrackingUrl(1, 'a&id=2#x y', 'https://s.tn');

    expect(url).toBe('https://s.tn/demande/status?id=1&token=a%26id%3D2%23x+y');
  });

  it('refuses a request number or a token that is not one', () => {
    expect(() => buildTrackingUrl(0, 'tok', 'https://s.tn')).toThrow(/request number/);
    expect(() => buildTrackingUrl(1.5, 'tok', 'https://s.tn')).toThrow(/request number/);
    expect(() => buildTrackingUrl(NaN, 'tok', 'https://s.tn')).toThrow(/request number/);
    expect(() => buildTrackingUrl(1, '', 'https://s.tn')).toThrow(/token/);
    expect(() => buildTrackingUrl(1, undefined as any, 'https://s.tn')).toThrow(/token/);
  });
});
