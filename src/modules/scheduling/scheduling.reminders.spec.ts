import { resetLocale } from '../../common/locale/locale';
import { emptyWorld, World } from '../../common/testing/world';
import { NotificationsService } from '../notifications/notifications.service';
import { defaultReminders, reminderChannels, reminderLeadMinutes, reminderLeadWording, reminderMessage, reminderSkipReason } from '../assignment/appointment-reminders';

import { lockJob } from '../assignment/artisan-lock';

import { SchedulingService } from './scheduling.service';

/**
 * The reminders of a visit (P3-01): none for a visit that was cancelled, a wording a person can read ("2 heures", not "120 minutes"),
 * the notification type of a reminder, and an SMS for a guest.
 */

const NOW = new Date('2099-10-19T05:00:00.000Z');
// 07:00 UTC is 08:00 in Tunis (no daylight saving time in Tunisia).
const VISIT_STARTS = new Date('2099-10-19T07:00:00.000Z');
const VISIT_ENDS = new Date('2099-10-19T09:00:00.000Z');

describe('how long before, said the way a person says it', () => {
  it('from an hour on, in hours', () => {
    expect(reminderLeadWording(1440)).toBe('24 heures');
    expect(reminderLeadWording(120)).toBe('2 heures');
    expect(reminderLeadWording(60)).toBe('1 heure');
    expect(reminderLeadWording(90)).toBe('1 heure 30');
    expect(reminderLeadWording(2880)).toBe('48 heures');
  });

  it('the minutes after the hours keep two digits: "1 heure 05" is never read as an hour and five hours', () => {
    expect(reminderLeadWording(61)).toBe('1 heure 01');
    expect(reminderLeadWording(65)).toBe('1 heure 05');
    expect(reminderLeadWording(125)).toBe('2 heures 05');
    expect(reminderLeadWording(119)).toBe('1 heure 59');
  });

  it('below an hour, in minutes', () => {
    expect(reminderLeadWording(45)).toBe('45 minutes');
    expect(reminderLeadWording(1)).toBe('1 minute');
    expect(reminderLeadWording(59)).toBe('59 minutes');
  });

  it('never says "1440 minutes" or "120 minutes", whatever the reminders of the day are', () => {
    const reminders = defaultReminders({ id: 1, startsAt: new Date('2099-10-20T07:00:00Z'), clientId: 2, artisanId: 4 }, NOW);

    expect(reminders.map((reminder) => reminder.minutesBefore).sort((a, b) => a - b)).toEqual([120, 120, 1440, 1440]);

    for (const reminder of reminders) {
      expect(reminderMessage(reminder.minutesBefore, VISIT_STARTS, 'Africa/Tunis')).not.toMatch(/minutes/);
    }
  });

  it('said at the time it is sent, it is the time that is really left, to the nearest five minutes from an hour on, and never more than the reminder was made for', () => {
    const minutesBefore = (minutes: number) => new Date(VISIT_STARTS.getTime() - minutes * 60000);

    expect(reminderLeadMinutes(120, VISIT_STARTS, minutesBefore(120))).toBe(120);
    // sent 40 seconds after it was due: still two hours
    expect(reminderLeadMinutes(120, VISIT_STARTS, new Date(minutesBefore(120).getTime() + 40000))).toBe(120);
    // the sender was down: the 24 hour reminder goes out with three hours left
    expect(reminderLeadMinutes(1440, VISIT_STARTS, minutesBefore(180))).toBe(180);
    expect(reminderLeadMinutes(1440, VISIT_STARTS, minutesBefore(183))).toBe(185);
    // less than an hour: the minutes left, rounded up (a visit in 20 seconds is in 1 minute, never in 0)
    expect(reminderLeadMinutes(120, VISIT_STARTS, minutesBefore(25))).toBe(25);
    expect(reminderLeadMinutes(120, VISIT_STARTS, new Date(VISIT_STARTS.getTime() - 20000))).toBe(1);
    // earlier than it was made for: never more
    expect(reminderLeadMinutes(120, VISIT_STARTS, minutesBefore(300))).toBe(120);
    // no time left, or no valid time: what it was made for
    expect(reminderLeadMinutes(120, VISIT_STARTS, VISIT_STARTS)).toBe(120);
    expect(reminderLeadMinutes(120, new Date('nope'), NOW)).toBe(120);
  });

  it('a reminder a few minutes late (the timer runs every five minutes) still says what it was made to say; later than that, the time left', () => {
    const minutesBefore = (minutes: number) => new Date(VISIT_STARTS.getTime() - minutes * 60000);

    expect(reminderLeadMinutes(1440, VISIT_STARTS, minutesBefore(1437))).toBe(1440);
    expect(reminderLeadMinutes(1440, VISIT_STARTS, minutesBefore(1430))).toBe(1440);
    expect(reminderLeadMinutes(1440, VISIT_STARTS, minutesBefore(1429))).toBe(1430);
    expect(reminderLeadMinutes(120, VISIT_STARTS, minutesBefore(115))).toBe(120);
    expect(reminderLeadMinutes(120, VISIT_STARTS, minutesBefore(105))).toBe(105);
    expect(reminderMessage(1440, VISIT_STARTS, 'Africa/Tunis', minutesBefore(1437))).toContain('dans 24 heures');
    expect(reminderMessage(1440, VISIT_STARTS, 'Africa/Tunis', minutesBefore(1429))).toContain('dans 23 heures 50');
  });

  it('a message sent late says the time left, with the day and the hour of the visit', () => {
    expect(reminderMessage(1440, VISIT_STARTS, 'Africa/Tunis', new Date(VISIT_STARTS.getTime() - 3 * 3600000))).toBe('Votre intervention est prévue dans 3 heures, le 19/10/2099 à 08:00.');
  });

  it('says the day and the hour of the visit on the clock of the business, so that a late reminder is still right', () => {
    expect(reminderMessage(120, VISIT_STARTS, 'Africa/Tunis')).toBe('Votre intervention est prévue dans 2 heures, le 19/10/2099 à 08:00.');
    expect(reminderMessage(1440, VISIT_STARTS, 'Africa/Tunis')).toBe('Votre intervention est prévue dans 24 heures, le 19/10/2099 à 08:00.');
  });
});

