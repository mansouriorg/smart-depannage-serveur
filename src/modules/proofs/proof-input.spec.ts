import { readBoolean, readCapture, readDate, readNumber } from './proof-input';

describe('readNumber', () => {
  it('reads numbers and the text of a form', () => {
    expect(readNumber(36.8)).toBe(36.8);
    expect(readNumber('36.8008')).toBe(36.8008);
    expect(readNumber(' -10.18 ')).toBe(-10.18);
    expect(readNumber('+5')).toBe(5);
    expect(readNumber('.5')).toBe(0.5);
    expect(readNumber('1e2')).toBe(100);
  });

  it('a decimal comma is a decimal point (a phone set to French)', () => {
    expect(readNumber('36,8008')).toBe(36.8008);
  });

  it('what is not a number is null, and never NaN', () => {
    for (const value of ['', ' ', 'abc', '12abc', '1.2.3', 'NaN', 'Infinity', '--5', null, undefined, {}, [], [1], true, NaN, Infinity]) {
      expect(readNumber(value as any)).toBeNull();
    }
  });

  it('a very long text is not a number', () => {
    expect(readNumber('1'.repeat(200))).toBeNull();
  });
});

describe('readBoolean', () => {
  it('reads booleans and the text of a form', () => {
    expect(readBoolean(true)).toBe(true);
    expect(readBoolean(false)).toBe(false);
    expect(readBoolean('true')).toBe(true);
    expect(readBoolean('TRUE')).toBe(true);
    expect(readBoolean('false')).toBe(false);
    expect(readBoolean('1')).toBe(true);
    expect(readBoolean('0')).toBe(false);
    expect(readBoolean(1)).toBe(true);
    expect(readBoolean(0)).toBe(false);
  });

  it('anything else is "not said", not "false"', () => {
    for (const value of ['', 'maybe', 'null', 2, null, undefined, {}, []]) {
      expect(readBoolean(value as any)).toBeNull();
    }
  });
});

describe('readDate', () => {
  it('reads ISO dates and milliseconds', () => {
    expect(readDate('2026-10-17T10:00:00Z')!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    expect(readDate(Date.UTC(2026, 9, 17, 10))!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    expect(readDate(String(Date.UTC(2026, 9, 17, 10)))!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    expect(readDate(new Date('2026-10-17T10:00:00Z'))!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('a count of seconds (what many phones send) is read as seconds, not as the year 1970', () => {
    const seconds = Math.floor(Date.UTC(2026, 9, 17, 10) / 1000);

    expect(String(seconds)).toMatch(/^\d{10}$/);
    expect(readDate(seconds)!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    expect(readDate(String(seconds))!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    // Milliseconds stay milliseconds, down to the first year they cannot be mistaken (1973).
    expect(readDate(Date.UTC(2001, 0, 1))!.toISOString()).toBe('2001-01-01T00:00:00.000Z');
    expect(readDate(String(Date.UTC(1999, 5, 1)))!.toISOString()).toBe('1999-06-01T00:00:00.000Z');
  });

  it('a phone with a dead clock says 1970 and that is still a date (the clock check flags it)', () => {
    expect(readDate('1970-01-01T00:00:05Z')).not.toBeNull();
  });

  it('what is not a date, or one the database cannot hold, is null', () => {
    for (const value of ['', 'yesterday', 'nonsense', '9999-99-99', new Date('x'), null, undefined, {}, true, '+275760-09-13T00:00:00Z', 'a'.repeat(100)]) {
      expect(readDate(value as any)).toBeNull();
    }
  });
});

describe('readCapture', () => {
  it('reads a whole form', () => {
    const read = readCapture({
      latitude: '36.8008',
      longitude: '10.1815',
      accuracy: '12.5',
      mocked: 'false',
      capturedAt: '2026-10-17T10:00:00Z',
    });

    expect(read.latitude).toBe(36.8008);
    expect(read.longitude).toBe(10.1815);
    expect(read.accuracyM).toBe(12.5);
    expect(read.mocked).toBe(false);
    expect(read.clientCapturedAt!.toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('the app of today sends no accuracy and no mocked flag: they are "not said"', () => {
    const read = readCapture({ latitude: '36.8', longitude: '10.18', capturedAt: '2026-10-17T10:00:00Z' });

    expect(read.accuracyM).toBeNull();
    expect(read.mocked).toBeNull();
  });

  it('a negative accuracy is not said', () => {
    expect(readCapture({ accuracy: '-3' }).accuracyM).toBeNull();
    expect(readCapture({ accuracy: '0' }).accuracyM).toBe(0);
  });

  it('nothing at all reads as nothing', () => {
    expect(readCapture(undefined)).toEqual({ latitude: null, longitude: null, accuracyM: null, mocked: null, clientCapturedAt: null });
    expect(readCapture({})).toEqual({ latitude: null, longitude: null, accuracyM: null, mocked: null, clientCapturedAt: null });
    expect(readCapture(null)).toEqual({ latitude: null, longitude: null, accuracyM: null, mocked: null, clientCapturedAt: null });
  });
});
