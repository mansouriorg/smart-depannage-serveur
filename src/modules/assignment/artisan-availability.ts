import { AppointmentStatus, Status } from '../../../generated/prisma/client';
import { checkWeeklySchedule, WeeklySlot } from '../../common/availability/weekly-schedule';

/**
 * Is this artisan free for a job? One rule, for the matching (who to propose) and
 * for the assignment (who may be given the job), so a name the matching proposes
 * is never refused by the assignment for another reason, and an artisan the
 * scheduling refuses is not "available" in the matching (P1-05).
 */

/**
 * Appointments that hold the artisan's time. A request to cancel does not free the slot:
 * until the back office approves it the visit is still planned (and a rejected request
 * leaves the appointment in that status).
 */
export const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.CANCEL_REQUESTED,
];

/** Jobs that count against the artisan's maximum of active missions (both spellings of the statuses). */
export const ACTIVE_JOB_STATUSES: Status[] = [
  Status.CREATED,
  Status.WAITING_ADMIN_REVIEW,
  Status.QUOTE_SENT,
  Status.QUOTE_ACCEPTED,
  Status.ASSIGNED,
  Status.ARTISAN_ACCEPTED,
  Status.ARTISAN_ON_THE_WAY,
  Status.ARTISAN_ARRIVED,
  Status.IN_PROGRESS,
  Status.WAITING_CLIENT_VALIDATION,
  Status.PAYMENT_PENDING,

  // Old compatibility statuses
  Status.PENDING,
  Status.ADMIN_REVIEW,
  Status.ACCEPTED,
  Status.ON_THE_WAY,
  Status.ARRIVED,
];

export type AvailabilityInput = {
  profile: {
    isAcceptingJobs: boolean;
    emergencyAvailable: boolean;
    maxActiveJobs: number;
    availability: readonly WeeklySlot[];
  };
  /** Active jobs of the artisan, not counting the job being decided. */
  activeJobsCount: number;
  /** Appointments of the artisan over the range, not counting the job being decided. */
  overlappingAppointments: number;
  /** Blocks of time the artisan marked as unavailable, over the range. */
  overlappingTimeBlocks: number;
  /** The time asked for; without it only the profile is looked at. */
  range?: { startsAt: Date; endsAt: Date };
  emergency?: boolean;
  timeZone: string;
  /**
   * The artisan already has this job and it is only being given another time. Whether
   * they take new missions, take urgent ones, or have room for one more is about
   * missions to come, not about this one: only the time is looked at.
   */
  holdsTheJob?: boolean;
};

export type ScheduleReason = ReturnType<typeof checkWeeklySchedule>;

/**
 * What stands in the way, in words for a dispatcher; empty means free.
 * The weekly schedule, the appointments and the blocks only count when a time is given.
 */
export function artisanAvailabilityIssues(input: AvailabilityInput): string[] {
  const issues: string[] = [];

  if (input.range) {
    const schedule = checkWeeklySchedule(
      input.profile.availability,
      input.range.startsAt,
      input.range.endsAt,
      input.timeZone,
    );

    if (!schedule.ok) issues.push(schedule.reason);
    if (input.overlappingAppointments > 0) issues.push('Artisan déjà réservé sur ce créneau.');
    if (input.overlappingTimeBlocks > 0) issues.push('Artisan indisponible sur ce créneau.');
  }

  if (input.holdsTheJob) return issues;

  if (!input.profile.isAcceptingJobs) issues.push('Artisan ne prend pas de missions.');
  if (input.emergency && !input.profile.emergencyAvailable) issues.push('Artisan non disponible pour urgence.');
  if (input.activeJobsCount >= input.profile.maxActiveJobs) issues.push('Artisan au maximum de missions actives.');

  return issues;
}

/** The longest appointment the back office can schedule; a longer one would block an artisan for days. */
export const MAX_APPOINTMENT_MS = 24 * 60 * 60 * 1000;
