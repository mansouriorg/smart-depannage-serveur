import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { AdminService } from './admin.service';

/**
 * An artisan the back office approves can be given a job (P1-05): the profile is
 * APPROVED and accepts missions. Before, "create manually" and "approve" left the
 * profile on the schema default (not accepting), which the assignment refuses.
 */

function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ verificationStatus: 'PENDING_REVIEW', isAcceptingJobs: false, availabilityStatus: 'OFFLINE', documents: [] }),
  });
  const prisma: any = withTransactions(
    { user: users, artisanProfile: profiles, artisanDocument: { updateMany: async () => ({ count: 0 }) } },
    [users, profiles],
  );

  const service = new AdminService(prisma, {} as any, {} as any, {} as any, {} as any);
  const notes: any[] = [];

  (service as any).invite = async () => ({});
  (service as any).addInternalNote = async (note: any) => notes.push(note);
  (service as any).getArtisanDetail = async (profileId: number) => profiles.rows.find((row) => row.id === profileId);

  return { users, profiles, service, notes };
}

describe('artisans the back office creates or approves are ready for a job (P1-05)', () => {
  it('created manually: approved, accepting missions, with the admin who verified them', async () => {
    const w = makeWorld();

    await w.service.createArtisanManually(9, {
      name: 'Sami Plombier',
      email: 'sami@mail.tn',
      phone: '55 222 333',
      specialties: ['Plomberie'],
      yearsExperience: 4,
    } as any);

    expect(w.profiles.rows.length).toBe(1);
    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(true);
    expect(w.profiles.rows[0].verifiedById).toBe(9);
  });

  it('a pending profile that is approved starts accepting missions', async () => {
    const w = makeWorld();
    const user = w.users.insert({ email: 'a@mail.tn', role: 'ARTISAN', isActive: false });
    // an application comes with its identity document (P1-11)
    const profile = w.profiles.insert({ userId: user.id, documents: [{ type: 'IDENTITY', status: 'PENDING', fileUrl: '/files/5/download' }] });

    await w.service.approveArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(true);
    expect(w.users.rows[0].isActive).toBe(true);
  });

  it('a suspended artisan who is reactivated gets missions back (the suspension had switched them off)', async () => {
    const w = makeWorld();
    const user = w.users.insert({ email: 'a@mail.tn', role: 'ARTISAN', isActive: false });
    const profile = w.profiles.insert({ userId: user.id, verificationStatus: 'SUSPENDED', isAcceptingJobs: false, emergencyAvailable: false });

    await w.service.reactivateArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(true);
    expect(w.profiles.rows[0].emergencyAvailable).toBe(false); // the suspension never touched it: what the artisan chose stays
  });

  it('suspending still switches missions off', async () => {
    const w = makeWorld();
    const user = w.users.insert({ email: 'a@mail.tn', role: 'ARTISAN' });
    const profile = w.profiles.insert({ userId: user.id, verificationStatus: 'APPROVED', isAcceptingJobs: true });

    await w.service.suspendArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0].verificationStatus).toBe('SUSPENDED');
    expect(w.profiles.rows[0].isAcceptingJobs).toBe(false);
  });
});
