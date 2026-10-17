import { FakeTable } from '../../common/testing/fake-tables';
import { backfillArtisanProfiles } from './profile-backfill';

function makeWorld() {
  const users = new FakeTable({ defaults: () => ({ role: 'ARTISAN', isActive: true, deletedAt: null }) });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ verificationStatus: 'APPROVED', isAcceptingJobs: true, emergencyAvailable: true }),
  });
  const db: any = { user: users, artisanProfile: profiles };

  return {
    users,
    profiles,
    run: (options: { apply?: boolean; switchOn?: boolean; emergencyOn?: boolean } = {}) =>
      backfillArtisanProfiles(db, { apply: false, switchOn: false, emergencyOn: false, ...options }),
  };
}

describe('the artisan profile backfill (P1-05)', () => {
  it('a dry run lists and writes nothing', async () => {
    const w = makeWorld();
    const bare = w.users.insert({});
    const off = w.users.insert({});
    w.profiles.insert({ userId: off.id, isAcceptingJobs: false });

    const report = await w.run();

    expect(report.withoutProfile).toEqual([bare.id]);
    expect(report.notAccepting).toEqual([off.id]);
    expect(report.created).toEqual([]);
    expect(report.switchedOn).toEqual([]);
    expect(w.profiles.rows.length).toBe(1);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(false);
  });

  it('an active artisan with no profile gets an approved one that accepts missions, and only the artisans, only the active ones', async () => {
    const w = makeWorld();
    const bare = w.users.insert({});
    const inactive = w.users.insert({ isActive: false });
    const deleted = w.users.insert({ deletedAt: new Date() });
    w.users.insert({ role: 'CLIENT' });
    w.users.insert({ role: 'SUPPORT' });

    const report = await w.run({ apply: true });

    expect(report.created).toEqual([bare.id]);
    expect(report.withoutProfileInactive).toEqual([inactive.id, deleted.id]);
    expect(w.profiles.rows.length).toBe(1);
    expect(w.profiles.rows[0].userId).toBe(bare.id);
    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(true);
    expect(w.profiles.rows[0].verifiedAt instanceof Date).toBe(true);
  });

  it('an approved artisan who cannot take urgent jobs (no route ever set it) is listed, and made available for them only when asked', async () => {
    const w = makeWorld();
    const user = w.users.insert({});
    w.profiles.insert({ userId: user.id, emergencyAvailable: false });

    const dry = await w.run();

    expect(dry.noEmergency).toEqual([user.id]);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(false);

    const withoutFlag = await w.run({ apply: true });

    expect(withoutFlag.noEmergency).toEqual([user.id]);
    expect(withoutFlag.emergencyOn).toEqual([]);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(false); // an artisan who turned it off stays off

    const report = await w.run({ apply: true, emergencyOn: true });

    expect(report.emergencyOn).toEqual([user.id]);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(true);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true); // nothing else is touched
  });

  it('--emergency-on touches the urgent flag only, --switch-on the missions flag only', async () => {
    const w = makeWorld();
    const user = w.users.insert({});
    w.profiles.insert({ userId: user.id, emergencyAvailable: false, isAcceptingJobs: false });

    await w.run({ apply: true, emergencyOn: true });

    expect(w.profiles.rows[0].emergencyAvailable).toBe(true);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(false);

    w.profiles.rows[0].emergencyAvailable = false;
    await w.run({ apply: true, switchOn: true });

    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(false);
  });

  it('but not a suspended, pending or disabled one', async () => {
    const w = makeWorld();

    for (const verificationStatus of ['SUSPENDED', 'PENDING_REVIEW', 'REJECTED']) {
      const user = w.users.insert({});
      w.profiles.insert({ userId: user.id, verificationStatus, emergencyAvailable: false });
    }
    const disabled = w.users.insert({ isActive: false });
    w.profiles.insert({ userId: disabled.id, emergencyAvailable: false });

    const report = await w.run({ apply: true, emergencyOn: true });

    expect(report.noEmergency).toEqual([]);
    expect(report.emergencyOn).toEqual([]);
    expect(w.profiles.rows.every((row) => row.emergencyAvailable === false)).toBe(true);
  });

  it('a suspension made while the script ran is not undone for the urgent flag either', async () => {
    const w = makeWorld();
    const user = w.users.insert({});
    w.profiles.insert({ userId: user.id, emergencyAvailable: false });
    const updateMany = w.profiles.updateMany.bind(w.profiles);
    w.profiles.updateMany = async (args: any) => {
      w.profiles.rows[0].verificationStatus = 'SUSPENDED';

      return updateMany(args);
    };

    const report = await w.run({ apply: true, emergencyOn: true });

    expect(report.emergencyOn).toEqual([]);
    expect(report.raced).toEqual([user.id]);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(false);
  });

  it('an approved profile that does not accept missions is listed, and switched on only when asked', async () => {
    const w = makeWorld();
    const off = w.users.insert({});
    w.profiles.insert({ userId: off.id, isAcceptingJobs: false });

    const withoutFlag = await w.run({ apply: true });

    expect(withoutFlag.notAccepting).toEqual([off.id]);
    expect(withoutFlag.switchedOn).toEqual([]);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(false);

    const withFlag = await w.run({ apply: true, switchOn: true });

    expect(withFlag.switchedOn).toEqual([off.id]);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
  });

  it('never switches on a suspended, pending or rejected profile, nor the profile of a disabled account', async () => {
    const w = makeWorld();

    for (const verificationStatus of ['SUSPENDED', 'PENDING_REVIEW', 'REJECTED', 'DRAFT']) {
      const user = w.users.insert({});
      w.profiles.insert({ userId: user.id, verificationStatus, isAcceptingJobs: false });
    }
    const disabled = w.users.insert({ isActive: false });
    w.profiles.insert({ userId: disabled.id, isAcceptingJobs: false });

    const report = await w.run({ apply: true, switchOn: true });

    expect(report.notAccepting).toEqual([]);
    expect(report.switchedOn).toEqual([]);
    expect(w.profiles.rows.every((row) => row.isAcceptingJobs === false)).toBe(true);
  });

  it('a profile that exists is never replaced, and running again changes nothing', async () => {
    const w = makeWorld();
    const user = w.users.insert({});
    const profile = w.profiles.insert({ userId: user.id, specialty: 'Plomberie', verifiedById: 3 });
    const bare = w.users.insert({});

    await w.run({ apply: true, switchOn: true, emergencyOn: true });
    const second = await w.run({ apply: true, switchOn: true, emergencyOn: true });

    expect(second.created).toEqual([]);
    expect(second.withoutProfile).toEqual([]);
    expect(w.profiles.rows.length).toBe(2);
    expect(w.profiles.rows.find((row) => row.id === profile.id)!.specialty).toBe('Plomberie');
    expect(w.profiles.rows.find((row) => row.userId === bare.id)).toBeDefined();
  });

  it('a profile made by somebody else while the script ran is left alone, not an error', async () => {
    const w = makeWorld();
    const bare = w.users.insert({});
    const create = w.profiles.create.bind(w.profiles);
    w.profiles.create = async (args: any) => {
      w.profiles.rows.push({ id: 99, userId: bare.id, verificationStatus: 'PENDING_REVIEW', isAcceptingJobs: false });

      return create(args); // the unique column refuses it, like the database
    };

    const report = await w.run({ apply: true });

    expect(report.created).toEqual([]);
    expect(report.raced).toEqual([bare.id]);
    expect(w.profiles.rows[0].verificationStatus).toBe('PENDING_REVIEW');
  });

  it('a suspension made while the script ran is not undone', async () => {
    const w = makeWorld();
    const user = w.users.insert({});
    w.profiles.insert({ userId: user.id, isAcceptingJobs: false });
    const updateMany = w.profiles.updateMany.bind(w.profiles);
    w.profiles.updateMany = async (args: any) => {
      w.profiles.rows[0].verificationStatus = 'SUSPENDED';

      return updateMany(args);
    };

    const report = await w.run({ apply: true, switchOn: true });

    expect(report.switchedOn).toEqual([]);
    expect(report.raced).toEqual([user.id]);
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(false);
  });
});
