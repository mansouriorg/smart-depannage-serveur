import { resetLocale } from '../../common/locale/locale';
import { emptyWorld } from '../../common/testing/world';
import { lockJob } from '../assignment/artisan-lock';

/**
 * The customer cancels the job (P3-01): its visit goes with it. A visit left standing on a cancelled job kept the artisan's hour
 * taken (the code check and the database constraint both count it), and only the job check kept its reminders from going out.
 */

const at = (hour: number, day = 25) => new Date(Date.UTC(2099, 9, day, hour));

function desk(options: { jobStatus?: string; visit?: Record<string, any> | null } = {}) {
  resetLocale();

  const world = emptyWorld();
  const m = world.memory;
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma' });
  const other = m.plant('user', { role: 'CLIENT', name: 'Autre' });
  const artisan = m.plant('user', { role: 'ARTISAN', name: 'Karim' });
  const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.jobStatus ?? 'ASSIGNED', serviceType: 'PLOMBIER' });
  const visit =
    options.visit === null
      ? null
      : m.plant('appointment', { interventionId: job.id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: at(8), endsAt: at(10), ...(options.visit ?? {}) });

  if (visit) {
    m.plant('appointmentRequest', { appointmentId: visit.id, requestedById: client.id, type: 'RESCHEDULE', status: 'PENDING', requestedStartAt: at(14), requestedEndAt: at(15), previousStatus: 'SCHEDULED' });
    m.plant('appointmentReminder', { appointmentId: visit.id, recipientId: client.id, minutesBefore: 1440, dueAt: at(1, 24), status: 'PENDING' });
    m.plant('appointmentReminder', { appointmentId: visit.id, recipientId: artisan.id, minutesBefore: 120, dueAt: at(6), status: 'PENDING' });
    m.plant('appointmentReminder', { appointmentId: visit.id, recipientId: client.id, minutesBefore: 2880, dueAt: at(1, 23), status: 'SENT', sentAt: at(1, 23) });
  }

  return {
    world,
    client,
    other,
    job,
    visit,
    jobRow: () => m.rows('intervention').find((row: any) => row.id === job.id),
    visitRow: () => m.rows('appointment').find((row: any) => row.interventionId === job.id),
  };
}

async function failure(work: () => Promise<unknown>): Promise<any> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the customer cancels a job that has a visit (P3-01)', () => {
  it('the visit is cancelled with the job: the hour is free, the requests are closed, the reminders not sent are dropped', async () => {
    const d = desk();

    await d.world.svc.clientInterventions.cancel(d.client.id, d.job.id);

    const m = d.world.memory;

    expect(d.jobRow().status).toBe('CANCELLED');
    expect(d.visitRow().status).toBe('CANCELLED');
    expect(d.visitRow().cancelReason).toContain('annulée par le client');
    expect(d.visitRow().cancelledAt).toBeInstanceOf(Date);
    expect(m.rows('appointmentRequest').map((row: any) => row.status)).toEqual(['CANCELLED']);
    expect(m.rows('appointmentReminder').map((row: any) => row.status)).toEqual(['SENT']);
  });

  it('the cancellation waits for the lock of the job: a request about the visit that is being written finishes first, and is then closed with the rest', async () => {
    const d = desk();
    let release!: () => void;
    let locked!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const asking = d.world.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, d.job.id);
      locked();
      await open;
      // a second request about the visit, written while the lock is held
      await tx.appointmentRequest.create({ data: { appointmentId: d.visit.id, requestedById: d.client.id, type: 'CANCEL', status: 'PENDING', previousStatus: 'SCHEDULED' } });
      await tx.appointment.update({ where: { id: d.visit.id }, data: { status: 'CANCEL_REQUESTED' } });
    });

    await taken;

    const cancelling = d.world.svc.clientInterventions.cancel(d.client.id, d.job.id);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(d.jobRow().status).toBe('ASSIGNED');

    release();
    await asking;
    await cancelling;

    expect(d.jobRow().status).toBe('CANCELLED');
    expect(d.visitRow().status).toBe('CANCELLED');
    expect(d.world.memory.rows('appointmentRequest').map((row: any) => row.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('a job with no visit is cancelled all the same', async () => {
    const d = desk({ visit: null });

    await d.world.svc.clientInterventions.cancel(d.client.id, d.job.id);

    expect(d.jobRow().status).toBe('CANCELLED');
    expect(d.world.memory.rows('appointment')).toHaveLength(0);
  });

  it('a visit that took place is left as it is', async () => {
    const d = desk({ visit: { status: 'COMPLETED' } });

    await d.world.svc.clientInterventions.cancel(d.client.id, d.job.id);

    expect(d.jobRow().status).toBe('CANCELLED');
    expect(d.visitRow().status).toBe('COMPLETED');
  });

  it('a job cancelled before this rule whose visit still stands: cancelling again frees the visit, with its requests and reminders, and writes no second event (P3-01)', async () => {
    const d = desk({ jobStatus: 'CANCELLED' });

    await d.world.svc.clientInterventions.cancel(d.client.id, d.job.id);

    const m = d.world.memory;

    expect(d.jobRow().status).toBe('CANCELLED');
    expect(d.visitRow().status).toBe('CANCELLED');
    expect(m.rows('appointmentRequest').map((row: any) => row.status)).toEqual(['CANCELLED']);
    expect(m.rows('appointmentReminder').map((row: any) => row.status)).toEqual(['SENT']);
    expect(m.rows('interventionEvent').filter((row: any) => row.type === 'CANCELLED')).toHaveLength(0);
  });

  it('another customer cannot cancel it: nothing changes', async () => {
    const d = desk();
    const error = await failure(() => d.world.svc.clientInterventions.cancel(d.other.id, d.job.id));

    expect(error.getStatus()).toBe(403);
    expect(d.jobRow().status).toBe('ASSIGNED');
    expect(d.visitRow().status).toBe('SCHEDULED');
  });

  it('a job that has started cannot be cancelled by the customer: the visit stands', async () => {
    const d = desk({ jobStatus: 'IN_PROGRESS' });
    const error = await failure(() => d.world.svc.clientInterventions.cancel(d.client.id, d.job.id));

    expect(error.getStatus()).toBeGreaterThanOrEqual(400);
    expect(d.jobRow().status).toBe('IN_PROGRESS');
    expect(d.visitRow().status).toBe('SCHEDULED');
  });

  it('the job and the visit go together: a failure on the visit leaves the job as it was', async () => {
    const d = desk();

    (d.world.memory as any).failNext('appointment', 'update', new Error('the database dropped the connection'));

    const error = await failure(() => d.world.svc.clientInterventions.cancel(d.client.id, d.job.id));

    expect(error.message).toContain('dropped');
    expect(d.jobRow().status).toBe('ASSIGNED');
    expect(d.visitRow().status).toBe('SCHEDULED');
  });
});
