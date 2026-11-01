import { NotFoundException } from '@nestjs/common';

import { distanceKm } from '../../common/geo/distance';
import { readLocationConfig, validPoint } from '../../common/geo/location-rules';

/**
 * The route of a job (P3-05): the positions the technician's phone sent while on the way, arrived and at work, in order, with the moments of
 * the job, and what a dispute asks first: how close did the technician come to the address, and how far from it were they when they said
 * they had arrived. The back office reads it (permission `location.history`); nobody else does.
 *
 * A route is one technician's. A job can change hands (the technician gives it back, the staff hands it to another): the route shown is the
 * one of the technician who holds the job now, or, when nobody holds it, of the last one who sent a position on it. The positions of the
 * others are not drawn into it; the answer says they exist (`others`) and they are read by naming the technician.
 *
 * The moments are the job's own dates (set out, arrived, work started, work finished), written in the same transaction as the status. They
 * belong to the technician who holds the job now: a technician who gave it back has none shown.
 */

/** The most positions one answer carries: three hours at one position every ten seconds is about a thousand. */
export const MAX_ROUTE_POINTS = 2_000;

/** The moments of the timeline that frame a route. */
export const ROUTE_MOMENTS = ['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'WORK_STARTED', 'WORK_COMPLETED'] as const;

/** A position sent this long around the moment of "arrived" is the one that says where the technician was then. */
export const ARRIVAL_WINDOW_MINUTES = 5;

export type RouteMomentType = (typeof ROUTE_MOMENTS)[number];

export interface RoutePoint {
  at: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  speedMps: number | null;
  heading: number | null;
}

export interface RouteMoment {
  type: RouteMomentType;
  at: Date;
}

export interface RouteSummary {
  pointCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Length of the line through the positions, in kilometres. */
  pathKm: number;
  /** The nearest the technician came to the address, in metres, and when; null when there is no address point or no position. */
  closest: { meters: number; at: Date } | null;
  /** The position nearest in time to the moment of "arrived" (within five minutes), and how far from the address it was; null when there is none. */
  atArrival: { meters: number; at: Date; arrivedAt: Date } | null;
}

/** A technician other than the one drawn, who also sent positions on this job. */
export interface RouteOther {
  artisan: { id: number; name: string };
  pointCount: number;
  firstAt: Date;
  lastAt: Date;
}

export interface JobRoute {
  interventionId: number;
  /** Whose route this is; `current` is true when they hold the job now. */
  artisan: { id: number; name: string; current: boolean } | null;
  /** The other technicians who sent positions on this job (a hand-over), none of which are in `points`. */
  others: RouteOther[];
  destination: { latitude: number; longitude: number; address: string | null } | null;
  points: RoutePoint[];
  moments: RouteMoment[];
  summary: RouteSummary;
  /** How many days positions are kept (the setting in force now). */
  historyDays: number;
  /** True when the technician set out longer ago than the history is kept: the first positions may have been deleted already. */
  mayBeIncomplete: boolean;
  /** True when the answer was cut at `MAX_ROUTE_POINTS`: the latest positions are not in it. */
  cut: boolean;
}

const metres = (km: number) => Math.round(km * 1000);

/** The column of the job that holds each moment. */
const MOMENT_COLUMNS: Record<RouteMomentType, string> = {
  ARTISAN_ON_THE_WAY: 'artisanOnTheWayAt',
  ARTISAN_ARRIVED: 'artisanArrivedAt',
  WORK_STARTED: 'workStartedAt',
  WORK_COMPLETED: 'workCompletedAt',
};

export function summarizeRoute(
  points: RoutePoint[],
  destination: { latitude: number; longitude: number } | null,
  moments: RouteMoment[],
): RouteSummary {
  let pathKm = 0;

  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];

    pathKm += distanceKm(from.latitude, from.longitude, to.latitude, to.longitude);
  }

  let closest: RouteSummary['closest'] = null;

  if (destination) {
    for (const point of points) {
      const meters = metres(distanceKm(point.latitude, point.longitude, destination.latitude, destination.longitude));

      if (!closest || meters < closest.meters) closest = { meters, at: point.at };
    }
  }

  let atArrival: RouteSummary['atArrival'] = null;
  const arrived = moments.find((moment) => moment.type === 'ARTISAN_ARRIVED');

  if (destination && arrived) {
    const window = ARRIVAL_WINDOW_MINUTES * 60_000;
    let best: { point: RoutePoint; gap: number } | null = null;

    for (const point of points) {
      const gap = Math.abs(point.at.getTime() - arrived.at.getTime());

      if (gap <= window && (!best || gap < best.gap)) best = { point, gap };
    }

    if (best) {
      atArrival = {
        meters: metres(distanceKm(best.point.latitude, best.point.longitude, destination.latitude, destination.longitude)),
        at: best.point.at,
        arrivedAt: arrived.at,
      };
    }
  }

  return {
    pointCount: points.length,
    firstAt: points[0]?.at ?? null,
    lastAt: points[points.length - 1]?.at ?? null,
    pathKm: Math.round(pathKm * 100) / 100,
    closest,
    atArrival,
  };
}

