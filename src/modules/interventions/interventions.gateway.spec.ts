import { leakedTo, poisonedJob } from '../../common/testing/poison';
import { InterventionsGateway } from './interventions.gateway';

/**
 * P1-08: the older socket sends the staff the row, and the customer and the artisan of the job each a
 * copy of their own.
 */
function setup() {
  const sent: Array<{ room: string; event: string; payload: any }> = [];
  const gateway: any = new InterventionsGateway({} as any, {} as any);

  gateway.server = {
    to: (room: string) => ({ emit: (event: string, payload: any) => sent.push({ room, event, payload }) }),
  };

  return { gateway: gateway as InterventionsGateway, sent };
}

describe('the status change on the older socket (P1-08)', () => {
  it('the staff get the row; the customer and the artisan a copy of their own', () => {
    const { gateway, sent } = setup();

    gateway.sendInterventionStatus(poisonedJob() as any);

    const staff = sent.find((emit) => emit.room === 'staff')!;
    const client = sent.find((emit) => emit.room === 'user:10')!;
    const artisan = sent.find((emit) => emit.room === 'user:20')!;

    expect(staff.payload.adminInternalNotes).toBe('SECRET<job.adminInternalNotes>');
    expect(leakedTo(client.payload, 'client')).toEqual([]);
    expect(leakedTo(artisan.payload, 'artisan')).toEqual([]);
    expect(client.payload.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    expect(artisan.payload.client.phone).toBe('+21620000000');
    expect(sent.map((emit) => emit.event)).toEqual(['interventionStatus-1', 'interventionStatus-1', 'interventionStatus-1']);
  });

  it('a job with no artisan: nothing for an artisan room', () => {
    const { gateway, sent } = setup();

    gateway.sendInterventionStatus({ ...poisonedJob(), artisanId: null } as any);

    expect(sent.map((emit) => emit.room)).toEqual(['staff', 'user:10']);
  });
});
