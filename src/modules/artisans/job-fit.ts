import { ZoneCircle, zoneVerdict } from '../../common/geo/zone-match';
import { tradesOfProfile } from './trade-fields';

/**
 * Whether an open job is one an artisan may be offered and may take (P1-11): it is of one of
 * their trades and it is inside one of their zones. One place for the board of open jobs, the
 * details of an open job and the taking of one, so a job the board does not list cannot be taken
 * by calling the route with its number.
 *
 * An artisan whose profile names no trade, or no zone that can be drawn, is not limited on that
 * side (see tradesOfProfile and zoneVerdict). A job given to an artisan on purpose by the back
 * office is not judged here: the dispatcher may send someone outside their usual area.
 */
export type FitProfile = {
  specialty?: string | null;
  specialties?: string[] | null;
  serviceTypes?: string[] | null;
  serviceZones?: ZoneCircle[] | null;
};

export type FitJob = {
  serviceType?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type Misfit = 'trade' | 'zone';

/** Why the job is not for this artisan, or null if it is (the trade is judged first). */
export function misfitOf(profile: FitProfile, job: FitJob): Misfit | null {
  const trades = tradesOfProfile(profile);

  if (trades && job.serviceType && !(trades as string[]).includes(job.serviceType)) return 'trade';

  if (!zoneVerdict(profile.serviceZones ?? [], job).matches) return 'zone';

  return null;
}

export const MISFIT_MESSAGE = 'Cette mission ne correspond pas à vos métiers ou à vos zones d’intervention.';
