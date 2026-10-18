import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { AdminService } from '../admin/admin.service';
import { ArtisansService } from './artisans.service';

/**
 * P1-10: the main specialty, the list of specialties and the service types are written together
 * wherever a profile is made or changed, from the one table of trades. A word that is no trade is
 * refused before anything is made.
 */

function makeArtisans() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ specialty: null, specialties: [], serviceTypes: [], verificationStatus: 'PENDING_REVIEW' }),
  });
  const documents = new FakeTable();
  // the platform's zone list the applicant picks from (P1-11)
  const platformZones = new FakeTable();
  platformZones.insert({ name: 'Tunis', city: 'Tunis', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  const prisma: any = withTransactions(
    { user: users, artisanProfile: { ...profiles, update: async ({ where, data }: any) => Object.assign(profiles.rows.find((row) => row.id === where.id)!, data) }, artisanDocument: documents, adminServiceZone: platformZones, artisanServiceZone: { createMany: async () => ({ count: 0 }) } },
    [users, profiles, documents],
  );
  const notifications: any = { sendEmail: async () => ({ queued: true }), sendSms: async () => ({ queued: true }), notifyArtisanApplication: async () => [] };
  const rateLimit: any = { allowSendTo: () => true };
  // the documents are tested with the real files service in artisans.apply.spec.ts
  const files: any = {
    assertApplicantDocument: () => undefined,
    stageApplicantDocument: async () => ({ relativePath: 'private/x' }),
    recordApplicantDocument: async () => ({}),
    discardStagedPhoto: async () => undefined,
  };
  const service = new ArtisansService(prisma, notifications, {} as any, rateLimit, {} as any, files);

  // the profile of the signed-in artisan
  (service as any).getArtisanProfileByUserId = async (userId: number) => profiles.rows.find((row) => row.userId === userId);

  return { users, profiles, service };
}

const application = (extra: Record<string, unknown> = {}) =>
  ({ name: 'Sami', email: 'sami@mail.tn', phone: '55 222 333', specialties: ['Plombier'], yearsExperience: 3, zoneIds: [1], ...extra }) as any;

const identity = { identity: { originalname: 'cin.pdf' } as any };

describe('an artisan who applies (P1-10)', () => {
  it('has the trades written as a set, from what the form sent', async () => {
    const w = makeArtisans();

    await w.service.apply(application({ specialty: 'Climatisation', specialties: ['Climatisation', 'Électricité'] }), identity);

    const profile = w.profiles.rows[0];

    expect(profile.specialty).toBe('Climaticien');
    expect(profile.specialties).toEqual(['Climaticien', 'Électricien']);
    expect(profile.serviceTypes).toEqual(['CLIMATICIEN', 'ELECTRICIEN']);
  });

  it('is refused (400) for a word that is no trade, and no account is made', async () => {
    const w = makeArtisans();

    await expect(w.service.apply(application({ specialties: ['Plombier', 'Sorcier'] }), identity)).rejects.toThrow(/Métier inconnu/);

    expect(w.users.rows.length).toBe(0);
    expect(w.profiles.rows.length).toBe(0);
  });

  it('is refused (400) with no trade at all', async () => {
    const w = makeArtisans();

    await expect(w.service.apply(application({ specialties: [] }), identity)).rejects.toThrow(/au moins un métier/);

    expect(w.profiles.rows.length).toBe(0);
  });
});

describe('an artisan who changes their own profile (P1-10)', () => {
  const profileOf = (w: ReturnType<typeof makeArtisans>) => w.profiles.insert({ userId: 4, specialty: 'Plombier', specialties: ['Plombier'], serviceTypes: ['PLOMBIER'] });

  it('changes the three together', async () => {
    const w = makeArtisans();
    profileOf(w);

    await w.service.updateMyProfile(4, { specialties: ['Vitrerie', 'Serrurerie'] } as any);

    expect(w.profiles.rows[0].specialty).toBe('Vitrier');
    expect(w.profiles.rows[0].specialties).toEqual(['Vitrier', 'Serrurier']);
    expect(w.profiles.rows[0].serviceTypes).toEqual(['VITRIER', 'SERRURIER']);
  });

  it('changing only the main trade keeps the other trades of the profile', async () => {
    const w = makeArtisans();
    w.profiles.insert({
      userId: 4,
      specialty: 'Plombier',
      specialties: ['Plombier', 'Électricien'],
      serviceTypes: ['PLOMBIER', 'ELECTRICIEN'],
    });

    await w.service.updateMyProfile(4, { specialty: 'Électricien' } as any);

    expect(w.profiles.rows[0].specialty).toBe('Électricien');
    expect(w.profiles.rows[0].specialties).toEqual(['Électricien', 'Plombier']);
    expect([...w.profiles.rows[0].serviceTypes].sort()).toEqual(['ELECTRICIEN', 'PLOMBIER']);
  });

  it('sending the list replaces it, which is how a trade is taken off', async () => {
    const w = makeArtisans();
    w.profiles.insert({
      userId: 4,
      specialty: 'Plombier',
      specialties: ['Plombier', 'Électricien'],
      serviceTypes: ['PLOMBIER', 'ELECTRICIEN'],
    });

    await w.service.updateMyProfile(4, { specialties: ['Électricien'] } as any);

    expect(w.profiles.rows[0].specialties).toEqual(['Électricien']);
    expect(w.profiles.rows[0].serviceTypes).toEqual(['ELECTRICIEN']);
  });

  it('keeps the trades when the change is about something else', async () => {
    const w = makeArtisans();
    profileOf(w);

    await w.service.updateMyProfile(4, { bio: 'Dix ans de métier' } as any);

    expect(w.profiles.rows[0].bio).toBe('Dix ans de métier');
    expect(w.profiles.rows[0].serviceTypes).toEqual(['PLOMBIER']);
  });

  it('cannot empty the list, or put a word that is no trade, to change which jobs it sees', async () => {
    const w = makeArtisans();
    profileOf(w);

    await expect(w.service.updateMyProfile(4, { specialties: [] } as any)).rejects.toThrow(/au moins un métier/);
    await expect(w.service.updateMyProfile(4, { specialty: 'Sorcier' } as any)).rejects.toThrow(/Métier inconnu/);

    expect(w.profiles.rows[0].serviceTypes).toEqual(['PLOMBIER']);
  });
});

function makeAdmin() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ specialty: null, specialties: [], serviceTypes: [], verificationStatus: 'APPROVED' }),
  });
  const prisma: any = withTransactions(
    { user: users, artisanProfile: { ...profiles, update: async ({ where, data }: any) => Object.assign(profiles.rows.find((row) => row.id === where.id)!, data) } },
    [users, profiles],
  );
  const service = new AdminService(prisma, {} as any, {} as any, {} as any, {} as any);

  (service as any).invite = async () => ({});
  (service as any).getArtisanDetail = async (profileId: number) => profiles.rows.find((row) => row.id === profileId);

  return { users, profiles, service };
}

