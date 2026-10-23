import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { InterventionsGateway } from '../interventions/interventions.gateway';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { RealtimeGateway } from './realtime.gateway';

process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);

/**
 * The live events with the wrong person (P1-17). A socket is a route too: it joins the room of a job, sends the position of
 * an artisan, listens for what is said to the back office. The events of the three gateways are tried with the people that
 * are not meant to use them: the customer and the artisan of another job, the customer on an artisan's event, the accountant
 * on an event that writes. The real gateways run on the in-memory database; the sockets are small stand-ins that keep their rooms.
 */
const ROLES = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'] as const;

function world() {
  const memory = new MemoryPrisma();
  const prisma: any = memory.client();
  const user = (role: string, name: string) => memory.plant('user', { role, name, email: `${name}@mail.tn`, isActive: true, phone: `2${Math.floor(Math.random() * 9e6) + 1e6}` }) as any;
  const clientA = user('CLIENT', 'client-a');
  const clientB = user('CLIENT', 'client-b');
  const artisanA = user('ARTISAN', 'artisan-a');
  const artisanB = user('ARTISAN', 'artisan-b');
  const staff: Record<string, any> = Object.fromEntries(ROLES.map((role) => [role, user(role, `staff-${role.toLowerCase()}`)]));
  const job = memory.plant('intervention', { clientId: clientA.id, artisanId: artisanA.id, status: 'ARTISAN_ON_THE_WAY' }) as any;
  const sent: Array<{ rooms: string[]; event: string; payload: any }> = [];
  const server = {
    to(room: string) {
      const rooms = [room];
      const chain: any = { to: (next: string) => (rooms.push(next), chain), emit: (event: string, payload?: any) => sent.push({ rooms: [...rooms], event, payload }) };

      return chain;
    },
  };
  // a token is its own payload: the stand-in signer reads it back
  const jwt: any = { verify: (token: string) => JSON.parse(token) };
  const realtime: any = new RealtimeGateway(jwt, prisma);
  const notifications: any = new NotificationsGateway(jwt);
  const interventions: any = new InterventionsGateway(jwt, prisma);

  realtime.server = server;
  notifications.server = server;
  interventions.server = server;

  return { memory, prisma, clientA, clientB, artisanA, artisanB, staff, job, sent, realtime, notifications, interventions };
}