describe('when a reminder is no longer wanted', () => {
  const visit = (data: Record<string, any> = {}) => ({ status: 'SCHEDULED', startsAt: VISIT_STARTS, clientId: 2, artisanId: 4, ...data });
  const why = (data: Record<string, any> = {}, jobStatus: string | null = 'ASSIGNED', recipientId: number | null = 2) => reminderSkipReason({ recipientId }, visit(data), jobStatus, NOW);

  it('a visit that stands, for the customer or the artisan of the visit: it goes out', () => {
    expect(why()).toBeNull();
    expect(why({}, 'ASSIGNED', 4)).toBeNull();

    for (const status of ['SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED']) expect(why({ status })).toBeNull();
  });

  it('a visit that was cancelled, that took place, that the artisan missed, or that nobody planned: nothing to remind', () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REQUESTED']) expect(why({ status })).not.toBeNull();

    expect(why({ status: 'CANCELLED' })).toContain('cancelled');
  });

  it('a job that was cancelled, finished or disputed: nothing to remind, even if the visit was left standing', () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'DISPUTED']) expect(why({}, status)).not.toBeNull();

    expect(why({}, 'CANCELLED')).toContain('job');
  });

  it('a job finished under an old spelling (INVOICE_READY is INVOICE_SENT) is not reminded', () => {
    expect(why({}, 'INVOICE_READY')).not.toBeNull();
  });

  it('a job that is under way, in either spelling of accepted, is reminded', () => {
    for (const status of ['ASSIGNED', 'ACCEPTED', 'ARTISAN_ACCEPTED', 'ON_THE_WAY']) expect(why({}, status)).toBeNull();
  });

  it('a visit that has started, or that has no time any more', () => {
    expect(why({ startsAt: new Date('2099-10-19T04:59:00Z') })).toContain('started');
    expect(why({ startsAt: NOW })).toContain('started');
    expect(why({ startsAt: null })).not.toBeNull();
  });

  it('somebody who is not on the visit (the artisan who gave the job back), or nobody', () => {
    expect(why({}, 'ASSIGNED', 9)).toContain('no longer');
    expect(why({}, 'ASSIGNED', null)).not.toBeNull();
    expect(why({ artisanId: null }, 'ASSIGNED', 4)).not.toBeNull();
  });
});

