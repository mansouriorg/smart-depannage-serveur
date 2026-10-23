/**
 * Decimals out, numbers in (P2-01).
 *
 * Prisma answers a money column as a Decimal object, and `JSON.stringify` writes a Decimal as a text ("12.345"). The apps
 * (the dashboard, the mobile app, the website) read money as numbers, and the shared package types say `number`, so the
 * server answers numbers: every Decimal in an answer becomes the number with the same decimals (12.345 stays 12.345).
 * The websocket events go through the same function (see `RealtimeService`).
 */

/** Whether a value is a Prisma (decimal.js) Decimal, without importing either of them. */
export function isDecimal(value: unknown): value is { toNumber(): number; toString(): string } {
  if (value === null || typeof value !== 'object') return false;

  const candidate = value as { constructor?: { name?: string }; toNumber?: unknown };

  return (
    (Object.prototype.toString.call(value) === '[object Decimal]' || candidate.constructor?.name === 'Decimal') &&
    typeof candidate.toNumber === 'function'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of `value` in which every Decimal, at any depth of the arrays and the plain objects, is a number. Dates, Buffers,
 * streams and class instances are returned as they are. The input is never changed. A structure that contains itself
 * (JSON could not write it anyway) is not followed round again.
 */
export function decimalsToNumbers<T>(value: T): T {
  return convert(value, new Set<object>()) as T;
}

function convert(value: unknown, ancestors: Set<object>): unknown {
  if (isDecimal(value)) return Number(String(value));

  if (value === null || typeof value !== 'object') return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (ancestors.has(value)) return value;

  ancestors.add(value);

  try {
    if (Array.isArray(value)) return value.map((item) => convert(item, ancestors));

    const copy: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) copy[key] = convert(item, ancestors);

    return copy;
  } finally {
    ancestors.delete(value);
  }
}
