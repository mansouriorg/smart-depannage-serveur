/**
 * What the audit log keeps of a request, and how it reads it (P3-02). Pure functions, so the rules are tested one by one.
 *
 * The rule that decides everything here: the log says WHO did WHAT to WHICH thing and WHEN. It does not keep what was
 * written. The body is reduced to the names of its fields, plus the value of the few fields that the list of actions
 * names (`audit-actions.ts`), and never the value of a field whose name looks like a secret.
 */

/** The prefix Nest puts in front of every route (`app.setGlobalPrefix('api')` in main.ts). */
export const GLOBAL_PREFIX = '/api';

/** The methods that change something. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The longest text kept as the value of a detail; a longer one is cut and ends with an ellipsis. */
export const MAX_DETAIL_LENGTH = 200;

/** The most field names kept for one action, and the longest name. */
export const MAX_FIELD_NAMES = 50;
export const MAX_FIELD_NAME_LENGTH = 64;

/** A name that looks like it holds a secret: the value of such a field is never kept, whatever the list of actions says. */
const SENSITIVE = /pass|secret|token|otp|pin$|cvv|card|iban|rib$|bank|signature|code|key|hash|credential/i;

export function isSensitiveField(name: string): boolean {
  return SENSITIVE.test(name);
}

/**
 * The key of a route as the list of actions writes it: `PATCH /users/:/reactivate`. `routePath` is the path Express
 * matched (`/api/users/:id/reactivate`), not the address that was called, so it has no ids in it.
 */
export function auditRouteKey(method: string, routePath: string | undefined | null): string {
  const verb = String(method ?? '').toUpperCase();

  if (typeof routePath !== 'string' || routePath.length === 0) return `${verb} <unknown>`;

  let clean = routePath.split('?')[0];

  if (clean === GLOBAL_PREFIX || clean.startsWith(`${GLOBAL_PREFIX}/`)) clean = clean.slice(GLOBAL_PREFIX.length);

  clean = clean.replace(/:[A-Za-z0-9_]+/g, ':');
  if (clean.length > 1) clean = clean.replace(/\/+$/, '');
  if (!clean.startsWith('/')) clean = `/${clean}`;

  return `${verb} ${clean}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** The names of the fields that were sent (not their values); `file` is added when a file came with the request. */
export function changedFieldsOf(body: unknown, hasFile = false): string[] {
  const names: string[] = [];

  if (isPlainObject(body)) {
    for (const name of Object.keys(body)) {
      if (names.length >= MAX_FIELD_NAMES) break;
      if (name.length === 0 || name.length > MAX_FIELD_NAME_LENGTH) continue;
      if (!/^[A-Za-z0-9_$.-]+$/.test(name)) continue;
      if (body[name] === undefined) continue;
      names.push(name);
    }
  }

  if (hasFile && !names.includes('file') && names.length < MAX_FIELD_NAMES) names.push('file');

  return names;
}

export type DetailValue = string | number | boolean;

/** The fields whose value may be a sentence a person typed. Every other detail must look like a code or an id (`CANCELLED`, `42`, `CASH`). */
export const FREE_TEXT_DETAILS: ReadonlySet<string> = new Set(['reason']);

/** What a code or an id looks like: no space, no markup, no control character. */
const CODE_LIKE = /^[A-Za-z0-9_.:+-]{1,64}$/;

/** A decimal number written as plain digits, with an optional sign and fraction. */
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/** A text that begins the way a number does. */
const STARTS_LIKE_NUMBER = /^[+-]?\.?\d/;

/** A UTF-16 half of an emoji with no other half (a request may carry one: `"\ud800"` is valid JSON). PostgreSQL's jsonb refuses it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text with its control characters taken out (a NUL cannot be stored in PostgreSQL text or jsonb, and a line break would break a log
 * line), its lone surrogates taken out (the database refuses them), and trimmed.
 */
export function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(LONE_SURROGATE, ' ').replace(/\s+/g, ' ').trim();
}

/** A text cut to `max` UTF-16 units with an ellipsis, without cutting an emoji in two. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;

  let end = max - 1;

  // do not end on the first half of a pair
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;

  return `${text.slice(0, end)}…`;
}

/**
 * The values kept for the fields the action names: from the route parameters first and the body second (a parameter of the path is
 * what the route acted on; the body is what the caller says), a finite number, a boolean, or a text. A text is a code or an id, except
 * for the fields of `FREE_TEXT_DETAILS`, which keep a sentence cut at `MAX_DETAIL_LENGTH`. Objects, lists, nothing, a text that is
 * neither, and any field with a secret-looking name are left out. Null when nothing is kept.
 */
export function detailsOf(wanted: readonly string[] | undefined, body: unknown, params: unknown): Record<string, DetailValue> | null {
  if (!wanted || wanted.length === 0) return null;

  const kept: Record<string, DetailValue> = {};

  for (const name of wanted) {
    if (isSensitiveField(name)) continue;

    const fromPath = isPlainObject(params) ? params[name] : undefined;
    const fromBody = isPlainObject(body) ? body[name] : undefined;
    const value = fromPath !== undefined && fromPath !== null ? fromPath : fromBody;

    if (typeof value === 'string') {
      const text = cleanText(value);

      if (text.length === 0) continue;

      if (FREE_TEXT_DETAILS.has(name)) {
        kept[name] = cutText(text, MAX_DETAIL_LENGTH);
      } else if (PLAIN_NUMBER.test(text)) {
        // a number that came as text is what the handler's validation turns it into (`"12.50"` is 12.5): kept as that number
        const number = Number(text);

        if (Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER) kept[name] = number;
      } else if (CODE_LIKE.test(text) && !STARTS_LIKE_NUMBER.test(text)) {
        // a text that starts like a number but is not a plain one (`0x7D0`, `2e3`, `1_000`) means different things to different readers: not kept
        kept[name] = text;
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      kept[name] = value;
    } else if (typeof value === 'boolean') {
      kept[name] = value;
    }
  }

  return Object.keys(kept).length > 0 ? kept : null;
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;

  for (const step of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[step];
  }

  return current;
}

/**
 * An id as the log writes it. Every id of this server is a whole number, so that is all that is accepted, written without leading
 * zeros (`/users/0000042` reaches user 42, and the row says 42). Anything else (`0x2A`, `1e1`, `42.0`, a word) gives null: a text of
 * the caller's choosing never reaches the table as an id, and a row with no target is better than a row with a wrong one.
 */
export function canonicalId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  // no id of this server has more than 15 digits
  const digits = value.replace(/^0+/, '');

  return digits.length > 0 && digits.length <= 15 ? digits : null;
}

/** The id of what an action created, read at `path` (`id`, `profile.id`) of the answer of the route. Null when it is not there. */
export function idFromResult(result: unknown, path: string): string | null {
  return canonicalId(readPath(result, path));
}

/** The HTTP status of an error thrown by a handler: its own when it is an HTTP exception, 500 otherwise. */
export function statusOfError(error: unknown): number {
  const candidate = error as { getStatus?: () => unknown } | null;

  if (candidate && typeof candidate.getStatus === 'function') {
    const status = candidate.getStatus();

    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }

  return 500;
}