describe('where a reminder goes', () => {
  it('a person with the app: the app, a push and an e-mail', () => {
    expect(reminderChannels({ isGuest: false })).toEqual(['IN_APP', 'PUSH', 'EMAIL']);
    expect(reminderChannels({})).toEqual(['IN_APP', 'PUSH', 'EMAIL']);
  });

  it('a guest: the SMS, and not the e-mail (the address is made up) nor the push (no app)', () => {
    const channels = reminderChannels({ isGuest: true });

    expect(channels).toContain('SMS');
    expect(channels).not.toContain('EMAIL');
    expect(channels).not.toContain('PUSH');
  });
});

interface Desk {
  world: World;
  service: SchedulingService;
  client: any;
  artisan: any;
  job: any;
  visit: any;
  told: any[];
  queued: any[];
  reminders: () => any[];
  addReminder: (data?: Record<string, any>) => any;
  /** The same service on the real notification service, with an outbox that keeps what is queued. */
  real: () => SchedulingService;
}

function desk(options: { visit?: Record<string, any>; jobStatus?: string; client?: Record<string, any> } = {}): Desk {
  resetLocale();

  const world = emptyWorld();
  const m = world.memory;
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma', email: 'salma@example.com', phone: '20111222', ...(options.client ?? {}) });
  const artisan = m.plant('user', { role: 'ARTISAN', name: 'Karim', email: 'karim@example.com', phone: '20333444' });
  const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.jobStatus ?? 'ASSIGNED', serviceType: 'PLOMBIER' });
  const visit = m.plant('appointment', { interventionId: job.id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: soon(2), endsAt: soon(4), ...(options.visit ?? {}) });
  const told: any[] = [];
  const queued: any[] = [];
  const notifications: any = { notify: async (payload: any) => told.push(payload) || { id: told.length } };

  const real = () => {
    const outbox: any = { enqueue: async (message: any) => queued.push(message) };
    const templates: any = { render: async (_key: string, _channel: string, _vars: any, fallback: any) => fallback, clearCache: () => undefined };
    const gateway: any = { emitToUser: () => undefined };

    return new SchedulingService(world.prisma, world.svc.assignment, new NotificationsService(world.prisma, gateway, outbox, templates));
  };

  return {
    world,
    service: new SchedulingService(world.prisma, world.svc.assignment, notifications),
    client,
    artisan,
    job,
    visit,
    told,
    queued,
    reminders: () => m.rows('appointmentReminder'),
    addReminder: (data: Record<string, any> = {}) =>
      m.plant('appointmentReminder', { appointmentId: visit.id, recipientId: client.id, minutesBefore: 120, dueAt: soon(-1), status: 'PENDING', ...data }),
    real,
  };
}

/** The cron reads the clock of the machine: the times of these specs are given from it (an hour is an hour from now). */
const HOUR = 60 * 60 * 1000;
const soon = (hours: number) => new Date(Math.floor((Date.now() + hours * HOUR) / 60000) * 60000);

const sendAt = (service: SchedulingService) => service.sendDueReminders();

