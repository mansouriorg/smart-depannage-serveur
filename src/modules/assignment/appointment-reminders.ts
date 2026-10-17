import { AppointmentReminderStatus } from '../../../generated/prisma/client';

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
      const dueAt = new Date(startsAt.getTime() - minutesBefore * 60 * 1000);

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
