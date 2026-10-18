import { eventsForParties } from '../../common/views/views';
import { AdminService } from './admin.service';

/**
 * P1-08: the note the back office types with a status change is for the back office. The line in
 * the timeline says what changed; the note is a line of its own that the customer and the artisan
 * do not get.
 */
function makeWorld() {
  const events: any[] = [];
  const job = { id: 8, status: 'CREATED', artisanId: null, clientId: 10 };

  const prisma: any = {
    intervention: {
      findUnique: async () => job,
      update: async ({ data }: any) => Object.assign(job, data),
    },
  };
  const eventsService: any = { create: async (event: any) => events.push({ id: events.length + 1, interventionId: 8, createdAt: new Date(), ...event }) };

  return { service: new AdminService(prisma, {} as any, eventsService, {} as any, {} as any, {} as any), events };
}

describe('a status change by the back office (P1-08)', () => {
  const note = 'Le client est difficile, ne pas lui donner de remise';

  it('the line says the new status; the note is a line of its own, internal', async () => {
    const w = makeWorld();

    await w.service.changeInterventionStatus(3, 8, { status: 'WAITING_ADMIN_REVIEW', note } as any);

    expect(w.events.map((event) => event.type)).toEqual(['ADMIN_REVIEWING', 'INTERNAL_NOTE_ADDED']);
    expect(w.events[0].message).toBe('Nouveau statut: WAITING_ADMIN_REVIEW');
    expect(w.events[1].message).toBe(note);
  });

  it('what the customer and the artisan read of it has no word of the note', async () => {
    const w = makeWorld();

    await w.service.changeInterventionStatus(3, 8, { status: 'WAITING_ADMIN_REVIEW', note } as any);

    const read = eventsForParties(w.events);

    expect(read.map((event) => event.message)).toEqual(['Nouveau statut: WAITING_ADMIN_REVIEW']);
    expect(JSON.stringify(read)).not.toContain(note);
  });

  it('without a note there is one line', async () => {
    const w = makeWorld();

    await w.service.changeInterventionStatus(3, 8, { status: 'WAITING_ADMIN_REVIEW' } as any);

    expect(w.events.length).toBe(1);
  });
});