describe('the reminder that goes out', () => {
  it('says hours, carries the visit\'s day and hour, and is a reminder (its own type), to the person whose reminder it is', async () => {
    const d = desk();

    d.addReminder({ minutesBefore: 120 });
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.told[0].recipientId).toBe(d.client.id);
    expect(d.told[0].type).toBe('APPOINTMENT_REMINDER');
    expect(d.told[0].title).toBe('Rappel de rendez-vous');
    expect(d.told[0].message).toBe(reminderMessage(120, d.visit.startsAt, 'Africa/Tunis'));
    expect(d.told[0].message).toMatch(/^Votre intervention est prévue dans 2 heures, le \d\d\/\d\d\/\d{4} à \d\d:\d\d\.$/);
    expect(d.told[0].message).not.toContain('120');
    expect(d.told[0].entityType).toBe('APPOINTMENT');
    expect(d.told[0].entityId).toBe(d.visit.id);
    expect(d.reminders()[0].status).toBe('SENT');
    expect(d.reminders()[0].sentAt instanceof Date).toBe(true);
  });

  it('the same notice carries its Arabic for the person who chose it: the title, and the hours with the day and the hour of the visit set apart (P3-04)', async () => {
    const d = desk();

    d.addReminder({ minutesBefore: 120 });
    await sendAt(d.service);

    const texts = d.told[0].texts;

    expect(typeof texts).toBe('function');
    expect(texts('fr')).toEqual({ title: d.told[0].title, message: d.told[0].message });
    expect(texts('ar').title).toBe('تذكير بالموعد');
    expect(texts('ar').message).toBe(reminderMessage(120, d.visit.startsAt, 'Africa/Tunis', new Date(), 'ar'));
    expect(texts('ar').message).toMatch(/[؀-ۿ]/);
    expect(texts('ar').message).toMatch(/⁨\d\d\/\d\d\/\d{4}⁩/);
    expect(texts('ar').message).not.toBe(d.told[0].message);
  });

  it('the day-before reminder says 24 hours', async () => {
    const d = desk();

    d.world.memory.rows('appointment')[0].startsAt = soon(24);
    d.world.memory.rows('appointment')[0].endsAt = soon(26);
    d.addReminder({ minutesBefore: 1440, dueAt: soon(-0.01) });
    await sendAt(d.service);

    expect(d.told[0].message).toContain('dans 24 heures');
    expect(d.told[0].message).not.toContain('1440');
  });

  it('a day-before reminder that goes out late says the time that is really left', async () => {
    const d = desk();

    // the visit is in two hours; the reminder of the day before is sent only now
    d.addReminder({ minutesBefore: 1440, dueAt: soon(-22) });
    await sendAt(d.service);

    expect(d.told[0].message).toContain('dans 2 heures');
    expect(d.told[0].message).not.toContain('24 heures');
  });

  it('carries the job, so that a tap on the push opens it', async () => {
    const d = desk();

    d.addReminder();
    await sendAt(d.service);

    expect(d.told[0].data).toEqual({ interventionId: d.job.id, appointmentId: d.visit.id, minutesBefore: 120 });
  });

  it('goes to the app, a push and an e-mail for a person with the app', async () => {
    const d = desk();

    d.addReminder();
    await sendAt(d.service);

    expect(d.told[0].channels).toEqual(['IN_APP', 'PUSH', 'EMAIL']);
  });

  it('does not go out before it is due, nor twice', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(1) });
    d.addReminder({ status: 'SENT', sentAt: soon(-3) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['PENDING', 'SENT']);
  });
});

describe('a reminder for a visit that no longer stands is not sent (P3-01)', () => {
  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('a visit that is %s: skipped, with the reason, and nobody is written to', async (status) => {
    const d = desk({ visit: { status } });

    d.addReminder();
    d.addReminder({ recipientId: d.artisan.id, minutesBefore: 1440, dueAt: soon(-2) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(d.reminders()[0].error).toContain(status.toLowerCase());
  });

  it('a job that was cancelled while its visit was left standing', async () => {
    const d = desk({ jobStatus: 'CANCELLED' });

    d.addReminder();
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });

  it.each(['COMPLETED', 'PAID', 'DISPUTED'])('a job that is %s', async (jobStatus) => {
    const d = desk({ jobStatus });

    d.addReminder();
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });

  it('a visit that has already started', async () => {
    const d = desk({ visit: { startsAt: soon(-0.5), endsAt: soon(1) } });

    d.addReminder();
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });

  it('a reminder for the artisan who has given the job back', async () => {
    const d = desk();

    d.addReminder({ recipientId: d.artisan.id });
    d.world.memory.rows('appointment')[0].artisanId = null;
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });

  it('the visit cancelled by an approved request: the reminders made for it never go out, whichever of the two ways they are dropped', async () => {
    const d = desk();
    const admin = d.world.memory.plant('user', { role: 'DISPATCHER' });

    d.addReminder();
    d.addReminder({ recipientId: d.artisan.id });

    const request: any = await d.service.requestCancel(d.client.id, 'CLIENT' as any, d.visit.id, { reason: 'Plus besoin' } as any);

    await d.service.reviewAppointmentRequest(admin.id, 'DISPATCHER' as any, request.id, true, { adminResponse: 'Ok' } as any);

    // The reminders went with the visit; and even one that was left behind is not sent.
    d.addReminder({ recipientId: d.artisan.id });
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders().every((reminder) => reminder.status !== 'SENT')).toBe(true);
  });

  it('a reminder that is skipped does not hold up the ones behind it', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-5), recipientId: 9999 });
    d.addReminder();
    await sendAt(d.service);

    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SKIPPED', 'SENT']);
    expect(d.told).toHaveLength(1);
  });
});

