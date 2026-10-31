import {
  AppointmentReminderStatus,
  AppointmentStatus,
  NotificationChannel,
} from '../../../generated/prisma/client';

import { formatLocalDateTime } from '../../common/availability/weekly-schedule';
import { canonicalStatus, STATUS_GROUPS } from '../intervention-workflow/intervention-status';
import { ACTIVE_APPOINTMENT_STATUSES } from './artisan-availability';

/** A reminder a day before and two hours before, for the customer and for the artisan. */
export const REMINDER_MINUTES_BEFORE = [1440, 120];

export type ReminderData = {
  appointmentId: number;
  recipientId: number;
  minutesBefore: number;
  dueAt: Date;
};

/** The reminders an appointment should have; one that would already be due is not made. */
export function defaultReminders(
  appointment: { id: number; startsAt: Date | null; clientId: number | null; artisanId: number | null },
  now: Date = new Date(),
): ReminderData[] {
  if (!appointment.startsAt) return [];

  const startsAt = appointment.startsAt;
  const recipients = [appointment.clientId, appointment.artisanId].filter(
    (id): id is number => typeof id === 'number',
  );
  const reminders: ReminderData[] = [];

  for (const recipientId of recipients) {
    for (const minutesBefore of REMINDER_MINUTES_BEFORE) {
      const dueAt = reminderDueAt(startsAt, minutesBefore);

      if (dueAt <= now) continue;

      reminders.push({ appointmentId: appointment.id, recipientId, minutesBefore, dueAt });
    }
  }

  return reminders;
}

/**
 * The reminders of an appointment, made again: the ones not sent yet are dropped
 * (they may be for another time, or for the artisan who no longer has the job)
 * and the right ones created. Reminders already sent stay as a record.
 */
export async function replaceDefaultReminders(
  db: { appointmentReminder: { deleteMany: (args: any) => Promise<unknown>; createMany: (args: any) => Promise<unknown> } },
  appointment: { id: number; startsAt: Date | null; clientId: number | null; artisanId: number | null },
  now: Date = new Date(),
): Promise<number> {
  await db.appointmentReminder.deleteMany({
    where: { appointmentId: appointment.id, status: AppointmentReminderStatus.PENDING },
  });

  const reminders = defaultReminders(appointment, now);

  if (reminders.length) {
    await db.appointmentReminder.createMany({ data: reminders });
  }

  return reminders.length;
}

/**
 * How long before the visit, said the way a person says it (P3-01): the reminders are kept in minutes (1440, 120), and
 * "dans 1440 minutes" is not something anybody reads. From an hour on it is hours ("24 heures", "2 heures", "1 heure 30",
 * "1 heure 05": the minutes keep two digits, so that "1 heure 5" is never read as an hour and five hours), below that minutes.
 */
export function reminderLeadWording(minutesBefore: number): string {
  const total = Math.max(Math.round(minutesBefore), 0);

  if (total < 60) return `${total} minute${total > 1 ? 's' : ''}`;

  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const hoursText = `${hours} heure${hours > 1 ? 's' : ''}`;

  return minutes === 0 ? hoursText : `${hoursText} ${String(minutes).padStart(2, '0')}`;
}

/**
 * The time that is really left, for a reminder that is sent when `now` says (P3-01). A reminder is sent a little after it is due, and a
 * long way after it when the sender was down: "dans 24 heures" with three hours left would be wrong. From an hour on the time left is
 * given to the nearest five minutes (a reminder due at 08:00 and sent at 08:00:40 still says two hours for a visit at 10:00); it is
 * never more than the reminder was made for.
 */
export function reminderLeadMinutes(minutesBefore: number, startsAt: Date, now: Date): number {
  const made = Math.max(Math.round(minutesBefore), 0);
  const left = (startsAt.getTime() - now.getTime()) / 60000;

  if (!Number.isFinite(left) || left <= 0) return made;

  // The timer runs every few minutes and a batch can be cut short: a reminder a few minutes late still says what it was made to say.
  if (made >= 60 && made - left >= 0 && made - left <= REMINDER_LATE_TOLERANCE_MINUTES) return made;

  const said = left < 60 ? Math.ceil(left) : Math.round(left / 5) * 5;

  return Math.min(said, made);
}

/** How late a reminder may go out and still say the time it was made for ("2 heures" at 1 h 52). */
export const REMINDER_LATE_TOLERANCE_MINUTES = 10;

/** When a reminder is due for a visit at this time: the reminders are made from it, and made again when it changes. */
export function reminderDueAt(startsAt: Date, minutesBefore: number): Date {
  return new Date(startsAt.getTime() - minutesBefore * 60 * 1000);
}

/**
 * What the reminder says: how long before, and the day and hour on the clock of the business, so it is right even if it comes late.
 * With `now`, the time that is really left is the one said (see `reminderLeadMinutes`); without, the time the reminder was made for.
 */
export function reminderMessage(minutesBefore: number, startsAt: Date, timeZone: string, now?: Date): string {
  const lead = now ? reminderLeadMinutes(minutesBefore, startsAt, now) : minutesBefore;

  return `Votre intervention est prévue dans ${reminderLeadWording(lead)}, le ${formatLocalDateTime(startsAt, timeZone)}.`;
}

/**
 * The statuses of a job whose work is done (P3-01): the finished ones and the one that waits for the customer's payment (the artisan has
 * left; the quote decisions and the payout holds read it the same way). A visit is not moved, cancelled or reminded about after that: from
 * PAYMENT_PENDING the table of statuses does not even allow a cancellation, so an approved one could never be written.
 */
export const WORK_DONE_STATUSES: readonly string[] = [...STATUS_GROUPS.completed, 'PAYMENT_PENDING'];

/**
 * Whether a reminder that is due should still go out (P3-01). A reminder was made for a visit as it was: it is not sent for a visit that
 * was cancelled, that is over or no longer has a time, for a job that was cancelled, finished or disputed, that has already started, or
 * to somebody who is neither the customer nor the artisan of the visit any more. Returns why not (written on the reminder), or null.
 */
export function reminderSkipReason(
  reminder: { recipientId: number | null },
  appointment: { status: AppointmentStatus | string; startsAt: Date | null; clientId: number | null; artisanId: number | null },
  jobStatus: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!reminder.recipientId || !appointment.startsAt) return 'Missing recipient or appointment start.';

  if (!(ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(appointment.status))) {
    return `The visit is ${String(appointment.status).toLowerCase()}: nothing to remind.`;
  }

  if (jobStatus) {
    const status = String(canonicalStatus(jobStatus));

    for (const group of ['cancelled', 'disputed'] as const) {
      if ((STATUS_GROUPS[group] as readonly string[]).includes(status)) return `The job is ${group}: nothing to remind.`;
    }

    if (WORK_DONE_STATUSES.includes(status)) return 'The job is completed: nothing to remind.';
  }

  if (appointment.startsAt <= now) return 'The visit has already started.';

  if (reminder.recipientId !== appointment.clientId && reminder.recipientId !== appointment.artisanId) {
    return 'The recipient no longer takes part in the visit.';
  }

  return null;
}

/**
 * Where a reminder goes. A person with the app: in the app, a push and an e-mail. A guest has no app and no mailbox (the address is made up),
 * so a guest is reached by SMS, the one place a guest reads.
 */
export function reminderChannels(recipient: { isGuest?: boolean | null }): NotificationChannel[] {
  return recipient.isGuest
    ? [NotificationChannel.IN_APP, NotificationChannel.SMS]
    : [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL];
}
