import * as crypto from 'crypto';

/**
 * The bot check of the public request form (P1-16).
 *
 * The form that anybody can post, with no account, used to be protected by a limit per address only. Three
 * cheap barriers are added, none of them needs a third-party service or shows anything to a person:
 *
 *   1. a hidden field that a person never fills (`website`): a script that fills every field is refused;
 *   2. a challenge the server signs (GET /guest/challenge) that the page solves in the background by finding
 *      a number whose SHA-256 starts with a few zero bits, which costs a script a little for each request;
 *   3. an age: the challenge cannot be used in its first seconds (nobody fills a form in 3 s) and not after
 *      half an hour, and it is used once.
 *
 * Be clear about what this is: it makes a flood of requests slower and dearer, it does not stop a determined
 * person. A captcha service (Cloudflare Turnstile, hCaptcha) is the stronger step if the form is attacked;
 * it would replace the challenge here and nothing else.
 *
 * The signed challenge needs no storage. "Used once" is remembered in memory, so it holds for one server
 * process: with several processes a solved challenge can be used once on each (the limit per address still
 * applies to every one of them), and a restart forgets what was used (a challenge still in its 30 minutes can
 * then be used once more).
 */

export const BOT_CHECK_PURPOSE_GUEST_CREATE = 'guest-create';

/** The same answer for every reason, so the answer teaches a script nothing. */
export const BOT_CHECK_MESSAGE =
  'La vérification de sécurité a échoué. Rechargez la page et réessayez.';

export const BOT_CHECK_CODE = 'BOT_CHECK_FAILED';

export type BotCheckConfig = {
  enabled: boolean;
  /** Leading zero bits the solution must have: each bit doubles the work. */
  bits: number;
  /** A challenge is refused before this age (a person has not finished the form). */
  minAgeMs: number;
  /** ...and after this one. */
  maxAgeMs: number;
};

export const DEFAULT_BOT_CHECK_BITS = 16;
export const MIN_BOT_CHECK_BITS = 8;
export const MAX_BOT_CHECK_BITS = 24;
export const BOT_CHECK_MIN_AGE_MS = 3_000;
export const BOT_CHECK_MAX_AGE_MS = 30 * 60_000;

type Env = Record<string, unknown>;

function text(env: Env, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 *   BOT_CHECK         on (default) | off: "off" lets every request through, for a website that does not
 *                     send the check yet, and for local tests
 *   BOT_CHECK_BITS    difficulty, 8 to 24 (default 16, about 65 000 attempts for the page: a second or two)
 *   BOT_CHECK_SECRET  signs the challenges; empty = derived from JWT_ACCESS_SECRET
 */
export function readBotCheckConfig(env: Env = process.env): BotCheckConfig {
  const mode = text(env, 'BOT_CHECK').toLowerCase();
  const raw = text(env, 'BOT_CHECK_BITS');
  const bits = Number(raw);

  return {
    enabled: !['off', 'false', '0', 'no'].includes(mode),
    bits:
      raw && Number.isInteger(bits) && bits >= MIN_BOT_CHECK_BITS && bits <= MAX_BOT_CHECK_BITS
        ? bits
        : DEFAULT_BOT_CHECK_BITS,
    minAgeMs: BOT_CHECK_MIN_AGE_MS,
    maxAgeMs: BOT_CHECK_MAX_AGE_MS,
  };
}

/** Mistakes in the bot check variables, for validateEnv(). Unset variables are fine. */
export function botCheckConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  const mode = text(env, 'BOT_CHECK').toLowerCase();

  if (mode && !['on', 'true', '1', 'yes', 'off', 'false', '0', 'no'].includes(mode)) {
    problems.push('BOT_CHECK must be "on" or "off" (or empty).');
  }

  const raw = text(env, 'BOT_CHECK_BITS');
  const bits = Number(raw);

  if (raw && !(Number.isInteger(bits) && bits >= MIN_BOT_CHECK_BITS && bits <= MAX_BOT_CHECK_BITS)) {
    problems.push(`BOT_CHECK_BITS must be a whole number from ${MIN_BOT_CHECK_BITS} to ${MAX_BOT_CHECK_BITS} (or empty).`);
  }

  return problems;
}

/** The key the challenges are signed with: its own value, or one derived from the access-token secret. */
export function botCheckSecret(env: Env, accessSecret: () => string): Buffer {
  const own = text(env, 'BOT_CHECK_SECRET');

  if (own) return Buffer.from(own, 'utf8');

  return crypto.createHmac('sha256', accessSecret()).update('smart-depannage:bot-check:v1').digest();
}

/** How many zero bits a digest starts with. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;

  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }

    bits += Math.clz32(byte) - 24;
    break;
  }

  return bits;
}

/** What the page hashes: the challenge, a colon and its number (the website computes the same). */
export function solutionDigest(challenge: string, solution: string): Buffer {
  return crypto.createHash('sha256').update(`${challenge}:${solution}`, 'utf8').digest();
}

