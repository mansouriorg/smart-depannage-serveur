import { BadRequestException } from '@nestjs/common';
import { emptyWorld } from '../../common/testing/world';
import { CANCEL_BY_STATUS } from './cancel-by-status';

/**
 * A job is cancelled with the cancellation, not with a status (P3-01): a status written on its own left the technician's visit booked
 * (it blocked the calendar for good, in the code and in the database), its reminders waiting, and nobody told about the money.
 */

function desk(status = 'ASSIGNED') {
  const world = emptyWorld();
  const m = world.memory;
  const admin = m.plant('user', { role: 'ADMIN', name: 'Admin' });
  const dispatcher = m.plant('user', { role: 'DISPATCHER', name: 'Dispatcheur' });
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma' });
  const artisan = m.plant('user', { role: 'ARTISAN', name: 'Karim' });
  const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status, serviceType: 'PLOMBIER' });
  const visit = m.plant('appointment', {
    interventionId: job.id,
    clientId: client.id,
    artisanId: artisan.id,
    status: 'SCHEDULED',
    startsAt: new Date(Date.UTC(2099, 9, 25, 8)),
    endsAt: new Date(Date.UTC(2099, 9, 25, 10)),
  });

  return {
    world,
    admin,
    dispatcher,
    client,
    job,
    visit,
    jobRow: () => m.rows('intervention').find((row: any) => row.id === job.id),
    visitRow: () => m.rows('appointment').find((row: any) => row.id === visit.id),
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

describe('the refusal says what to do instead (P3-01)', () => {
  it('it points to the cancellation, which asks for a reason and frees the technician’s hour', () => {
    expect(CANCEL_BY_STATUS).toContain('utilisez l’annulation');
    expect(CANCEL_BY_STATUS).toContain('elle demande un motif');
    expect(CANCEL_BY_STATUS).toContain('libère le rendez-vous de l’artisan');
  });
});

describe('the workflow status route does not cancel a job (P3-01)', () => {
  it.each(['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'WAITING_ADMIN_REVIEW'])('a job that is %s: 400, the job and its visit are as they were', async (status) => {
    const d = desk(status);

    for (const who of [d.admin, d.dispatcher]) {
      const error = await failure(() => d.world.svc.workflow.changeStatus({ id: who.id, role: who.role }, d.job.id, { status: 'CANCELLED' } as any));

      expect(error instanceof BadRequestException).toBe(true);
      expect(error.message).toBe(CANCEL_BY_STATUS);
    }

    expect(d.jobRow().status).toBe(status);
    expect(d.visitRow().status).toBe('SCHEDULED');
  });

  it('saying "cancelled" of a job that is cancelled already is let through and changes nothing', async () => {
    const d = desk('CANCELLED');

    await d.world.svc.workflow.changeStatus({ id: d.admin.id, role: d.admin.role }, d.job.id, { status: 'CANCELLED' } as any);

    expect(d.jobRow().status).toBe('CANCELLED');
  });

  it('the other moves of the back office still go through', async () => {
    const d = desk('ASSIGNED');

    await d.world.svc.workflow.changeStatus({ id: d.admin.id, role: d.admin.role }, d.job.id, { status: 'ARTISAN_ACCEPTED' } as any);

    expect(d.jobRow().status).toBe('ARTISAN_ACCEPTED');
  });

  it('the statuses offered to the back office do not include the cancellation, the ones offered to the customer still do', async () => {
    const early = desk('PENDING');
    const staff = await early.world.svc.workflow.getNextStatuses({ id: early.admin.id, role: early.admin.role }, early.job.id);
    const customer = await early.world.svc.workflow.getNextStatuses({ id: early.client.id, role: early.client.role }, early.job.id);

    expect(staff.allowedNextStatuses.length).toBeGreaterThan(0);
    expect(staff.allowedNextStatuses).not.toContain('CANCELLED');
    expect(customer.allowedNextStatuses).toContain('CANCELLED');
  });
});
