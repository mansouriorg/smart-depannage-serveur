/**
 * What the phone sends with a proof photo, read the way a server must read it: the values come
 * from a multipart form (everything is text) or from JSON (anything at all), and none of them is
 * trusted to be what it says. Nothing here throws; a value that cannot be read is `null`, and
 * the rules of proof-policy.ts decide what a missing or unreadable value means.
 */

export type RawCapture = {
  latitude?: unknown;
  longitude?: unknown;
  /** The radius of the position, in metres. */
  accuracy?: unknown;
  /** Whether the phone says the position was simulated. */
  mocked?: unknown;
  /** When the phone says the photo was taken: an ISO date or milliseconds since 1970. */
  capturedAt?: unknown;
};

export type ReadCapture = {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  mocked: boolean | null;
  clientCapturedAt: Date | null;
};

/** The most characters of a number in a form: nobody needs more than 15 decimals. */
const MAX_NUMBER_TEXT = 40;

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (typeof value !== 'string') return null;

  const text = value.trim().replace(',', '.');

  if (!text || text.length > MAX_NUMBER_TEXT || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;

  const number = Number(text);

  return Number.isFinite(number) ? number : null;
}

export function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;

  if (typeof value !== 'string') return null;

  const text = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'oui'].includes(text)) return true;
  if (['false', '0', 'no', 'non'].includes(text)) return false;

  return null;
}

/**
 * A number is a count of milliseconds, unless it is too small to be one (below 10^11, which is
 * March 1973): then it is a count of seconds, which is what many phones and libraries send.
 */
function fromEpoch(count: number): Date {
  return new Date(Math.abs(count) < 1e11 ? count * 1000 : count);
}

export function readDate(value: unknown): Date | null {
  let date: Date;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = fromEpoch(value);
  } else if (typeof value === 'string') {
    const text = value.trim();

    if (!text || text.length > 64) return null;

    date = /^\d{10,13}$/.test(text) ? fromEpoch(Number(text)) : new Date(text);
  } else {
    return null;
  }

  const time = date.getTime();

  // A phone whose clock lost its battery says 1970: that is a date, and the clock check flags
  // it. Only what is not a date, or is absurd (the database cannot hold it), is "not said".
  return !Number.isNaN(time) && time >= 0 && time < Date.UTC(2200, 0, 1) ? date : null;
}

export function readCapture(raw: RawCapture | null | undefined): ReadCapture {
  const accuracy = readNumber(raw?.accuracy);

  return {
    latitude: readNumber(raw?.latitude),
    longitude: readNumber(raw?.longitude),
    accuracyM: accuracy !== null && accuracy >= 0 ? accuracy : null,
    mocked: readBoolean(raw?.mocked),
    clientCapturedAt: readDate(raw?.capturedAt),
  };
}
