import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { migrateApplications } from './application-migration';

function makeWorld() {
  const applications = new FakeTable({ defaults: () => ({ status: 'PENDING' }) });
  const profiles = new FakeTable({ unique: ['userId'] });
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
    include: { artisanProfile: (row) => profiles.rows.find((profile) => profile.userId === row.id) },
  });
  const db: any = withTransactions({ artisanApplication: applications, user: users, artisanProfile: profiles }, [applications, users, profiles]);

  return { applications, users, profiles, db };
}

const legacy = (extra: Record<string, unknown> = {}) => ({
  name: 'Ali Plombier',
  email: 'ali@mail.tn',
  phone: '55 111 222',
  specialty: 'Plombier',
  experience: 6,
  description: 'Dix ans de métier',
  ...extra,
});

describe('bringing the older applications into the verification queue (P1-11)', () => {
  it('a dry run lists the rows and writes nothing', async () => {
    const w = makeWorld();

    w.applications.insert(legacy());
    w.applications.insert(legacy({ email: 'sami@mail.tn', phone: '55 333 444' }));

    const report = await migrateApplications(w.db, { apply: false });

    expect(report.pending).toBe(2);
    expect(report.migrated.map((item) => item.applicationId)).toEqual([1, 2]);
    expect(w.users.rows).toHaveLength(0);
    expect(w.profiles.rows).toHaveLength(0);
    expect(w.applications.rows.every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('makes an account that cannot be used yet and a profile waiting for review, and marks the row MIGRATED', async () => {
    const w = makeWorld();

    w.applications.insert(legacy({ specialty: 'Climatisation' }));

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.migrated).toEqual([{ applicationId: 1, userId: 1, profileId: 1 }]);
    expect(w.users.rows[0]).toMatchObject({ name: 'Ali Plombier', email: 'ali@mail.tn', role: 'ARTISAN', isActive: false, phone: '55 111 222', phoneKey: '+21655111222' });
    expect(w.users.rows[0].password).toBeTruthy();
    expect(w.users.rows[0].password).not.toContain('Unusable');
    expect(w.profiles.rows[0]).toMatchObject({
      userId: 1,
      verificationStatus: 'PENDING_REVIEW',
      yearsExperience: 6,
      bio: 'Dix ans de métier',
      specialty: 'Climaticien',
      specialties: ['Climaticien'],
      serviceTypes: ['CLIMATICIEN'],
    });
    expect(w.applications.rows[0].status).toBe('MIGRATED');
  });

  it('the e-mail is written as the sign-in reads it: trimmed, lower case', async () => {
    const w = makeWorld();

    w.applications.insert(legacy({ email: '  Ali.Plombier@Mail.TN ' }));
    await migrateApplications(w.db, { apply: true });

    expect(w.users.rows[0].email).toBe('ali.plombier@mail.tn');
  });

  it('a word that names no trade is kept as written and counts as "Autre"', async () => {
    const w = makeWorld();

    w.applications.insert(legacy({ specialty: 'Maçon' }));
    await migrateApplications(w.db, { apply: true });

    expect(w.profiles.rows[0]).toMatchObject({ specialty: 'Maçon', specialties: ['Maçon'], serviceTypes: ['AUTRE'] });
  });

  it('only the pending rows are read: an approved, refused or already migrated row is left alone', async () => {
    const w = makeWorld();

    w.applications.insert(legacy({ status: 'APPROVED' }));
    w.applications.insert(legacy({ email: 'b@mail.tn', phone: '55 000 001', status: 'REJECTED' }));
    w.applications.insert(legacy({ email: 'c@mail.tn', phone: '55 000 002', status: 'MIGRATED' }));

    const report = await migrateApplications(w.db, { apply: true });

    expect(report).toEqual({ pending: 0, migrated: [], skipped: [] });
    expect(w.users.rows).toHaveLength(0);
  });

  it('running it twice brings each row over once', async () => {
    const w = makeWorld();

    w.applications.insert(legacy());
    await migrateApplications(w.db, { apply: true });

    const again = await migrateApplications(w.db, { apply: true });

    expect(again.pending).toBe(0);
    expect(w.users.rows).toHaveLength(1);
    expect(w.profiles.rows).toHaveLength(1);
  });

  it('a number that is not one is listed with its reason and the row stays pending (the person can apply again)', async () => {
    const w = makeWorld();

    w.applications.insert(legacy({ phone: 'call me' }));

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.migrated).toEqual([]);
    expect(report.skipped).toEqual([{ applicationId: 1, reason: 'the phone number is not a valid number' }]);
    expect(w.applications.rows[0].status).toBe('PENDING');
    expect(w.users.rows).toHaveLength(0);
  });

  it('an e-mail or number that belongs to a client account blocks that row only', async () => {
    const w = makeWorld();

    w.users.insert({ email: 'client@mail.tn', role: 'CLIENT', phone: '55 111 222', phoneKey: '+21655111222' });
    w.applications.insert(legacy({ email: 'ali@mail.tn', phone: '+216 55111222' }));
    w.applications.insert(legacy({ email: 'sami@mail.tn', phone: '55 333 444' }));

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.skipped.map((item) => item.applicationId)).toEqual([1]);
    expect(report.skipped[0].reason).toContain('not an artisan');
    expect(report.migrated.map((item) => item.applicationId)).toEqual([2]);
    expect(w.applications.rows.map((row) => row.status)).toEqual(['PENDING', 'MIGRATED']);
  });

  it('an artisan account with no profile is used; one that has a profile already is not touched', async () => {
    const w = makeWorld();
    const bare = w.users.insert({ email: 'ali@mail.tn', role: 'ARTISAN', isActive: true });
    const taken = w.users.insert({ email: 'sami@mail.tn', role: 'ARTISAN' });

    w.profiles.insert({ userId: taken.id, verificationStatus: 'APPROVED' });
    w.applications.insert(legacy());
    w.applications.insert(legacy({ email: 'sami@mail.tn', phone: '55 333 444' }));

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.migrated).toHaveLength(1);
    expect(report.migrated[0].userId).toBe(bare.id);
    expect(report.skipped).toEqual([{ applicationId: 2, reason: 'an artisan profile already exists for this e-mail or number' }]);
    // the existing account is not changed (it stays active)
    expect(w.users.rows.find((user) => user.id === bare.id)!.isActive).toBe(true);
    expect(w.users.rows).toHaveLength(2);
  });

  it('when the profile cannot be written nothing is left behind and the row stays pending', async () => {
    const w = makeWorld();

    w.applications.insert(legacy());
    w.profiles.create = async () => {
      throw new Error('database down');
    };

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.migrated).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(w.users.rows).toHaveLength(0);
    expect(w.applications.rows[0].status).toBe('PENDING');
  });

  it('a row that was changed by someone else while the script ran is left as it is', async () => {
    const w = makeWorld();

    w.applications.insert(legacy());

    const realFind = w.applications.findMany;

    // the script has read the row as pending; then the back office refuses it
    w.applications.findMany = async (args: any) => {
      const found = await realFind(args);

      w.applications.rows[0].status = 'REJECTED';

      return found;
    };

    const report = await migrateApplications(w.db, { apply: true });

    expect(report.migrated).toEqual([]);
    expect(report.skipped[0].reason).toBe('changed while the script ran');
    expect(w.users.rows).toHaveLength(0);
    expect(w.applications.rows[0].status).toBe('REJECTED');
  });
});
