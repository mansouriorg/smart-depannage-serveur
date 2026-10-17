import * as argon2 from 'argon2';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { InterventionsService } from './interventions.service';

function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ role: 'CLIENT', isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });

  const created: any[] = [];
  const intervention = {
    create: async ({ data }: any) => {
      const { client, ...rest } = data;
      const owner = users.rows.find((u) => u.id === client.connect.id);
      const row = { id: created.length + 1, ...rest, clientId: client.connect.id, serviceType: rest.serviceType ?? 'PLOMBIER', client: owner };
      created.push(row);
      return row;
    },
  };

  const prisma: any = withTransactions({ user: users, intervention }, [users]);
  const gateway: any = { sendNewIntervention: () => undefined };
  const notifications: any = { sendSms: async () => ({ queued: true }) };

  return { users, created, service: new InterventionsService(prisma, gateway, notifications, new RateLimitService()) };
}

const form = (contactPhone: string, extra: Record<string, unknown> = {}) =>
  ({ contactPhone, contactName: 'Sami', serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis', ...extra }) as any;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

/**
 * The lookups (profile, then "is the number held?") see nobody; before the insert
 * another request takes the number. The database's unique key is what stops the second one.
 */
function raceAgainst(w: ReturnType<typeof makeWorld>, winner: { email: string; isGuest: boolean }) {
  const realFindMany = w.users.findMany.bind(w.users);
  const realCount = w.users.count.bind(w.users);
  let looked = false;

  w.users.findMany = async (args: any) => {
    if (!looked) {
      looked = true;
      return [];
    }

    return realFindMany(args);
  };

  w.users.count = async () => {
    w.users.insert({ email: winner.email, password: 'x', isGuest: winner.isGuest, phone: '55 111 222', phoneKey: '+21655111222' });
    w.users.count = realCount;
    return 0;
  };
}

describe('legacy public request (POST /interventions without a session): phone numbers', () => {
  it('a new number makes a guest profile with the number and its key; the answer carries no profile', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(null, form('55 111 222'));

    expect(w.users.rows.length).toBe(1);
    expect(w.users.rows[0].isGuest).toBe(true);
    expect(w.users.rows[0].phoneKey).toBe('+21655111222');
    expect(answer.client).toBe(undefined);
    expect(typeof answer.rawTrackingToken).toBe('string');
    expect(w.created[0].contactPhone).toBe(undefined); // the profile has the number: no copy on the request
  });

  it('the same number written another way is the same guest', async () => {
    const w = makeWorld();

    await w.service.create(null, form('55 111 222'));
    await w.service.create(null, form('+216 55111222'));

    expect(w.users.rows.length).toBe(1);
    expect(w.created.length).toBe(2);
    expect(w.created[0].clientId).toBe(w.created[1].clientId);
  });

  it('a real account with that number is never reused: 409', async () => {
    const w = makeWorld();
    w.users.insert({ email: 'real@mail.tn', password: await argon2.hash('x'), phone: '55 111 222', phoneKey: '+21655111222' });

    expect((await failure(w.service.create(null, form('0021655111222')))).status).toBe(409);
    expect(w.created.length).toBe(0);
  });

  it('a deleted account still holding the number: the guest is made without it, and the request keeps the number to call back', async () => {
    const w = makeWorld();
    w.users.insert({ email: 'gone@mail.tn', password: await argon2.hash('x'), isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.create(null, form('55 111 222'));

    const guest = w.users.rows.find((u) => u.isGuest)!;
    expect(guest.phone).toBe(null);
    expect(guest.phoneKey).toBe(null);
    expect(w.created[0].contactPhone).toBe('55 111 222');
    expect(w.created[0].contactName).toBe('Sami');
  });

  it('a deleted account whose number is only text (no key) does not stand in the way: the guest gets the number', async () => {
    const w = makeWorld();
    w.users.insert({ email: 'gone@mail.tn', password: await argon2.hash('x'), isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: null });

    await w.service.create(null, form('55 111 222'));

    expect(w.users.rows.find((u) => u.isGuest)!.phoneKey).toBe('+21655111222');
  });

  it('two forms sent at the same moment end on one guest profile', async () => {
    const w = makeWorld();
    raceAgainst(w, { email: 'guest_x@guest.smart-depannage.local', isGuest: true });

    await w.service.create(null, form('55 111 222'));

    expect(w.users.rows.length).toBe(1);
    expect(w.created[0].clientId).toBe(w.users.rows[0].id);
  });

  it('a race against a REAL account is a 409, not a request attached to somebody else', async () => {
    const w = makeWorld();
    raceAgainst(w, { email: 'real@mail.tn', isGuest: false });

    expect((await failure(w.service.create(null, form('55 111 222')))).status).toBe(409);
    expect(w.created.length).toBe(0);
  });

  it('a profile made at the same moment WITHOUT the number (lookup saw it taken) never hijacks the real account', async () => {
    const w = makeWorld();
    const realFindMany = w.users.findMany.bind(w.users);
    let looked = false;

    // between the lookup and the check the number is taken by a real account: this form gets a profile without it
    w.users.findMany = async (args: any) => {
      if (!looked) {
        looked = true;
        w.users.insert({ email: 'real@mail.tn', password: 'x', phone: '55 111 222', phoneKey: '+21655111222' });
        return [];
      }

      return realFindMany(args);
    };

    await w.service.create(null, form('55 111 222'));

    const real = w.users.rows.find((u) => u.email === 'real@mail.tn')!;
    expect(w.created[0].clientId).not.toBe(real.id);
    expect(w.created[0].contactPhone).toBe('55 111 222');
  });

  it('a guest profile that has a mailbox of its own is not reused: the request does not join somebody else\'s profile', async () => {
    const w = makeWorld();
    const seeded = w.users.insert({ email: 'attacker@mail.tn', password: await argon2.hash('x'), isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.create(null, form('55 111 222'));

    expect(w.created[0].clientId).not.toBe(seeded.id);

    const mine = w.users.rows.find((u) => u.id === w.created[0].clientId)!;
    expect(mine.isGuest).toBe(true);
    expect(mine.phone).toBe(null); // the number is held by the other profile
    expect(w.created[0].contactPhone).toBe('55 111 222'); // the request keeps it
  });

  it('a legacy profile (made-up address, even on the real domain) is still reused', async () => {
    const w = makeWorld();
    const legacy = w.users.insert({ email: 'guest_1699999999@smart-depannage.com', password: await argon2.hash('123456'), isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.create(null, form('55 111 222'));

    expect(w.created[0].clientId).toBe(legacy.id);
    expect(w.users.rows.length).toBe(1);
  });

  it('a race against a guest that has a real address ends with a profile of its own, without the number', async () => {
    const w = makeWorld();
    raceAgainst(w, { email: 'attacker@mail.tn', isGuest: true });

    await w.service.create(null, form('55 111 222'));

    expect(w.users.rows.length).toBe(2);
    expect(w.created[0].clientId).not.toBe(w.users.rows[0].id);
    expect(w.created[0].contactPhone).toBe('55 111 222');
  });

  it('a number that cannot be one is a 400', async () => {
    const w = makeWorld();

    expect((await failure(w.service.create(null, form('not a number')))).status).toBe(400);
    expect(w.users.rows.length).toBe(0);
  });
});
