import { defaultReminders, replaceDefaultReminders } from './appointment-reminders';

const NOW = new Date('2026-10-17T10:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3600_000);

describe('defaultReminders', () => {
  it('a day before and two hours before, for the customer and for the artisan', () => {
    const reminders = defaultReminders({ id: 9, startsAt: hours(72), clientId: 1, artisanId: 2 }, NOW);

    expect(reminders.length).toBe(4);
    expect(reminders.map((r) => `${r.recipientId}:${r.minutesBefore}`).sort()).toEqual(['1:120', '1:1440', '2:120', '2:1440']);
    expect(reminders.find((r) => r.minutesBefore === 120)!.dueAt.getTime()).toBe(hours(70).getTime());
  });

  it('a reminder that would already be due is not made', () => {
    const reminders = defaultReminders({ id: 9, startsAt: hours(5), clientId: 1, artisanId: 2 }, NOW);

    expect(reminders.map((r) => r.minutesBefore)).toEqual([120, 120]);
    expect(defaultReminders({ id: 9, startsAt: hours(1), clientId: 1, artisanId: 2 }, NOW)).toEqual([]);
  });

  it('nobody to remind, or no time yet: nothing', () => {
    expect(defaultReminders({ id: 9, startsAt: null, clientId: 1, artisanId: 2 }, NOW)).toEqual([]);
    expect(defaultReminders({ id: 9, startsAt: hours(72), clientId: null, artisanId: null }, NOW)).toEqual([]);
    expect(defaultReminders({ id: 9, startsAt: hours(72), clientId: 1, artisanId: null }, NOW).length).toBe(2);
  });
});

describe('replaceDefaultReminders', () => {
  it('drops the reminders not sent yet and creates the right ones, in that order', async () => {
    const calls: string[] = [];
    const db: any = {
      appointmentReminder: {
        deleteMany: async (args: any) => calls.push(`delete ${args.where.status}`),
        createMany: async (args: any) => calls.push(`create ${args.data.length}`),
      },
    };

    const made = await replaceDefaultReminders(db, { id: 9, startsAt: hours(72), clientId: 1, artisanId: 2 }, NOW);

    expect(made).toBe(4);
    expect(calls).toEqual(['delete PENDING', 'create 4']);
  });

  it('nothing to create: the old ones are still dropped (the time or the artisan changed)', async () => {
    const calls: string[] = [];
    const db: any = {
      appointmentReminder: {
        deleteMany: async () => calls.push('delete'),
        createMany: async () => calls.push('create'),
      },
    };

    await replaceDefaultReminders(db, { id: 9, startsAt: hours(1), clientId: 1, artisanId: 2 }, NOW);

    expect(calls).toEqual(['delete']);
  });
});
