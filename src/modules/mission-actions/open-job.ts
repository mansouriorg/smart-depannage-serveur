import { CanonicalStatus, canonicalStatus } from '../intervention-workflow/intervention-status';

/** The statuses a job is in while it waits for an artisan (an open job). */
export const OPEN_CANONICAL: CanonicalStatus[] = ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED'];

/**
 * A job is open when nobody has it, or when it waits for an artisan again. The id of an artisan
 * can stay on a job the back office took back (the older update route changes the status and
 * nothing else): that id is a leftover, not somebody holding the job, so for the board, the
 * details and the claim the job is open for everybody, the artisan it was taken from included.
 */
export function isOpenJob(job: { artisanId?: number | null; status?: unknown }): boolean {
  if (job.artisanId === null || job.artisanId === undefined) return true;

  return OPEN_CANONICAL.includes(canonicalStatus(String(job.status)) as CanonicalStatus);
}
