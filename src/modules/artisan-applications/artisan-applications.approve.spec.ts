import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { ArtisanApplicationsService } from './artisan-applications.service';

function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null, createdAt: new Date() }),
  });
  const applications = new FakeTable({ defaults: () => ({ status: 'PENDING' }) });
  const authToken = new FakeTable({ unique: ['tokenHash'], defaults: () => ({ usedAt: null, revokedAt: null, newValue: null }) });
  const profiles = new FakeTable({ unique: ['userId'], defaults: () => ({ isAcceptingJobs: false }) });
  const prisma: any = withTransactions(
    { user: users, artisanApplication: applications, authToken, artisanProfile: profiles },
    [users, applications, authToken, profiles],
  );

  const sent: any[] = [];
  const notifications: any = {
    sendEmail: async (to: string, subject: string, body: string) => {
      sent.push({ to, subject, body });
      return { queued: true };
    },
    isEmailSimulated: () => false,
  };

  process.env.FRONTEND_URL = 'https://app.example.tn';

  return { users, applications, authToken, profiles, sent, service: new ArtisanApplicationsService(prisma, notifications) };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const application = (extra: Record<string, unknown> = {}) => ({
  name: 'Ali Plombier',
  email: 'ali@mail.tn',
  phone: '55 111 222',
  ...extra,
});

describe('approving an artisan application (phone number rules)', () => {
  it('creates the account with the number and its key', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application());

    const result = await w.service.approve(app.id);

    expect(result.user.email).toBe('ali@mail.tn');

    const row = w.users.rows[0];
    expect(row.phone).toBe('55 111 222');
    expect(row.phoneKey).toBe('+21655111222');
    expect(w.applications.rows[0].status).toBe('APPROVED');
    expect(w.sent.length).toBe(1);
  });

  it('the artisan gets an approved profile that accepts missions, so the dispatcher can give them a job (P1-05)', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application({ specialty: 'Plomberie', experience: 6, description: 'Dépannage fuites' }));

    await w.service.approve(app.id);

    expect(w.profiles.rows.length).toBe(1);
    const profile = w.profiles.rows[0];
    expect(profile.userId).toBe(w.users.rows[0].id);
    expect(profile.verificationStatus).toBe('APPROVED');
    expect(profile.verifiedAt instanceof Date).toBe(true);
    expect(profile.isAcceptingJobs).toBe(true);
    expect(profile.specialty).toBe('Plomberie');
    expect(profile.specialties).toEqual(['Plomberie']);
    expect(profile.yearsExperience).toBe(6);
    expect(profile.bio).toBe('Dépannage fuites');
    expect(profile.emergencyAvailable).toBe(true); // urgent jobs on, as the admin screen always allowed them
  });

  it('when the profile cannot be made, no account is left behind and the application stays pending', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application());
    w.profiles.create = async () => {
      throw new Error('database down');
    };

    const error = await failure(w.service.approve(app.id));

    expect(error.message).toBe('database down');
    expect(w.users.rows.length).toBe(0);
    expect(w.applications.rows[0].status).toBe('PENDING');
    expect(w.sent.length).toBe(0);
  });

  it('a number already on another account blocks the approval, whatever the spelling, and nothing is created', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application({ phone: '+216 55111222' }));
    w.users.insert({ email: 'client@mail.tn', phone: '55 111 222', phoneKey: '+21655111222' });

    const error = await failure(w.service.approve(app.id));

    expect(error.status).toBe(400);
    expect(error.message.includes('champ phone')).toBe(true);
    expect(w.users.rows.length).toBe(1);
    expect(w.applications.rows[0].status).toBe('PENDING');
  });

  it('staff can give another number in the approval: it is used instead of the one on the form', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application());
    w.users.insert({ email: 'client@mail.tn', phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.approve(app.id, '  98 765 432 ');

    const created = w.users.rows.find((u) => u.email === 'ali@mail.tn')!;
    expect(created.phoneKey).toBe('+21698765432');
    expect(w.applications.rows[0].status).toBe('APPROVED');
  });

  it('a number that cannot be one is a clear 400 pointing at the field; a good one in the approval rescues it', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application({ phone: 'call me' }));

    const error = await failure(w.service.approve(app.id));

    expect(error.status).toBe(400);
    expect(error.message.includes('champ phone')).toBe(true);
    expect(w.users.rows.length).toBe(0);

    await w.service.approve(app.id, '55 111 222');
    expect(w.users.rows[0].phoneKey).toBe('+21655111222');
  });

  it('a blank override means "use the form\'s number"', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application());

    await w.service.approve(app.id, '   ');

    expect(w.users.rows[0].phoneKey).toBe('+21655111222');
  });

  it('the database refusing the number at the last moment (two approvals at once) is a 409', async () => {
    const w = makeWorld();
    const app = w.applications.insert(application());
    const realFindFirst = w.users.findFirst.bind(w.users);

    // the lookup sees nobody, then somebody else gets the number before the insert
    w.users.findFirst = async () => {
      w.users.findFirst = realFindFirst;
      w.users.insert({ email: 'racer@mail.tn', phone: '55 111 222', phoneKey: '+21655111222' });
      return null;
    };

    expect((await failure(w.service.approve(app.id))).status).toBe(409);
    expect(w.applications.rows[0].status).toBe('PENDING');
  });

  it('create() refuses a number that cannot be one, while the applicant can still fix it', async () => {
    const w = makeWorld();

    expect((await failure(w.service.create({ name: 'X', email: 'x@mail.tn', phone: 'nope' } as any))).status).toBe(400);
    expect(w.applications.rows.length).toBe(0);
  });
});
