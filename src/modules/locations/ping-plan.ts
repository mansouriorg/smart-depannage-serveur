import { BadRequestException } from '@nestjs/common';

import { MIN_SECONDS_BETWEEN_PINGS, optionalNumber, validPoint } from '../../common/geo/location-rules';
import { canonicalStatus, withAliases } from '../intervention-workflow/intervention-status';

/**
 * What to write when a technician's phone says where it is (P3-05). Every place that writes a technician's position asks this first, so
 * the position, the time it was sent and the history are never written apart:
 *
 *   - the current position gets its time (`positionAt`): without it nobody can tell a position from this minute from one of last week;
 *   - the history gets a row only for a position sent on a job: the one on the way, arrived or at work. A position sent while waiting, or
 *     on the way home, belongs to no job: nothing replays it, so nothing keeps it (only the current position, with its time, is written);
 *   - and only if the last row of the technician, whatever the job, is not less than `MIN_SECONDS_BETWEEN_PINGS` old (a phone that reports
 *     every second, or that names two jobs by turns, does not fill the table; the current position is written all the same).
 *
 * It only reads. The writes are made by the caller, in its own transaction, from the plan.
 */

/** The statuses in which a position is part of the route of a job. */
export const ROUTE_STATUSES = ['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS'] as const;

export interface PositionReading {
  latitude: unknown;
  longitude: unknown;
  /** The radius of doubt, in metres. */
  accuracy?: unknown;
  /** Metres per second, as the phone reports it. */
  speed?: unknown;
  /** Degrees from north. */
  heading?: unknown;
}

export interface PingRow {
  artisanId: number;
  interventionId: number;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  speedMps: number | null;
  heading: number | null;
  recordedAt: Date;
}

export interface PingPlan {
  latitude: number;
  longitude: number;
  positionAt: Date;
  /** The row to add to the history; null when the last one is too recent. */
  history: PingRow | null;
}

export const NOT_A_POSITION = 'Position invalide.';

export async function planPing(
  db: any,
  artisanId: number,
  reading: PositionReading,
  options: { interventionId?: number | null; now?: Date } = {},
): Promise<PingPlan> {
  const point = validPoint(reading?.latitude, reading?.longitude);

  if (!point) throw new BadRequestException(NOT_A_POSITION);

  const now = options.now ?? new Date();

  // The job the technician is on: the one named (it must be theirs and at a stage of the route). Otherwise the one on the way, then the one
  // arrived, then the one at work, the latest first: a technician who went to work on one job and sets out for another is on the way to the other.
  const jobs: Array<{ id: number; status: string }> = await db.intervention.findMany({
    where: {
      artisanId,
      status: { in: withAliases([...ROUTE_STATUSES]) },
      ...(typeof options.interventionId === 'number' ? { id: options.interventionId } : {}),
    },
    orderBy: { id: 'desc' },
    select: { id: true, status: true },
    take: 20,
  });

  const rank = (status: string) => ROUTE_STATUSES.indexOf(canonicalStatus(status) as (typeof ROUTE_STATUSES)[number]);
  const job = [...jobs].sort((a, b) => rank(a.status) - rank(b.status) || b.id - a.id)[0] ?? null;

  let history: PingRow | null = null;

  if (job) {
    // The newest row that is not from the future: a row dated ahead (a clock that was set back) does not hide the ones before it, and does not
    // hold the history for ever either; the floor is the ten seconds before now.
    const last = await db.artisanLocationPing.findFirst({
      where: { artisanId, recordedAt: { lte: now } },
      orderBy: { recordedAt: 'desc' },
      select: { recordedAt: true },
    });

    const age = last ? now.getTime() - new Date(last.recordedAt).getTime() : Infinity;
    const tooSoon = age >= 0 && age < MIN_SECONDS_BETWEEN_PINGS * 1000;

    if (!tooSoon) {
      history = {
        artisanId,
        interventionId: job.id,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyMeters: optionalNumber(reading.accuracy, 0, 100_000),
        speedMps: optionalNumber(reading.speed, 0, 200),
        heading: optionalNumber(reading.heading, 0, 360),
        recordedAt: now,
      };
    }
  }

  return { latitude: point.latitude, longitude: point.longitude, positionAt: now, history };
}
