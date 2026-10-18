import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

/** POST /admin/interventions/:id/assign-artisan: the one assignment path (P1-05). */

function makeService(assignImpl?: (input: any) => Promise<any>) {
  const calls: any[] = [];
  const assignment: any = {
    assign:
      assignImpl ??
      (async (input: any) => {
        calls.push(input);
        return { intervention: { id: input.interventionId, status: 'ASSIGNED' }, appointment: null };
      }),
  };

  return { service: new AdminService({} as any, {} as any, {} as any, {} as any, assignment, {} as any), calls };
}

describe('AdminService.assignArtisan', () => {
  it('hands the artisan, the optional time and the note to the assignment, as the admin who asked', async () => {
    const w = makeService();

    await w.service.assignArtisan(3, 8, {
      artisanId: 41,
      startsAt: '2026-10-19T08:00:00.000Z',
      endsAt: '2026-10-19T09:00:00.000Z',
      adminNote: 'Code 1234',
    } as any);

    expect(w.calls.length).toBe(1);
    expect(w.calls[0].interventionId).toBe(8);
    expect(w.calls[0].artisanId).toBe(41);
    expect(w.calls[0].actorId).toBe(3);
    expect(w.calls[0].startsAt).toBe('2026-10-19T08:00:00.000Z');
    expect(w.calls[0].endsAt).toBe('2026-10-19T09:00:00.000Z');
    expect(w.calls[0].adminNote).toBe('Code 1234');
  });

  it('without a time it asks for none (the job keeps the appointment it has, if any)', async () => {
    const w = makeService();

    await w.service.assignArtisan(3, 8, { artisanId: 41 } as any);

    expect(w.calls[0].startsAt).toBe(undefined);
    expect(w.calls[0].endsAt).toBe(undefined);
  });

  it('answers with the intervention, with the relations the dashboard shows', async () => {
    const w = makeService();

    const result: any = await w.service.assignArtisan(3, 8, { artisanId: 41 } as any);

    expect(result).toEqual({ id: 8, status: 'ASSIGNED' });
    expect(w.calls[0].include).toBeTruthy();
  });

  it('what the assignment refuses comes back as it is', async () => {
    const refusal = new BadRequestException('Cet artisan n’est pas encore approuvé.');
    const w = makeService(async () => {
      throw refusal;
    });

    let error: any;
    try {
      await w.service.assignArtisan(3, 8, { artisanId: 41 } as any);
    } catch (e) {
      error = e;
    }

    expect(error).toBe(refusal);
  });
});
