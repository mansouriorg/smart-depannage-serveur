import { requestLocale } from './request-locale';

describe('the language a request asks for (P3-04)', () => {
  it('reads the X-App-Locale header (Node lower-cases header names)', () => {
    expect(requestLocale({ headers: { 'x-app-locale': 'ar' } })).toBe('ar');
    expect(requestLocale({ headers: { 'x-app-locale': 'fr' } })).toBe('fr');
    expect(requestLocale({ headers: { 'x-app-locale': 'AR-tn' } })).toBe('ar');
  });

  it('takes the first value when the header is repeated', () => {
    expect(requestLocale({ headers: { 'x-app-locale': ['ar', 'fr'] } })).toBe('ar');
  });

  it('is French when the header is missing, empty or names another language', () => {
    expect(requestLocale({ headers: {} })).toBe('fr');
    expect(requestLocale({})).toBe('fr');
    expect(requestLocale(null)).toBe('fr');
    expect(requestLocale(undefined)).toBe('fr');
    expect(requestLocale({ headers: { 'x-app-locale': '' } })).toBe('fr');
    expect(requestLocale({ headers: { 'x-app-locale': 'en' } })).toBe('fr');
  });

  it('does not read the Accept-Language header: a browser set to Arabic does not turn the dashboard Arabic', () => {
    expect(requestLocale({ headers: { 'accept-language': 'ar,fr;q=0.5' } })).toBe('fr');
  });
});