export type IssuedChallenge = {
  enabled: true;
  challenge: string;
  bits: number;
  /** Milliseconds the page must wait after receiving it before sending the form. */
  waitMs: number;
  /** Milliseconds the challenge stays good. */
  expiresInMs: number;
};

export type BotCheckInput = {
  challenge?: unknown;
  solution?: unknown;
  /** The hidden field: a person leaves it empty. */
  honeypot?: unknown;
};

export type BotCheckVerdict =
  | { ok: true }
  | { ok: false; reason: 'honeypot' | 'missing' | 'malformed' | 'signature' | 'purpose' | 'too-early' | 'expired' | 'easy' | 'wrong-solution' | 'reused' };

const SOLUTION_FORMAT = /^[0-9a-z]{1,24}$/i;
const CHALLENGE_FORMAT = /^v1\.([0-9a-f]{24})\.(\d{10,16})\.(\d{1,2})\.([a-z-]{1,24})\.([A-Za-z0-9_-]{43})$/;

/** The most solved challenges kept to refuse a second use. */
const MAX_REMEMBERED = 50_000;

export class BotChecker {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly options: {
      config: BotCheckConfig;
      secret: () => Buffer;
      now?: () => number;
      randomId?: () => string;
      /** How many used challenges are remembered at most (default 50 000). */
      maxRemembered?: number;
    },
  ) {}

  get config(): BotCheckConfig {
    return this.options.config;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.options.secret()).update(body).digest('base64url');
  }

  /** A signed challenge, or `{ enabled: false }` when the check is off (the page then sends nothing). */
  issue(purpose: string = BOT_CHECK_PURPOSE_GUEST_CREATE): IssuedChallenge | { enabled: false } {
    const { config } = this.options;

    if (!config.enabled) return { enabled: false };

    const id = this.options.randomId ? this.options.randomId() : crypto.randomBytes(12).toString('hex');
    const body = `v1.${id}.${this.now()}.${config.bits}.${purpose}`;

    return {
      enabled: true,
      challenge: `${body}.${this.sign(body)}`,
      bits: config.bits,
      waitMs: config.minAgeMs,
      expiresInMs: config.maxAgeMs,
    };
  }

  verify(input: BotCheckInput, purpose: string = BOT_CHECK_PURPOSE_GUEST_CREATE): BotCheckVerdict {
    const { config } = this.options;

    if (!config.enabled) return { ok: true };

    // A person never sees the hidden field. Anything in it, even a space, is a script.
    if (typeof input.honeypot === 'string' ? input.honeypot.length > 0 : input.honeypot != null) {
      return { ok: false, reason: 'honeypot' };
    }

    if (typeof input.challenge !== 'string' || typeof input.solution !== 'string') {
      return { ok: false, reason: 'missing' };
    }

    const match = CHALLENGE_FORMAT.exec(input.challenge);

    if (!match || !SOLUTION_FORMAT.test(input.solution)) {
      return { ok: false, reason: 'malformed' };
    }

    const [, id, issuedAtText, bitsText, forPurpose, signature] = match;
    const body = input.challenge.slice(0, input.challenge.length - signature.length - 1);
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);

    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return { ok: false, reason: 'signature' };
    }

    if (forPurpose !== purpose) return { ok: false, reason: 'purpose' };

    const age = this.now() - Number(issuedAtText);

    // A date in the future cannot come from this server (the signature is its own).
    if (age < config.minAgeMs) return { ok: false, reason: 'too-early' };
    if (age > config.maxAgeMs) return { ok: false, reason: 'expired' };

    // The difficulty was signed with the challenge; one issued before it was raised is not good enough now.
    const bits = Number(bitsText);

    if (bits < config.bits) return { ok: false, reason: 'easy' };

    if (leadingZeroBits(solutionDigest(input.challenge, input.solution)) < bits) {
      return { ok: false, reason: 'wrong-solution' };
    }

    // Used once: remembered until it would have expired anyway.
    this.forgetExpired();

    if (this.used.has(id)) return { ok: false, reason: 'reused' };

    this.used.set(id, Number(issuedAtText) + config.maxAgeMs);

    if (this.used.size > (this.options.maxRemembered ?? MAX_REMEMBERED)) {
      // Oldest first (a Map keeps the order of insertion).
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) this.used.delete(oldest);
    }

    return { ok: true };
  }

  private forgetExpired() {
    if (this.used.size < 1000) return;

    const now = this.now();

    for (const [id, until] of this.used) {
      if (until < now) this.used.delete(id);
    }
  }

  /** For tests: how many solved challenges are remembered. */
  get remembered(): number {
    return this.used.size;
  }
}