describe('a guest is reached by SMS', () => {
  const GUEST = { isGuest: true, email: 'guest_7@guest.smart-depannage.local', phone: '55111222' };

  it('the reminder asks for the SMS, and not for the e-mail nor the push', async () => {
    const d = desk({ client: GUEST });

    d.addReminder();
    await sendAt(d.service);

    expect(d.told[0].channels).toContain('SMS');
    expect(d.told[0].channels).not.toContain('EMAIL');
    expect(d.told[0].channels).not.toContain('PUSH');
  });

  it('on the real notification service: the text leaves by SMS to the guest\'s number, and no e-mail is queued', async () => {
    const d = desk({ client: GUEST });

    d.addReminder();
    await sendAt(d.real());

    expect(d.queued).toHaveLength(1);
    expect(d.queued[0].channel).toBe('SMS');
    expect(d.queued[0].recipient).toBe('55111222');
    expect(d.queued[0].body).toBe(reminderMessage(120, d.visit.startsAt, 'Africa/Tunis'));

    const row = d.world.memory.rows('notification')[0];

    expect(row.type).toBe('APPOINTMENT_REMINDER');
    expect(d.reminders()[0].status).toBe('SENT');
  });

  it('a guest with no phone number cannot be reached: the reminder says so instead of "sent"', async () => {
    const d = desk({ client: { ...GUEST, phone: null } });

    d.addReminder();
    await sendAt(d.real());

    expect(d.queued).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
    expect(d.reminders()[0].error).toContain('phone');
  });

  it('a person with no phone number is reached all the same: the app, the push and the e-mail do not need one', async () => {
    const d = desk({ client: { phone: null } });

    d.addReminder();
    await sendAt(d.real());

    expect(d.queued.map((message) => message.channel).sort()).toEqual(['EMAIL', 'PUSH']);
    expect(d.reminders()[0].status).toBe('SENT');
  });

  it('a person with the app, on the real service: a push that opens the job, and an e-mail; no SMS', async () => {
    const d = desk();

    d.addReminder();
    await sendAt(d.real());

    expect(d.queued.map((message) => message.channel).sort()).toEqual(['EMAIL', 'PUSH']);

    const push = d.queued.find((message) => message.channel === 'PUSH');

    expect(push.data.type).toBe('APPOINTMENT_REMINDER');
    expect(push.data.interventionId).toBe(d.job.id);
    expect(d.world.memory.rows('notification')[0].type).toBe('APPOINTMENT_REMINDER');
  });
});

