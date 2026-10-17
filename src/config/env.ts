/**
 * Environment configuration (P0-01).
 *
 * The server refuses to start when a secret or URL it depends on is missing.
 * There are no fallback secrets: a forgotten variable must never silently
 * turn into a publicly known signing key.
 *
 * Required variables:
 *   DATABASE_URL        PostgreSQL connection string
 *   JWT_ACCESS_SECRET   signs/verifies access tokens
 *   JWT_REFRESH_SECRET  signs/verifies refresh tokens (must differ from the access secret)
 *   FRONTEND_URL        public website URL, used in links sent to users
 *
 * Optional variables:
 *   CORS_ORIGINS        comma separated list of extra allowed browser origins
 *                       (admin dashboard, ...)
 *   JWT_ACCESS_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN
 *   NODE_ENV            "production" enables the stricter checks below
 *   STATUS_STORAGE      "legacy" (default) or "canonical": which spelling of the
 *                       intervention statuses is written to the database (P1-01).
 *                       Keep "legacy" until the admin, mobile and website apps use
 *                       the new names; see scripts/migrate-status-vocabulary.ts.
 *   SMS_PROVIDER, SMTP_HOST, PUSH_PROVIDER, ...  how messages are delivered (P1-03);
 *                       the full list is in ./delivery.ts and .env.example.
 *   BUSINESS_TIMEZONE   the time zone of the artisans' weekly schedules and of
 *                       appointments, an IANA name (default Africa/Tunis) (P1-05).
 */

import { deliveryConfigProblems } from './delivery';

export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'FRONTEND_URL',
] as const;

/** Values that were used as fallbacks in earlier versions. Never accepted. */
const FORBIDDEN_SECRET_VALUES = new Set([
  'dev_access_secret_change_me',
  'dev_refresh_secret_change_me',
  'change_me',
  'changeme',
  'secret',
]);

const MIN_SECRET_LENGTH_PRODUCTION = 32;
const MIN_SECRET_LENGTH_DEVELOPMENT = 16;

function isProduction(env: Record<string, unknown>): boolean {
  return String(env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function readString(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export const DEFAULT_BUSINESS_TIMEZONE = 'Africa/Tunis';

/** Is this an IANA time zone name this server's runtime knows? */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Passed to ConfigModule.forRoot({ validate }).
 * Throws one error that lists every problem, so the operator can fix them
 * in a single pass instead of one restart per variable.
 */
export function validateEnv(
  rawEnv: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const production = isProduction(rawEnv);

  for (const name of REQUIRED_ENV_VARS) {
    if (!readString(rawEnv, name)) {
      errors.push(`${name} is required but missing or empty.`);
    }
  }

  const minLength = production
    ? MIN_SECRET_LENGTH_PRODUCTION
    : MIN_SECRET_LENGTH_DEVELOPMENT;

  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const value = readString(rawEnv, name);

    if (!value) continue; // already reported above

    if (FORBIDDEN_SECRET_VALUES.has(value.toLowerCase())) {
      errors.push(`${name} uses a known placeholder value. Generate a new one.`);
    } else if (value.length < minLength) {
      errors.push(
        `${name} must be at least ${minLength} characters long` +
          `${production ? ' in production' : ''}.`,
      );
    }
  }

  const access = readString(rawEnv, 'JWT_ACCESS_SECRET');
  const refresh = readString(rawEnv, 'JWT_REFRESH_SECRET');

  if (access && refresh && access === refresh) {
    errors.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be two different values.',
    );
  }

  const frontendUrl = readString(rawEnv, 'FRONTEND_URL');

  if (frontendUrl) {
    try {
      const parsed = new URL(frontendUrl);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('FRONTEND_URL must start with http:// or https://.');
      }
    } catch {
      errors.push(
        'FRONTEND_URL is not a valid URL (example: https://www.example.tn).',
      );
    }
  }

  const statusStorage = readString(rawEnv, 'STATUS_STORAGE').toLowerCase();

  if (statusStorage && statusStorage !== 'legacy' && statusStorage !== 'canonical') {
    errors.push('STATUS_STORAGE must be "legacy" or "canonical" (or empty).');
  }

  const timeZone = readString(rawEnv, 'BUSINESS_TIMEZONE');

  if (timeZone && !isValidTimeZone(timeZone)) {
    errors.push('BUSINESS_TIMEZONE is not a time zone name (example: Africa/Tunis).');
  }

  errors.push(...deliveryConfigProblems(rawEnv));

  if (errors.length > 0) {
    throw new Error(
      [
        'Invalid environment configuration:',
        ...errors.map((message) => `  - ${message}`),
        'See .env.example for the full list of variables.',
      ].join('\n'),
    );
  }

  return rawEnv;
}

/**
 * Value for Express "trust proxy" from the TRUST_PROXY variable.
 *   (empty), "false", "0"  -> undefined: do not trust any proxy
 *   "true"                 -> true: trust every hop (only if the API is not reachable directly)
 *   "1", "2", ...          -> number of proxies in front of the API
 *   anything else          -> passed through (subnet list such as "loopback, 10.0.0.0/8")
 */
export function parseTrustProxy(
  value: string | undefined,
): boolean | number | string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();

  if (lower === 'false' || lower === '0') return undefined;
  if (lower === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}

function requireEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]?.trim();

  if (!value) {
    // validateEnv() makes this unreachable at runtime; this guards scripts and
    // tests that import a service without booting the Nest application.
    throw new Error(`${name} is not set.`);
  }

  return value;
}

export function getJwtAccessSecret(): string {
  return requireEnv('JWT_ACCESS_SECRET');
}

export function getJwtRefreshSecret(): string {
  return requireEnv('JWT_REFRESH_SECRET');
}

/**
 * The time zone in which the artisans' weekly hours ("Monday 08:00-17:00") are
 * written and in which appointments are read. Africa/Tunis unless BUSINESS_TIMEZONE says otherwise.
 */
export function getBusinessTimeZone(): string {
  return (process.env.BUSINESS_TIMEZONE ?? '').trim() || DEFAULT_BUSINESS_TIMEZONE;
}

/** Public website URL without a trailing slash. */
export function getFrontendUrl(): string {
  return requireEnv('FRONTEND_URL').replace(/\/+$/, '');
}

/**
 * Browser origins allowed by CORS.
 * Local development origins are only added outside production.
 */
export function getAllowedOrigins(): string[] {
  const origins = new Set<string>();

  origins.add(new URL(getFrontendUrl()).origin);

  for (const item of (process.env.CORS_ORIGINS ?? '').split(',')) {
    const trimmed = item.trim().replace(/\/+$/, '');
    if (trimmed) origins.add(trimmed);
  }

  if (!isProduction(process.env as Record<string, unknown>)) {
    for (const port of [3000, 3001, 3002]) {
      origins.add(`http://localhost:${port}`);
      origins.add(`http://127.0.0.1:${port}`);
    }
  }

  return [...origins];
}

/**
 * CORS options shared by the three WebSocket gateways.
 * The origin check runs per connection (so .env is already loaded).
 * Requests without an Origin header (native mobile app, server tools) are
 * allowed: they are not browsers, and every gateway still requires a JWT.
 */
export const socketCorsOptions = {
  origin: (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void,
  ) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    callback(null, getAllowedOrigins().includes(origin));
  },
  credentials: true,
};
