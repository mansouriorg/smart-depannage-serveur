import { distanceKm } from './distance';

/**
 * Whether a job is inside the zones an artisan works in (P1-11).
 *
 * One rule for the board of open jobs and for the matching of artisans to a job, which each had
 * their own idea (the board looked at no zone at all, the matching dropped any artisan whose
 * zones had no coordinates). A zone is a circle: a centre and a radius in kilometres.
 *
 *  - only an active zone that has a centre counts; an artisan with none (never gave one, or only
 *    typed a name that could not be placed) is not limited: before this rule they saw every job
 *    of their trades, and a zone that cannot be drawn must not hide every job from them;
 *  - a job whose position is unknown cannot be judged and is let through;
 *  - otherwise the job must be inside the radius of one zone.
 */
export interface ZoneCircle {
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
  isActive: boolean;
}

export type ZoneVerdict =
  | { matches: true; kind: 'unrestricted' }
  | { matches: true; kind: 'unknown-position' }
  | { matches: true; kind: 'inside'; distanceKm: number }
  | { matches: false; kind: 'outside' };

/** The position of a job; any part missing means "unknown". */
export interface JobPosition {
  latitude?: number | null;
  longitude?: number | null;
}

/** The zones that can be drawn: active, with a centre. */
export function drawableZones(zones: ZoneCircle[]): ZoneCircle[] {
  return zones.filter(
    (zone) => zone.isActive && typeof zone.latitude === 'number' && typeof zone.longitude === 'number',
  );
}

export function zoneVerdict(zones: ZoneCircle[], job: JobPosition): ZoneVerdict {
  const drawable = drawableZones(zones);

  if (!drawable.length) return { matches: true, kind: 'unrestricted' };

  if (typeof job.latitude !== 'number' || typeof job.longitude !== 'number') {
    return { matches: true, kind: 'unknown-position' };
  }

  for (const zone of drawable) {
    const km = distanceKm(job.latitude, job.longitude, zone.latitude as number, zone.longitude as number);

    if (km <= zone.radiusKm) return { matches: true, kind: 'inside', distanceKm: km };
  }

  return { matches: false, kind: 'outside' };
}