describe('a reminder and a cancellation that cross (P3-01)', () => {
  /** A notification service that, while it sends the first reminder, lets something happen to the visit. */
  const crossing = (d: Desk, during: () => Promise<void> | void) => {
    let calls = 0;
    const notifications: any = {
      notify: async (payload: any) => {
        calls += 1;
        d.told.push(payload);

        if (calls === 1) await during();

        return { id: calls };
      },
    };

    return new SchedulingService(d.world.prisma, d.world.svc.assignment, notifications);
  };

  it('the visit is cancelled and its reminders deleted while the first one is sent: the second is not sent, and the run goes on without a failure', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-3) });
    d.addReminder({ recipientId: d.artisan.id, dueAt: soon(-2) });

    const service = crossing(d, () => {
      d.world.memory.rows('appointment')[0].status = 'CANCELLED';

      const rows = d.world.memory.rows('appointmentReminder');

      for (let at = rows.length - 1; at >= 0; at -= 1) if (rows[at].status === 'PENDING') rows.splice(at, 1);
    });

    await sendAt(service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT']);
  });

  it('the visit is cancelled (its reminders left behind) while the first one is sent: the second is skipped, with the reason', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-3) });
    d.addReminder({ recipientId: d.artisan.id, dueAt: soon(-2) });

    const service = crossing(d, () => {
      d.world.memory.rows('appointment')[0].status = 'CANCELLED';
    });

    await sendAt(service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'SKIPPED']);
    expect(d.reminders()[1].error).toContain('cancelled');
  });

  it('the job is cancelled while the first one is sent: the second is skipped', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-3) });
    d.addReminder({ recipientId: d.artisan.id, dueAt: soon(-2) });

    const service = crossing(d, () => {
      d.world.memory.rows('intervention')[0].status = 'CANCELLED';
    });

    await sendAt(service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'SKIPPED']);
  });

  it('the visit is moved while the first one is sent (its reminders are dropped to be made again): the old second one is not sent', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-3) });
    d.addReminder({ recipientId: d.artisan.id, dueAt: soon(-2) });

    const service = crossing(d, () => {
      // the visit stands; only the reminders not sent yet go
      const rows = d.world.memory.rows('appointmentReminder');

      for (let at = rows.length - 1; at >= 0; at -= 1) if (rows[at].status === 'PENDING') rows.splice(at, 1);
    });

    await sendAt(service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT']);
  });

  it('a reminder that another run took while the first was sent is not sent again, and what that run wrote is left as it is', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-3) });
    d.addReminder({ recipientId: d.artisan.id, dueAt: soon(-2) });

    const mark = new Date('2099-10-19T04:00:00.000Z');
    const service = crossing(d, () => {
      Object.assign(d.world.memory.rows('appointmentReminder')[1], { status: 'SENT', sentAt: mark });
    });

    await sendAt(service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'SENT']);
    expect(d.reminders()[1].sentAt).toEqual(mark);
  });

  it('two runs at the same time do not send a reminder twice: the one that is being sent is already taken', async () => {
    const d = desk();
    let again: Promise<void> | null = null;
    const holder: { service: SchedulingService | null } = { service: null };

    d.addReminder();

    holder.service = crossing(d, async () => {
      // The second run starts while the first reminder is being sent.
      again = (holder.service as SchedulingService).sendDueReminders();
      await again;
    });

    await sendAt(holder.service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT']);
  });

  it('a reminder whose recipient does not exist any more is skipped with the reason, not sent and not failed', async () => {
    const d = desk();

    d.addReminder();
    d.world.memory.rows('user').splice(d.world.memory.rows('user').findIndex((user: any) => user.id === d.client.id), 1);
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
    expect(d.reminders()[0].error).toContain('recipient does not exist');
  });

  it('a reminder whose visit has been deleted is skipped, not sent', async () => {
    const d = desk();

    d.addReminder();
    d.world.memory.rows('appointment').splice(0, 1);
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });
});

