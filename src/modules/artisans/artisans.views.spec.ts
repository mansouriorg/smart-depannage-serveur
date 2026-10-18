import { leaked, leakedTo, poisonedJob } from '../../common/testing/poison';
import { chatsOf } from '../../common/views/views';
import { ArtisansService } from './artisans.service';

/**
 * P1-08: what the artisan's mission routes answer. The assigned artisan has the customer to call;
 * an artisan looking at an open mission has neither the way to reach the customer nor the
 * conversation; nobody on the app reads the back office's notes.
 */
function makeWorld(job: Record<string, unknown> = {}) {
  const asked: Record<string, any> = {};
  const created: any[] = [];
  const eventsWritten: any[] = [];
  const prisma: any = {
    artisanProfile: {
      findUnique: async () => ({ id: 7, userId: 20, verificationStatus: 'APPROVED', specialties: ['PLOMBIER'], availability: [] }),
    },
    artisanMissionRejection: { findFirst: async () => null },
    user: { findUnique: async () => ({ latitude: 36.8, longitude: 10.18 }) },
    intervention: {
      findUnique: async (args: any) => {
        if (args.select) return { status: 'IN_PROGRESS', artisanId: 20 };

        asked.findUnique = args;

        return poisonedJob(job);
      },
      update: async () => poisonedJob({ ...job, status: 'DISPUTED' }),
    },
    message: {
      create: async ({ data }: any) => {
        created.push(data);

        return { ...poisonedJob().messages[0], ...data, id: 9, readByUserIds: [secretReader] };
      },
    },
  };
  const events: any = { create: async (event: any) => { eventsWritten.push(event); } };
  const service = new ArtisansService(prisma, {} as any, events, {} as any, {} as any, {} as any);

  return { service, asked, created, eventsWritten };
}

const secretReader = 'SECRET<message.readByUserIds>';
// the artisan of this world is a plumber: an open job of another trade is not shown to them (P1-11)
const open = { artisanId: null, status: 'CREATED', serviceType: 'PLOMBIER' };

describe('what the artisan\'s mission routes answer (P1-08)', () => {
  it('the mission of the artisan: the artisan\'s copy, the customer to call, the distance and the link', async () => {
    const world = makeWorld();
    const answer: any = await world.service.getMissionDetails(20, 1);

    expect(leakedTo(answer, 'artisan')).toEqual([]);
    expect(answer.client.phone).toBe('+21620000000');
    expect(typeof answer.navigationUrl).toBe('string');
    expect(answer.messages.map((message: any) => message.id)).toEqual([1, 3]);
    expect(answer.events.map((event: any) => event.id)).toEqual([1]);
  });

  it('asks the database for the artisan\'s two chats only, and not for a deleted message', async () => {
    const world = makeWorld();

    await world.service.getMissionDetails(20, 1);

    const messages = world.asked.findUnique.include.messages;

    expect(messages.where.deletedAt).toBeNull();
    expect(messages.where.audience.in).toEqual(chatsOf('artisan'));
  });

  it('an open mission: the board\'s copy, no way to reach the customer, no conversation, no timeline', async () => {
    const answer: any = await makeWorld(open).service.getMissionDetails(20, 1);

    expect(leakedTo(answer, 'board')).toEqual([]);
    expect(answer.client).toEqual({ name: 'Salah' });
    expect(answer.messages).toEqual([]);
    expect(answer.events).toEqual([]);
    expect(answer.payments).toEqual([]);
    expect(answer.invoice).toBeNull();
    expect(JSON.stringify(answer)).not.toContain('+21620000000');
    expect(JSON.stringify(answer)).not.toContain('salah@example.tn');
    expect(JSON.stringify(answer)).not.toContain('4B-1234');
  });

  it('a message to the customer or to the support: no address of the writer, no id of the other readers', async () => {
    const world = makeWorld();

    for (const answer of [
      await world.service.contactClient(20, 1, { content: 'J’arrive' } as any),
      await world.service.contactAdmin(20, 1, { content: 'Question' } as any),
    ] as any[]) {
      expect(leaked(answer)).toEqual([]);
      expect(answer).not.toHaveProperty('readByUserIds');
    }

    expect(world.created.map((data) => data.audience)).toEqual(['CLIENT_ARTISAN', 'ARTISAN_SUPPORT']);
  });

  it('a problem reported: the artisan\'s copy, and a line in the timeline that only the back office reads', async () => {
    const world = makeWorld();
    const answer: any = await world.service.reportProblem(20, 1, { problemType: 'ACCESS', notes: 'Porte fermée' } as any);

    expect(leakedTo(answer, 'artisan')).toEqual([]);
    expect(world.eventsWritten.length).toBe(1);
    expect(world.eventsWritten[0].metadata).toEqual({ internal: true });
  });
});
