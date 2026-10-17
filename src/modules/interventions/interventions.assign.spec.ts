import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InterventionsService } from './interventions.service';

/**
 * PATCH /interventions/:id is what the dropdown of the dashboard calls. Giving the
 * job to an artisan there used to write the artisan and the status ACCEPTED without
 * looking at the artisan (P1-05); now it is the one assignment path, or it is refused.
 */

function makeWorld(assignResult?: () => Promise<any>) {
  const assigned: any[] = [];
  const sockets: any[] = [];
  const sms: any[] = [];
  const row: any = {
    id: 8,
    status: 'WAITING_ADMIN_REVIEW',
    artisanId: null,
    clientId: 2,
    client: { id: 2, name: 'Client', phone: '+21620000000' },
  };
  const writes: string[] = [];

  const prisma: any = {
    intervention: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }: any) => {
        writes.push('update');
        return Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), {
          client: row.client,
          artisan: null,
        });
      },
      updateMany: async ({ data }: any) => {
        writes.push('updateMany');
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
        return { count: 1 };
      },
    },
  };
  const gateway: any = { sendInterventionStatus: (payload: any) => sockets.push(payload) };
  const notifications: any = { sendSms: async (...args: any[]) => sms.push(args) };
  const assignment: any = {
    assign:
      assignResult ??
      (async (input: any) => {
        assigned.push(input);
        return { intervention: { id: input.interventionId, status: 'ASSIGNED', artisanId: input.artisanId } };
      }),
  };

  return {
    service: new InterventionsService(prisma, gateway, notifications, {} as any, assignment),
    assigned,
    sockets,
    sms,
    writes,
    row,
  };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('InterventionsService.update with an artisan (P1-05)', () => {
  const staff = { kind: 'staff', userId: 5 } as const;

  it('hands the job to the assignment path, as the staff member who asked', async () => {
    const w = makeWorld();

    const result = await w.service.update(8, { artisanId: 41 } as any, staff);

    expect(w.assigned.length).toBe(1);
    expect(w.assigned[0].interventionId).toBe(8);
    expect(w.assigned[0].artisanId).toBe(41);
    expect(w.assigned[0].actorId).toBe(5);
    expect(result.status).toBe('ASSIGNED');
  });

  it('writes nothing itself and sends no text message: the assignment tells the people', async () => {
    const w = makeWorld();

    await w.service.update(8, { artisanId: 41 } as any, staff);

    expect(w.writes).toEqual([]);
    expect(w.sms).toEqual([]);
  });

  it('tells the dashboards, with what the assignment returned', async () => {
    const w = makeWorld();

    await w.service.update(8, { artisanId: 41 } as any, staff);

    expect(w.sockets.length).toBe(1);
    expect(w.sockets[0].status).toBe('ASSIGNED');
  });

  it('asks for the same columns the old answer had: client and artisan names and phones', async () => {
    const w = makeWorld();

    await w.service.update(8, { artisanId: 41 } as any, staff);

    expect(w.assigned[0].include).toEqual({
      client: { select: { id: true, name: true, phone: true } },
      artisan: { select: { id: true, name: true, phone: true } },
    });
  });

  it('what the assignment refuses (unapproved, busy, wrong status) comes back as is, nothing is told to anybody', async () => {
    const refusal = new BadRequestException('Cet artisan n’est pas encore approuvé.');
    const w = makeWorld(async () => {
      throw refusal;
    });

    const error = await failure(w.service.update(8, { artisanId: 41 } as any, staff));

    expect(error).toBe(refusal);
    expect(w.sockets).toEqual([]);
    expect(w.sms).toEqual([]);
  });

  it('a job in the wrong status stays a 409', async () => {
    const w = makeWorld(async () => {
      throw new ConflictException('Transition impossible.');
    });

    const error = await failure(w.service.update(8, { artisanId: 41 } as any, staff));

    expect(error.getStatus()).toBe(409);
  });

  it('without a status the job lands on "accepted", as the dropdown always did: what the mobile app and the dashboard show as "affecté"', async () => {
    const w = makeWorld();

    await w.service.update(8, { artisanId: 41 } as any, staff);

    expect(w.assigned[0].status).toBe('ARTISAN_ACCEPTED');
  });

  it('"assigned" and "accepted" may be asked for, in either spelling; any other status is a 400 and nothing is assigned', async () => {
    const w = makeWorld();

    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARTISAN_ON_THE_WAY', 'DISPUTED', 'NOT_A_STATUS']) {
      const error = await failure(w.service.update(8, { artisanId: 41, status } as any, staff));

      expect(error instanceof BadRequestException).toBe(true);
    }

    expect(w.assigned).toEqual([]);

    for (const [status, landing] of [
      ['ASSIGNED', 'ASSIGNED'],
      ['ACCEPTED', 'ARTISAN_ACCEPTED'],
      ['ARTISAN_ACCEPTED', 'ARTISAN_ACCEPTED'],
    ]) {
      const before = w.assigned.length;
      await w.service.update(8, { artisanId: 41, status } as any, staff);

      expect(w.assigned.length).toBe(before + 1);
      expect(w.assigned[before].status).toBe(landing);
    }
  });

  it('nothing else rides along with the artisan', async () => {
    const w = makeWorld();

    const error = await failure(w.service.update(8, { artisanId: 41, address: 'ailleurs', afterPhotoUrl: 'x' } as any, staff));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.assigned).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  it('fields that are present but undefined do not count as "something else"', async () => {
    const w = makeWorld();

    await w.service.update(8, { artisanId: 41, address: undefined, status: undefined } as any, staff);

    expect(w.assigned.length).toBe(1);
  });

  it('only a staff member with an account can assign: not an artisan, not nobody', async () => {
    const w = makeWorld();

    for (const actor of [{ kind: 'artisan', userId: 41 }, { kind: 'staff' }, { kind: 'system' }, { kind: 'client', userId: 2 }] as any[]) {
      const error = await failure(w.service.update(8, { artisanId: 41 } as any, actor));

      expect(error instanceof ForbiddenException).toBe(true);
    }

    expect(w.assigned).toEqual([]);
  });
});

describe('InterventionsService.update without an artisan is what it was', () => {
  const staff = { kind: 'staff', userId: 5 } as const;

  it('a plain edit writes the columns and never asks the assignment', async () => {
    const w = makeWorld();

    await w.service.update(8, { description: 'nouveau texte' } as any, staff);

    expect(w.assigned).toEqual([]);
    expect(w.row.description).toBe('nouveau texte');
  });

  it('the client is told by text message only when the artisan accepts', async () => {
    const w = makeWorld();
    w.row.status = 'ASSIGNED';
    w.row.artisanId = 41;

    await w.service.update(8, { status: 'ARTISAN_ACCEPTED' } as any, staff);

    expect(w.sms.length).toBe(1);
    expect(w.assigned).toEqual([]);
  });

  it('and not when somebody saves the same status again', async () => {
    const w = makeWorld();
    w.row.status = 'ARTISAN_ACCEPTED';
    w.row.artisanId = 41;

    await w.service.update(8, { status: 'ARTISAN_ACCEPTED' } as any, staff);

    expect(w.sms).toEqual([]);
  });
});
