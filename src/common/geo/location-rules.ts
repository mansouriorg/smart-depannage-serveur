import { distanceKm } from './distance';

/**
 * The rules about a technician's position (P3-05), all of them pure so that a test can pin each number:
 *
 *   - how long a position can stay without news before it is called stale (the dispatcher sees the flag, the customer is not given an arrival
 *     time built on it);
 *   - how long the history of positions is kept;
 *   - how a time of arrival is worked out from a position and a destination.
 *
 * Settings (both optional, a value out of its range is ignored and the default is used):
 *
 *   LOCATION_STALE_MINUTES   silence after which a position is stale, 2 to 120 (default 10)
 *   LOCATION_HISTORY_DAYS    days the positions are kept, 1 to 90 (default 7)
 */

export const DEFAULT_STALE_AFTER_MINUTES = 10;
export const MIN_STALE_AFTER_MINUTES = 2;
export const MAX_STALE_AFTER_MINUTES = 120;

export const DEFAULT_HISTORY_DAYS = 7;
export const MIN_HISTORY_DAYS = 1;
export const MAX_HISTORY_DAYS = 90;

/** At most one position is added to the history this often for a technician (the current position is always updated). */
export const MIN_SECONDS_BETWEEN_PINGS = 10;

/** A technician's own phone says where it is about this often while the app is open; the silence limit has to be a good deal longer. */
export const EXPECTED_PING_SECONDS = 30;

/** Average speed of a technician through the traffic, in km/h, on the road distance. */
export const AVERAGE_SPEED_KMH = 30;

/** The road is longer than the straight line between two points: the straight line is multiplied by this. */
export const ROAD_FACTOR = 1.3;

type Env = Record<string, unknown>;

export interface LocationConfig {
  staleAfterMinutes: number;
  historyDays: number;
}

function integerSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const text = typeof raw === 'string' ? raw.trim() : '';

  if (!text) return fallback;

  const value = Number(text);

  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function readLocationConfig(env: Env = process.env): LocationConfig {
  return {
    staleAfterMinutes: integerSetting(env, 'LOCATION_STALE_MINUTES', DEFAULT_STALE_AFTER_MINUTES, MIN_STALE_AFTER_MINUTES, MAX_STALE_AFTER_MINUTES),
    historyDays: integerSetting(env, 'LOCATION_HISTORY_DAYS', DEFAULT_HISTORY_DAYS, MIN_HISTORY_DAYS, MAX_HISTORY_DAYS),
  };
}

// ==========================================================
// Is the position old?
// ==========================================================

/** `fresh`: news within the limit; `stale`: none for the limit or longer; `unknown`: no position, or nobody knows when it was sent. */
export type PositionFreshness = 'fresh' | 'stale' | 'unknown';

export interface PositionAge {
  state: PositionFreshness;
  /** Whole minutes since the position was sent (0 for a time in the future); null when it is not known. */
  ageMinutes: number | null;
}

function timeOf(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(time) ? time : null;
}

/** The age of a position, and whether it is stale: the silence reached the limit (a silence of exactly the limit is stale). */
export function positionAge(
  positionAt: Date | string | number | null | undefined,
  now: Date = new Date(),
  staleAfterMinutes: number = readLocationConfig().staleAfterMinutes,
): PositionAge {
  const at = timeOf(positionAt);

  if (at === null) return { state: 'unknown', ageMinutes: null };

  const silenceMs = Math.max(0, now.getTime() - at);

  return {
    state: silenceMs >= staleAfterMinutes * 60_000 ? 'stale' : 'fresh',
    ageMinutes: Math.floor(silenceMs / 60_000),
  };
}

// ==========================================================
// Coordinates
// ==========================================================

export interface Point {
  latitude: number;
  longitude: number;
}

/**
 * A coordinate as it arrives on a socket: a number, or a text that holds one. A null, an empty text, `false` or a list is no number
 * (`Number(null)` and `Number([])` are 0, which would turn half a reading into a place); it gives NaN, which `validPoint` refuses.
 */
export function coordinateOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);

  return Number.NaN;
}

/** A number inside [min, max], else null: the accuracy, the speed and the heading of a reading are kept only when they are possible. */
export function optionalNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** A pair of numbers that is a place on the earth: finite, inside the ranges, and not the 0,0 a phone reports when it has no reading. */
export function validPoint(latitude: unknown, longitude: unknown): Point | null {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;

  return { latitude, longitude };
}

// ==========================================================
// The time of arrival
// ==========================================================

/** Minutes of driving for a straight-line distance, rounded up, never less than one. Null for a distance that is not a number. */
export function travelMinutes(straightLineKm: number): number | null {
  if (typeof straightLineKm !== 'number' || !Number.isFinite(straightLineKm) || straightLineKm < 0) return null;

  return Math.max(1, Math.ceil(((straightLineKm * ROAD_FACTOR) / AVERAGE_SPEED_KMH) * 60));
}

/** `no-destination`: the job has no point on the map, so there is nothing to measure to. */
export type ArrivalState = PositionFreshness | 'no-destination';

export interface Arrival {
  state: ArrivalState;
  /** Minutes until the technician is there; only with a fresh position and a destination, otherwise null. */
  minutes: number | null;
  ageMinutes: number | null;
}

export interface ArrivalInput {
  /** The technician's last position and the time it was sent. */
  artisan: { latitude?: number | null; longitude?: number | null; positionAt?: Date | string | number | null } | null | undefined;
  /** The job's point on the map. */
  destination: { latitude?: number | null; longitude?: number | null } | null | undefined;
  now?: Date;
  staleAfterMinutes?: number;
}

/**
 * When the technician will be there. An arrival time is given only from a position that is fresh: from an old one it would be
 * a guess presented as a measure (the customer is told the position is not up to date instead).
 */
export function arrivalOf(input: ArrivalInput): Arrival {
  const now = input.now ?? new Date();
  const from = validPoint(input.artisan?.latitude, input.artisan?.longitude);
  const age = from ? positionAge(input.artisan?.positionAt, now, input.staleAfterMinutes) : ({ state: 'unknown', ageMinutes: null } as PositionAge);
  const to = validPoint(input.destination?.latitude, input.destination?.longitude);

  if (!to) return { state: 'no-destination', minutes: null, ageMinutes: age.ageMinutes };
  if (!from || age.state !== 'fresh') return { state: age.state, minutes: null, ageMinutes: age.ageMinutes };

  return {
    state: 'fresh',
    minutes: travelMinutes(distanceKm(from.latitude, from.longitude, to.latitude, to.longitude)),
    ageMinutes: age.ageMinutes,
  };
}
