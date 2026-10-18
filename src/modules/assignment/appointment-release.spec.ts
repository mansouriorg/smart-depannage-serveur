import { AppointmentStatus } from '../../../generated/prisma/client';
import { cancelVisit } from './appointment-release';

/** The job is cancelled, so its visit is too (P1-13). */

function fakeDb(visit: any) {
  const log: Array<{ table: string; op: string; args: any }> = [];
  const record = (table: string, op: string, result?: any) => async (args: any) => {
    log.push({ table, op, args });
    return result;
  };

  const db: any = {
    appointment: {
      findUnique: record('appointment', 'findUnique', visit),
      update: record('appointment', 'update', {}),
    },
    appointmentRequest: { updateMany: record('appointmentRequest', 'updateMany', { count: 1 }) },
    appointmentReminder: {
      deleteMany: record('appointmentReminder', 'deleteMany', {}),
      createMany: record('appointmentReminder', 'createMany', {}),
    },
  };

  const writes = () => log.filter((entry) => entry.op !== 'findUnique');

  return { db, log, writes };
}

const scheduled = { id: 5, interventionId: 12, status: AppointmentStatus.SCHEDULED, clientId: 3, artisanId: 7 };

describe('cancelVisit', () => {
  it('cancels the visit with the reason, closes the requests waiting about it, and drops the reminders', async () => {
    const w = fakeDb(scheduled);

    const result = await cancelVisit(w.db, 12, 'Le client a trouvé une autre solution.', 99);

    expect(result).toBe(scheduled);
    expect(w.log[0].args.where).toEqual({ interventionId: 12 });

    const update = w.log.find((entry) => entry.table === 'appointment' && entry.op === 'update')!;

    expect(update.args.where).toEqual({ id: 5 });
    expect(update.args.data.status).toBe(AppointmentStatus.CANCELLED);
    expect(update.args.data.cancelReason).toBe('Le client a trouvé une autre solution.');
    expect(update.args.data.cancelledAt instanceof Date).toBe(true);

    const requests = w.log.find((entry) => entry.table === 'appointmentRequest')!;

    expect(requests.args.where.appointmentId).toBe(5);
    expect(requests.args.data.reviewedById).toBe(99);

    const dropped = w.log.find((entry) => entry.table === 'appointmentReminder' && entry.op === 'deleteMany')!;

    expect(dropped.args.where.appointmentId).toBe(5);
  });

  it('makes no new reminder for a visit that will not happen', async () => {
    const w = fakeDb(scheduled);

    await cancelVisit(w.db, 12, 'x');

    expect(w.log.filter((entry) => entry.op === 'createMany').length).toBe(0);
  });

  it('the artisan keeps the visit on record (the cancelled visit still names who had it)', async () => {
    const w = fakeDb(scheduled);

    await cancelVisit(w.db, 12, 'x');

    const update = w.log.find((entry) => entry.table === 'appointment' && entry.op === 'update')!;

    expect('artisanId' in update.args.data).toBe(false);
  });

  it('a visit whose cancellation or new time was asked for is cancelled too', async () => {
    for (const status of [AppointmentStatus.CANCEL_REQUESTED, AppointmentStatus.RESCHEDULE_REQUESTED, AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED]) {
      const w = fakeDb({ ...scheduled, status });

      expect(await cancelVisit(w.db, 12, 'x')).not.toBeNull();
      expect(w.writes().length).toBe(3);
    }
  });

  it('a job with no visit: nothing is written', async () => {
    const w = fakeDb(null);

    expect(await cancelVisit(w.db, 12, 'x')).toBeNull();
    expect(w.writes().length).toBe(0);
  });

  it('a visit that is over or already cancelled is left alone', async () => {
    for (const status of [AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW]) {
      const w = fakeDb({ ...scheduled, status });

      expect(await cancelVisit(w.db, 12, 'x')).toBeNull();
      expect(w.writes().length).toBe(0);
    }
  });

  it('without the person who cancelled, the requests are closed all the same', async () => {
    const w = fakeDb(scheduled);

    await cancelVisit(w.db, 12, 'x');

    const requests = w.log.find((entry) => entry.table === 'appointmentRequest')!;

    expect('reviewedById' in requests.args.data).toBe(false);
  });
});
