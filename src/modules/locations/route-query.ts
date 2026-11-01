import { BadRequestException } from '@nestjs/common';

/**
 * The `artisanId` of the route call (P3-05): the technician whose route is asked for, when it is not the one who holds the job.
 *
 * It is read as TEXT on purpose. Declared as a number, the global `ValidationPipe({ transform: true })` turns a query that is not there into
 * `NaN` before `ParseIntPipe({ optional: true })` is asked, and the call without it (the normal one) would be refused with a 400. As text it
 * reaches here as it was written, and this decides:
 *  - not there, or empty: no technician named, the route is the one of whoever holds the job;
 *  - whole digits only: that number (the service answers 404 for one that is no technician, or beyond what the database can hold);
 *  - anything else ("1e3", "0x10", " 7 ", "-1", "1.5", "abc", a list): a 400, not a guess.
 */
export function routeArtisanOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new BadRequestException('Technicien invalide.');

  return Number(raw);
}