describe('a reminder is sent for the visit as it stands (P3-01)', () => {
  it('a visit moved to a later day: the reminder made for the old time waits for its real hour instead of saying "24 heures" about a visit days away', async () => {
    const d = desk({ visit: { startsAt: soon(120), endsAt: soon(122) } });

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-1) });
    await sendAt(d.service);

    const startsAt = d.world.memory.rows('appointment')[0].startsAt as Date;

    expect(d.told).toHaveLength(0);
    expect(d.reminders()).toHaveLength(1);
    expect(d.reminders()[0].status).toBe('PENDING');
    expect(d.reminders()[0].dueAt).toEqual(new Date(startsAt.getTime() - 1440 * 60000));
  });

  it('a visit moved to an earlier time: the reminder goes out, with the time that is really left', async () => {
    const d = desk({ visit: { startsAt: soon(3), endsAt: soon(5) } });

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-1) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.told[0].message).toContain('dans 3 heures');
  });

  it('after an outage the reminders of a day and of two hours before are due together: the person is told once, by the closest; another person has their own', async () => {
    const d = desk({ visit: { startsAt: soon(2), endsAt: soon(4) } });

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-22) });
    d.addReminder({ minutesBefore: 120, dueAt: soon(0) });
    d.addReminder({ recipientId: d.artisan.id, minutesBefore: 120, dueAt: soon(0) });
    await sendAt(d.service);

    expect(d.told.map((payload) => [payload.recipientId, payload.message.includes('dans 2 heures')])).toEqual([
      [d.client.id, true],
      [d.artisan.id, true],
    ]);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SKIPPED', 'SENT', 'SENT']);
    expect(d.reminders()[0].error).toContain('closer reminder');
  });

  it('a visit moved a few hours later: the day-before reminder that is really due goes out, and the two-hour one waits for its hour (the first is not skipped for a closer reminder that is not due)', async () => {
    const d = desk({ visit: { startsAt: soon(23), endsAt: soon(25) } });

    // both were made for the old time and read as due; for the new time only the day before is
    d.addReminder({ minutesBefore: 1440, dueAt: soon(-3) });
    d.addReminder({ minutesBefore: 120, dueAt: soon(-1) });
    await sendAt(d.service);

    const startsAt = d.world.memory.rows('appointment')[0].startsAt as Date;

    expect(d.told).toHaveLength(1);
    expect(d.told[0].message).toContain('dans 23 heures');
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'PENDING']);
    expect(d.reminders()[1].dueAt).toEqual(new Date(startsAt.getTime() - 120 * 60000));
  });

  it('a closer reminder that waits for a later hour does not make the first one skip: the person is told by the first, not by nobody', async () => {
    const d = desk({ visit: { startsAt: soon(1), endsAt: soon(3) } });

    // made for a later time of the visit (a replacement that did not happen): the two-hour one is not due for 17 hours
    d.addReminder({ minutesBefore: 1440, dueAt: soon(-5) });
    d.addReminder({ minutesBefore: 120, dueAt: soon(17) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'PENDING']);
  });

  it('the closer reminder of somebody else does not make a person\'s reminder skip: each is told by their own', async () => {
    const d = desk({ visit: { startsAt: soon(2), endsAt: soon(4) } });

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-22) });
    d.addReminder({ recipientId: d.artisan.id, minutesBefore: 120, dueAt: soon(0) });
    await sendAt(d.service);

    expect(d.told.map((payload) => payload.recipientId).sort()).toEqual([d.client.id, d.artisan.id].sort());
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'SENT']);
  });

  it('a closer reminder that went out after this one was made counts: a reminder tried again after a failed read is not sent after the closer one', async () => {
    const d = desk({ visit: { startsAt: soon(2), endsAt: soon(4) } });

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-1), createdAt: soon(-30) });
    d.addReminder({ minutesBefore: 120, dueAt: soon(-0.5), status: 'SENT', sentAt: soon(-0.5), createdAt: soon(-30) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
    expect(d.reminders()[0].error).toContain('closer reminder');
  });

  it('a closer reminder that went out for an earlier schedule of the visit does not count: the new day-before reminder is sent', async () => {
    const d = desk({ visit: { startsAt: soon(23), endsAt: soon(25) } });

    // the visit was moved: the two-hour reminder of the old schedule went out long before the new ones were made
    d.addReminder({ minutesBefore: 120, dueAt: soon(-100), status: 'SENT', sentAt: soon(-100), createdAt: soon(-110) });
    d.addReminder({ minutesBefore: 1440, dueAt: soon(-1), createdAt: soon(-20) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.told[0].message).toContain('dans 23 heures');
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SENT', 'SENT']);
  });

  it('the pair that is due together is told once even when a batch of 50 ends between them: the closer reminder is looked up on the visit, not in the batch', async () => {
    const d = desk({ visit: { startsAt: soon(2), endsAt: soon(4) } });
    const model: any = d.world.prisma.appointmentReminder;
    const original = model.findMany.bind(model);

    d.addReminder({ minutesBefore: 1440, dueAt: soon(-22) });
    d.addReminder({ minutesBefore: 120, dueAt: soon(0) });

    // the batch of the first run holds only the day-before reminder
    let batches = 0;

    model.findMany = async (args: any) => {
      const rows = await original(args);

      return args.take === 50 && (batches += 1) === 1 ? rows.filter((row: any) => row.minutesBefore === 1440) : rows;
    };

    await sendAt(d.service);
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.told[0].message).toContain('dans 2 heures');
    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['SKIPPED', 'SENT']);
  });

  it('the reminder is read, decided and taken under the lock of the job: a cancellation that is being written is waited for, and nothing goes out for the visit it cancels', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-1) });

    let release!: () => void;
    let locked!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const cancelling = d.world.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, d.job.id);
      locked();
      await open;
      // the cancellation writes the visit, then drops the reminders not sent yet
      await tx.appointment.update({ where: { id: d.visit.id }, data: { status: 'CANCELLED' } });
      await tx.appointmentReminder.deleteMany({ where: { appointmentId: d.visit.id, status: 'PENDING' } });
    });

    await taken;

    const sending = sendAt(d.service);

    await new Promise((resolve) => setTimeout(resolve, 25));

    // the sender is waiting for the lock: it has neither sent nor taken the reminder
    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('PENDING');

    release();
    await cancelling;
    await sending;

    expect(d.told).toHaveLength(0);
    expect(d.reminders()).toHaveLength(0);
  });

  it('nothing is sent from inside the transaction: a failure to send does not undo the claim, it is written as a failure', async () => {
    const d = desk();
    const failing: any = {
      notify: async () => {
        throw new Error('the push service is down');
      },
    };

    d.addReminder({ dueAt: soon(-1) });
    await new SchedulingService(d.world.prisma, d.world.svc.assignment, failing).sendDueReminders();

    expect(d.reminders()[0].status).toBe('FAILED');
    expect(d.reminders()[0].error).toContain('push service is down');
  });

  it('a read that fails before anything is taken is tried again later, not marked as failed; the reason is written meanwhile', async () => {
    const d = desk();

    d.addReminder({ dueAt: soon(-1) });
    (d.world.memory as any).failNext('appointment', 'findUnique', new Error('the database blinked'));
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('PENDING');
    expect(d.reminders()[0].error).toContain('blinked');
    expect((d.reminders()[0].dueAt as Date).getTime()).toBeGreaterThan(Date.now());

    // not due before the delay is over
    await sendAt(d.service);
    expect(d.told).toHaveLength(0);

    // the delay is over: it goes out
    d.reminders()[0].dueAt = soon(-1);
    await sendAt(d.service);

    expect(d.told).toHaveLength(1);
    expect(d.reminders()[0].status).toBe('SENT');
  });

  it('a reminder that keeps failing to be read goes on being tried until the visit has started, then it is skipped', async () => {
    const d = desk({ visit: { startsAt: soon(-1), endsAt: soon(1) } });

    d.addReminder({ dueAt: soon(-3) });
    await sendAt(d.service);

    expect(d.told).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
    expect(d.reminders()[0].error).toContain('started');
  });
});