describe('an artisan the back office creates or edits (P1-10)', () => {
  const dto = (extra: Record<string, unknown> = {}) =>
    ({ name: 'Sami', email: 'sami@mail.tn', phone: '55 222 333', specialties: ['Chauffage'], yearsExperience: 2, ...extra }) as any;

  it('created manually: the trades are written as a set', async () => {
    const w = makeAdmin();

    await w.service.createArtisanManually(9, dto({ specialty: 'Vitrier', specialties: ['Chauffagiste'] }));

    expect(w.profiles.rows[0].specialty).toBe('Vitrier');
    expect(w.profiles.rows[0].specialties).toEqual(['Vitrier', 'Chauffagiste']);
    expect(w.profiles.rows[0].serviceTypes).toEqual(['VITRIER', 'CHAUFFAGISTE']);
  });

  it('created manually with a word that is no trade: refused (400) before the account is made', async () => {
    const w = makeAdmin();

    await expect(w.service.createArtisanManually(9, dto({ specialties: ['Magicien'] }))).rejects.toThrow(/Métier inconnu/);

    expect(w.users.rows.length).toBe(0);
    expect(w.profiles.rows.length).toBe(0);
  });

  it('edited: the trades follow, and a change of something else leaves them alone', async () => {
    const w = makeAdmin();
    const profile = w.profiles.insert({ userId: 1, specialty: 'Plombier', specialties: ['Plombier'], serviceTypes: ['PLOMBIER'] });

    await w.service.editArtisanProfile(profile.id, { yearsExperience: 9 } as any);
    expect(w.profiles.rows[0].serviceTypes).toEqual(['PLOMBIER']);

    await w.service.editArtisanProfile(profile.id, { specialties: ['Climatisation'] } as any);
    expect(w.profiles.rows[0].specialty).toBe('Climaticien');
    expect(w.profiles.rows[0].specialties).toEqual(['Climaticien']);
    expect(w.profiles.rows[0].serviceTypes).toEqual(['CLIMATICIEN']);
    expect(w.profiles.rows[0].yearsExperience).toBe(9);
  });

  it('edited with the main trade only: it goes first and the profile keeps its other trades', async () => {
    const w = makeAdmin();
    const profile = w.profiles.insert({
      userId: 1,
      specialty: 'Plombier',
      specialties: ['Plombier', 'Maçon'],
      serviceTypes: ['PLOMBIER', 'AUTRE'],
    });

    await w.service.editArtisanProfile(profile.id, { specialty: 'Climatisation' } as any);

    expect(w.profiles.rows[0].specialty).toBe('Climaticien');
    // a word stored before the table that names no trade is kept as it was written
    expect(w.profiles.rows[0].specialties).toEqual(['Climaticien', 'Plombier', 'Maçon']);
    expect([...w.profiles.rows[0].serviceTypes].sort()).toEqual(['AUTRE', 'CLIMATICIEN', 'PLOMBIER']);
  });

  it('edited with a word that is no trade: refused (400), nothing changes', async () => {
    const w = makeAdmin();
    const profile = w.profiles.insert({ userId: 1, specialty: 'Plombier', specialties: ['Plombier'], serviceTypes: ['PLOMBIER'] });

    await expect(w.service.editArtisanProfile(profile.id, { specialties: ['Plombier', 'Magicien'] } as any)).rejects.toThrow(/Métier inconnu/);

    expect(w.profiles.rows[0].specialties).toEqual(['Plombier']);
  });
});