export async function routeOfJob(db: any, interventionId: number, now: Date = new Date(), wanted: number | null = null): Promise<JobRoute> {
  const job = await db.intervention.findUnique({
    where: { id: interventionId },
    select: {
      id: true,
      address: true,
      latitude: true,
      longitude: true,
      artisanId: true,
      artisan: { select: { id: true, name: true } },
      createdAt: true,
      assignedAt: true,
      artisanOnTheWayAt: true,
      artisanArrivedAt: true,
      workStartedAt: true,
      workCompletedAt: true,
    },
  });

  if (!job) throw new NotFoundException('Intervention introuvable.');

  // Whose route: the one asked for, else who holds the job, else who sent the latest position on it.
  const latest = wanted == null && job.artisanId == null ? await db.artisanLocationPing.findFirst({ where: { interventionId }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { artisanId: true } }) : null;
  const shownId: number | null = wanted ?? job.artisanId ?? latest?.artisanId ?? null;

  const [rows, otherGroups] = await Promise.all([
    shownId == null
      ? []
      : db.artisanLocationPing.findMany({
          where: { interventionId, artisanId: shownId },
          orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
          take: MAX_ROUTE_POINTS + 1,
        }),
    // The others are counted by the database, whatever their number of positions: a former holder with a long road is not cut at the size of an answer.
    db.artisanLocationPing.groupBy({
      by: ['artisanId'],
      where: { interventionId, ...(shownId == null ? {} : { artisanId: { not: shownId } }) },
      _count: { _all: true },
      _min: { recordedAt: true },
      _max: { recordedAt: true },
    }),
  ]);

  // A technician asked for by number is shown only if they hold the job or sent positions on it: the number of a customer, of a member of
  // the staff or of any other account is not a route, and the answer must not give its name.
  if (wanted != null && wanted !== job.artisanId && rows.length === 0) throw new NotFoundException('Technicien introuvable.');

  const cut = rows.length > MAX_ROUTE_POINTS;

  const points: RoutePoint[] = rows.slice(0, MAX_ROUTE_POINTS).map((row: any) => ({
    at: new Date(row.recordedAt),
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracyMeters ?? null,
    speedMps: row.speedMps ?? null,
    heading: row.heading ?? null,
  }));

  // The names: the technician drawn (when they are not the one who holds the job) and the others.
  const needed = [...otherGroups.map((group: any) => group.artisanId as number), ...(shownId != null && job.artisan?.id !== shownId ? [shownId] : [])];
  const people: any[] = needed.length ? await db.user.findMany({ where: { id: { in: needed } }, select: { id: true, name: true } }) : [];
  const nameOf = (id: number): string => (id === job.artisan?.id ? job.artisan.name : people.find((person) => person.id === id)?.name) ?? '';

  const others: RouteOther[] = (otherGroups as any[])
    .map((group) => ({ artisan: { id: group.artisanId as number, name: nameOf(group.artisanId) }, pointCount: group._count?._all ?? 0, firstAt: new Date(group._min.recordedAt), lastAt: new Date(group._max.recordedAt) }))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());

  const current = shownId != null && shownId === job.artisanId;

  // The moments are the job's: they are shown with the route of the technician who holds it. A hand-over by the staff leaves the dates of the
  // technician before on the job, so only the moments from the day the job was given to the holder on count.
  const heldSince = job.assignedAt ? new Date(job.assignedAt).getTime() : null;

  const moments: RouteMoment[] = current
    ? ROUTE_MOMENTS.flatMap((type) => {
        const value = job[MOMENT_COLUMNS[type]];

        if (!value) return [];

        const at = new Date(value);

        return heldSince !== null && at.getTime() < heldSince ? [] : [{ type, at }];
      }).sort((a, b) => a.at.getTime() - b.at.getTime())
    : [];

  const destination = validPoint(job.latitude, job.longitude);
  const { historyDays } = readLocationConfig();
  // Where the road began: the first moment of the holder; with none (a route of a technician who no longer holds the job), the day the job was
  // made, which is the earliest it can have begun. Positions older than the days kept are gone, so a road that may have begun before is incomplete.
  const began = moments[0]?.at ?? (job.createdAt ? new Date(job.createdAt) : null);

  return {
    interventionId: job.id,
    artisan: shownId == null ? null : { id: shownId, name: nameOf(shownId), current },
    others,
    destination: destination ? { ...destination, address: job.address ?? null } : null,
    points,
    moments,
    summary: summarizeRoute(points, destination, moments),
    historyDays,
    mayBeIncomplete: began !== null && now.getTime() - began.getTime() > historyDays * 24 * 60 * 60 * 1000,
    cut,
  };
}