describe('a reminder that cannot be delivered', () => {
  it('a guest who turned the SMS off cannot be reached: the copy in the app is no reminder, so it is skipped, not "sent"', async () => {
    const d = desk({ client: { isGuest: true, email: 'guest_7@guest.smart-depannage.local', phone: '55111222' } });

    d.world.memory.plant('notificationPreference', { userId: d.client.id, smsEnabled: false });
    d.addReminder();
    await sendAt(d.real());

    expect(d.queued).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
    expect(d.reminders()[0].error).toContain('SMS');
    expect(d.reminders()[0].sentAt).toBeNull();
  });

  it('nobody was written to (the person is deactivated): skipped, not "sent"', async () => {
    const d = desk({ client: { isActive: false } });

    d.addReminder();
    await sendAt(d.real());

    expect(d.queued).toHaveLength(0);
    expect(d.reminders()[0].status).toBe('SKIPPED');
  });

  it('a failure is written on that reminder, and the next one still goes', async () => {
    const d = desk();
    let calls = 0;
    const flaky: any = {
      notify: async (payload: any) => {
        calls += 1;

        if (calls === 1) throw new Error('the push service is down');

        d.told.push(payload);

        return { id: calls };
      },
    };
    const service = new SchedulingService(d.world.prisma, d.world.svc.assignment, flaky);

    d.addReminder({ dueAt: soon(-5) });
    d.addReminder();
    await sendAt(service);

    expect(d.reminders().map((reminder) => reminder.status)).toEqual(['FAILED', 'SENT']);
    expect(d.reminders()[0].error).toContain('push service');
  });
});