function socket(person: any | null, extra: Record<string, unknown> = {}) {
  const rooms = new Set<string>();
  const emitted: string[] = [];
  const client: any = {
    id: `socket-${Math.random()}`,
    data: person ? { user: { id: person.id, role: person.role } } : {},
    handshake: { auth: {}, headers: {} },
    rooms,
    emitted,
    disconnected: false,
    join: async (room: string) => void rooms.add(room),
    leave: async (room: string) => void rooms.delete(room),
    emit: (event: string) => void emitted.push(event),
    disconnect() {
      client.disconnected = true;
    },
    ...extra,
  };

  return client;
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const tokenOf = (person: any) => JSON.stringify({ sub: person.id, role: person.role, tokenType: 'access' });

describe('connecting with the wrong person (P1-17)', () => {
  it('a token opens the rooms of its own person only, and the back office rooms only for the back office', async () => {
    const w = world();

    for (const person of [w.clientA, w.clientB, w.artisanA, w.artisanB, ...Object.values(w.staff)]) {
      const live = socket(null, { handshake: { auth: { token: tokenOf(person) }, headers: {} } });
      const lighter = socket(null, { handshake: { auth: { token: tokenOf(person) }, headers: {} } });

      await w.realtime.handleConnection(live);
      await w.notifications.handleConnection(lighter);

      for (const joined of [live, lighter]) {
        expect(joined.disconnected).toBe(false);
        expect([...joined.rooms].filter((room) => room.startsWith('user:'))).toEqual([`user:${person.id}`]);
        expect([...joined.rooms].some((room) => room.startsWith('client:') && room !== `client:${person.id}`)).toBe(false);
        expect([...joined.rooms].some((room) => room.startsWith('artisan:') && room !== `artisan:${person.id}`)).toBe(false);
        expect(joined.rooms.has('admins')).toBe(ROLES.includes(person.role));
      }

      expect(live.rooms.has('admin-dashboard')).toBe(ROLES.includes(person.role));
    }
  });

  it('no token, a token that is not a login token and a closed account are not let in', async () => {
    const w = world();
    const closed = w.memory.plant('user', { role: 'CLIENT', name: 'closed', email: 'closed@mail.tn', isActive: false, phone: '29999999' }) as any;
    const nothing = socket(null);
    const refresh = socket(null, { handshake: { auth: { token: JSON.stringify({ sub: w.clientA.id, role: 'CLIENT', tokenType: 'refresh' }) }, headers: {} } });
    const dead = socket(null, { handshake: { auth: { token: tokenOf(closed) }, headers: {} } });
    const liveRefresh = socket(null, { handshake: { auth: { token: JSON.stringify({ sub: w.clientA.id, role: 'CLIENT', tokenType: 'refresh' }) }, headers: {} } });

    await w.realtime.handleConnection(nothing);
    await w.realtime.handleConnection(dead);
    await w.notifications.handleConnection(refresh);
    await w.notifications.handleConnection(liveRefresh);

    for (const refused of [nothing, dead, refresh, liveRefresh]) {
      expect(refused.disconnected).toBe(true);
      expect(refused.rooms.size).toBe(0);
    }
  });
});

describe('the older gateway: connecting with the wrong person (P1-17)', () => {
  it('a login token opens the room of its own person, and the staff room only for the staff who work on tickets', async () => {
    const w = world();

    for (const person of [w.clientA, w.artisanB, ...Object.values(w.staff)]) {
      const live = socket(null, { handshake: { auth: { token: tokenOf(person) }, headers: {} } });

      await w.interventions.handleConnection(live);

      expect(live.disconnected).toBe(false);
      expect([...live.rooms].filter((room) => room.startsWith('user:'))).toEqual([`user:${person.id}`]);
      expect(live.rooms.has('staff')).toBe(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'].includes(person.role));
    }
  });

  it('no token, a refresh token and a closed account are not let in', async () => {
    const w = world();
    const closed = w.memory.plant('user', { role: 'CLIENT', name: 'closed-too', email: 'closed-too@mail.tn', isActive: false, phone: '29999998' }) as any;
    const tokens = [undefined, JSON.stringify({ sub: w.clientA.id, role: 'CLIENT', tokenType: 'refresh' }), tokenOf(closed)];

    for (const token of tokens) {
      const refused = socket(null, { handshake: { auth: token ? { token } : {}, headers: {} } });

      await w.interventions.handleConnection(refused);

      expect(refused.disconnected).toBe(true);
      expect(refused.rooms.size).toBe(0);
    }
  });
});

describe('intervention.join with the wrong person (P1-17)', () => {
  it('lets in the customer and the artisan of the job and the back office, and nobody else', async () => {
    const w = world();
    const allowed = [w.clientA, w.artisanA, ...Object.values(w.staff)];
    const refused = [w.clientB, w.artisanB];

    for (const person of allowed) {
      const socketOf = socket(person);

      await w.realtime.joinIntervention(socketOf, { interventionId: w.job.id });
      expect(socketOf.rooms.has(`intervention:${w.job.id}`)).toBe(true);
    }

    for (const person of refused) {
      const socketOf = socket(person);
      const error = await failure(w.realtime.joinIntervention(socketOf, { interventionId: w.job.id }));

      expect(String(error.message ?? error.getError?.())).toMatch(/refusé/);
      expect(socketOf.rooms.size).toBe(0);
      expect(socketOf.emitted).toEqual([]);
    }
  });

  it('a job that is not there, and a socket that never signed in, are refused', async () => {
    const w = world();

    expect((await failure(w.realtime.joinIntervention(socket(w.clientA), { interventionId: 9999 }))).message ?? 'x').toBeDefined();
    expect(socket(w.clientA).rooms.size).toBe(0);
    await failure(w.realtime.joinIntervention(socket(null), { interventionId: w.job.id }));
    await failure(w.realtime.updateArtisanLocation(socket(null), { interventionId: w.job.id, latitude: 36.8, longitude: 10.1 }));
    await failure(w.realtime.joinAdminDashboard(socket(null)));
  });

  it('leaving a room moves only the socket that asks', async () => {
    const w = world();
    const mine = socket(w.clientA);
    const theirs = socket(w.artisanA);

    await w.realtime.joinIntervention(mine, { interventionId: w.job.id });
    await w.realtime.joinIntervention(theirs, { interventionId: w.job.id });
    await w.realtime.leaveIntervention(mine, { interventionId: w.job.id });

    expect(mine.rooms.has(`intervention:${w.job.id}`)).toBe(false);
    expect(theirs.rooms.has(`intervention:${w.job.id}`)).toBe(true);
  });

  it('ping answers with the id of the socket\'s own person', async () => {
    const w = world();

    expect(w.realtime.ping(socket(w.clientB)).data.userId).toBe(w.clientB.id);
  });
});

describe('admin.dashboard.join with the wrong person (P1-17)', () => {
  it('the back office joins; customers and artisans are refused and join nothing', async () => {
    const w = world();

    for (const person of Object.values(w.staff)) {
      const socketOf = socket(person);

      await w.realtime.joinAdminDashboard(socketOf);
      expect(socketOf.rooms.has('admin-dashboard')).toBe(true);
    }

    for (const person of [w.clientA, w.clientB, w.artisanA, w.artisanB]) {
      const socketOf = socket(person);
      const error = await failure(w.realtime.joinAdminDashboard(socketOf));

      expect(String(error.message)).toMatch(/Admin access required/);
      expect(socketOf.rooms.size).toBe(0);
    }
  });
});

describe('artisan.location.update with the wrong person (P1-17)', () => {
  const position = (job: any) => ({ interventionId: job.id, latitude: 36.81, longitude: 10.17 });
  const located = (w: ReturnType<typeof world>, person: any) => {
    const row = w.memory.rows('user').find((entry) => entry.id === person.id) as any;

    return [row.latitude ?? null, row.longitude ?? null];
  };

  it('the artisan of the job and the staff who work on tickets send it; the position is written on the artisan of the job', async () => {
    const w = world();

    for (const person of [w.artisanA, w.staff.ADMIN, w.staff.SUPER_ADMIN, w.staff.SUPPORT, w.staff.DISPATCHER]) {
      w.memory.rows('user').forEach((row) => ((row.latitude = null), (row.longitude = null)));

      const answer = await w.realtime.updateArtisanLocation(socket(person), position(w.job));

      expect(answer.success).toBe(true);
      expect(located(w, w.artisanA)).toEqual([36.81, 10.17]);
    }
  });

  it('another artisan, a customer, the other household and the accountant are refused, and no position is written or told to anybody', async () => {
    const w = world();

    for (const person of [w.artisanB, w.clientA, w.clientB, w.staff.ACCOUNTANT]) {
      const before = JSON.stringify(w.memory.snapshot());
      const error = await failure(w.realtime.updateArtisanLocation(socket(person), position(w.job)));

      expect(String(error.message)).toMatch(/Only artisan or admin|Vous ne pouvez pas/);
      expect(JSON.stringify(w.memory.snapshot())).toBe(before);
    }

    expect(w.sent).toEqual([]);
    expect(located(w, w.artisanA)).toEqual([null, null]);
  });
});

describe('sendPosition (the older gateway) with the wrong person (P1-17)', () => {
  it('only an artisan sends a position, and it is stamped with the caller\'s own id whatever the message says', () => {
    const w = world();

    for (const person of [w.clientA, w.clientB, ...Object.values(w.staff)]) {
      expect(w.interventions.handlePosition({ lat: 36.8, lng: 10.1 }, socket(person))).toEqual({ ok: false, error: 'FORBIDDEN' });
    }

    expect(w.interventions.handlePosition({ lat: 36.8, lng: 10.1 }, socket(null))).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(w.sent).toEqual([]);

    const lying: any = { lat: 36.8, lng: 10.1, artisanId: w.artisanA.id };

    expect(w.interventions.handlePosition(lying, socket(w.artisanB))).toEqual({ ok: true });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].payload.artisanId).toBe(w.artisanB.id);
    expect(w.sent[0].rooms).toHaveLength(1);
  });
});
