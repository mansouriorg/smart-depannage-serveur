import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { AdminService } from './admin.service';

process.env.FRONTEND_URL = 'https://app.example.tn';

/**
 * P1-11: the back office's side of onboarding. An application is accepted once, with its identity
 * document checked (or an explicit, written exception), and refused with a reason the applicant
 * reads. Accepting or adding an artisan sends the one-time link to choose a password.
 */

/** A document of an application: a file kept by the platform, as the apply route records it. */
const file = (type: string, status: string, fileUrl: string | null = '/files/5/download') => ({ type, status, fileUrl });

function makeWorld(options: { simulated?: boolean } = {}) {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    honourSelect: true,
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ verificationStatus: 'PENDING_REVIEW', isAcceptingJobs: false, documents: [] }),
  });
  const documents = new FakeTable();
  const zones = new FakeTable();
  const platform = new FakeTable();
  const notes = new FakeTable();
  const tokens = new FakeTable();

  platform.insert({ name: 'Tunis', city: 'Tunis', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  platform.insert({ name: 'Off', city: null, latitude: 35, longitude: 10, radiusKm: 10, isActive: false });

  const prisma: any = withTransactions(
    {
      user: users,
      artisanProfile: profiles,
      artisanDocument: documents,
      artisanServiceZone: zones,
      adminServiceZone: platform,
      adminInternalNote: notes,
      authToken: tokens,
    },
    [users, profiles, zones, notes, tokens],
  );

  const mails: any[] = [];
  const texts: any[] = [];
  const notifications: any = {
    sendEmail: async (to: string, subject: string, content: string) => mails.push({ to, subject, content }),
    sendSms: async (to: string, content: string) => texts.push({ to, content }),
    isEmailSimulated: () => Boolean(options.simulated),
  };

  const service = new AdminService(prisma, notifications, {} as any, {} as any, {} as any, {} as any);

  (service as any).getArtisanDetail = async (profileId: number) => {
    const profile = profiles.rows.find((row) => row.id === profileId);

    if (!profile) throw new Error('not found');

    return { ...profile, user: users.rows.find((user) => user.id === profile.userId) };
  };

  const applicant = (fields: Record<string, unknown> = {}, docs: Array<Record<string, unknown>> = [file('IDENTITY', 'PENDING')]) => {
    const user = users.insert({ email: `a${users.rows.length}@mail.tn`, name: 'Sami', phone: '+21655222333', role: 'ARTISAN', isActive: false });

    return profiles.insert({ userId: user.id, documents: docs, ...fields });
  };

  return { users, profiles, zones, notes, tokens, documents, mails, texts, service, applicant };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('accepting an application (P1-11)', () => {
  it('an application with its identity document is accepted: active account, approved profile, and the invitation sent', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    const answer: any = await w.service.approveArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'APPROVED', verifiedById: 9, isAcceptingJobs: true, emergencyAvailable: true, rejectionReason: null });
    expect(w.users.rows[0].isActive).toBe(true);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0].subject).toBe('Votre candidature est acceptée');
    expect(w.mails[0].to).toBe(w.users.rows[0].email);
    expect(w.texts).toHaveLength(1);
    expect(w.tokens.rows).toHaveLength(1);
    // a real mail server: the link is not in the answer
    expect(answer.passwordSetupUrl).toBeUndefined();
  });

  it('while the mails are simulated the link comes back in the answer, for the staff member to hand over', async () => {
    const w = makeWorld({ simulated: true });
    const profile = w.applicant();

    const answer: any = await w.service.approveArtisan(9, profile.id, {} as any);

    expect(answer.passwordSetupUrl).toMatch(/^https:\/\/app\.example\.tn\/reset-password\?token=[0-9a-f]{64}$/);
    expect(answer.verificationStatus).toBe('APPROVED');
  });

  it('a profile with no identity document, or only a refused one, is not accepted, and nothing changes', async () => {
    const w = makeWorld();
    const none = w.applicant({}, []);
    const other = w.applicant({}, [file('INSURANCE', 'PENDING')]);
    const refused = w.applicant({}, [file('IDENTITY', 'REJECTED')]);

    for (const profile of [none, other, refused]) {
      const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('pièce d’identité');
    }

    expect(w.profiles.rows.every((row) => row.verificationStatus === 'PENDING_REVIEW')).toBe(true);
    expect(w.users.rows.every((user) => user.isActive === false)).toBe(true);
    expect(w.mails).toEqual([]);
    expect(w.tokens.rows).toEqual([]);
  });

  it('an identity document that was approved already counts; a refused one next to an approved one does not matter', async () => {
    const w = makeWorld();
    const a = w.applicant({}, [file('IDENTITY', 'APPROVED')]);
    const b = w.applicant({}, [file('IDENTITY', 'REJECTED'), file('IDENTITY', 'PENDING')]);

    await w.service.approveArtisan(9, a.id, {} as any);
    await w.service.approveArtisan(9, b.id, {} as any);

    expect(w.profiles.rows.map((row) => row.verificationStatus)).toEqual(['APPROVED', 'APPROVED']);
  });

  it('without an identity document the waiver needs a written reason, which is kept in the notes of the profile', async () => {
    const w = makeWorld();
    const profile = w.applicant({}, []);

    const withoutReason = await failure(w.service.approveArtisan(9, profile.id, { waiveIdentityCheck: true } as any));
    const blank = await failure(w.service.approveArtisan(9, profile.id, { waiveIdentityCheck: true, note: '   ' } as any));

    expect(withoutReason.getStatus()).toBe(400);
    expect(blank.getStatus()).toBe(400);
    expect(w.profiles.rows[0].verificationStatus).toBe('PENDING_REVIEW');

    await w.service.approveArtisan(9, profile.id, { waiveIdentityCheck: true, note: 'Connu de la maison, pièce vue en agence' } as any);

    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.notes.rows).toHaveLength(1);
    expect(w.notes.rows[0]).toMatchObject({ authorId: 9, targetType: 'ARTISAN', targetId: profile.id });
    expect(w.notes.rows[0].content).toBe('Approuvé sans pièce d’identité: Connu de la maison, pièce vue en agence');
  });

  it('the waiver is not needed (and not recorded) when the document is there; a note is kept as written', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    await w.service.approveArtisan(9, profile.id, { note: 'Bon dossier', waiveIdentityCheck: true } as any);

    expect(w.notes.rows.map((note) => note.content)).toEqual(['Bon dossier']);
  });

  it('a note is not an exception: without the waiver flag a profile with no identity document is refused', async () => {
    const w = makeWorld();
    const profile = w.applicant({}, []);

    const error = await failure(w.service.approveArtisan(9, profile.id, { note: 'Je le connais personnellement' } as any));

    expect(error.getStatus()).toBe(400);
    expect(w.profiles.rows[0].verificationStatus).toBe('PENDING_REVIEW');
    expect(w.notes.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('the documents that wait are marked as checked by whoever accepted; a refused one stays refused, another applicant\'s are not touched', async () => {
    const w = makeWorld();
    const profile = w.applicant();
    const other = w.applicant();

    w.documents.insert({ artisanProfileId: profile.id, type: 'IDENTITY', status: 'PENDING' });
    w.documents.insert({ artisanProfileId: profile.id, type: 'INSURANCE', status: 'REJECTED' });
    w.documents.insert({ artisanProfileId: other.id, type: 'IDENTITY', status: 'PENDING' });

    await w.service.approveArtisan(9, profile.id, {} as any);

    expect(w.documents.rows.map((doc) => doc.status)).toEqual(['APPROVED', 'REJECTED', 'PENDING']);
    expect(w.documents.rows[0].reviewedById).toBe(9);
    expect(w.documents.rows[2].reviewedById).toBeUndefined();
  });

  it('an artisan who is approved already is a 400: no second invitation, no second link', async () => {
    const w = makeWorld();
    const profile = w.applicant({ verificationStatus: 'APPROVED' });

    const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('déjà approuvé');
    expect(w.mails).toEqual([]);
    expect(w.tokens.rows).toEqual([]);
  });

  it('a suspended artisan is reactivated, not approved', async () => {
    const w = makeWorld();
    const profile = w.applicant({ verificationStatus: 'SUSPENDED' });

    const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('réactivez');
  });

  it('an application that was refused can be looked at again and accepted: the reason is cleared', async () => {
    const w = makeWorld();
    const profile = w.applicant({ verificationStatus: 'REJECTED', rejectionReason: 'Pièce illisible' });

    await w.service.approveArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'APPROVED', rejectionReason: null });
  });
});

describe('refusing an application (P1-11)', () => {
  it('needs a reason; the applicant is told it, it stays on the profile, and the account stays shut', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    await w.service.rejectArtisan(9, profile.id, { reason: '  Pièce d’identité illisible, merci de nous contacter  ' } as any);

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'REJECTED', rejectionReason: 'Pièce d’identité illisible, merci de nous contacter' });
    expect(w.users.rows[0].isActive).toBe(false);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0].subject).toBe('Candidature artisan refusée');
    expect(w.mails[0].content).toContain('Motif: Pièce d’identité illisible, merci de nous contacter');
    // refusing sends no link
    expect(w.tokens.rows).toEqual([]);
  });

  it('the applicant reads the refusal in the language they applied in (P3-04): Arabic when their account says so, French otherwise', async () => {
    const w = makeWorld();
    const french = w.applicant();
    const arabic = w.applicant();

    w.users.rows.find((user) => user.id === arabic.userId)!.locale = 'ar';

    await w.service.rejectArtisan(9, french.id, { reason: 'Pièce illisible' } as any);
    await w.service.rejectArtisan(9, arabic.id, { reason: 'صورة غير واضحة' } as any);

    expect(w.mails[0].subject).toBe('Candidature artisan refusée');
    expect(w.mails[1].subject).toBe('تم رفض طلب الانضمام');
    expect(w.mails[1].content).toContain('صورة غير واضحة');
    expect(/[؀-ۿ]/.test(w.mails[0].content)).toBe(false);
  });

  it('no reason, a blank one, or a few letters is a 400 and nothing changes', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    for (const dto of [{}, { reason: '' }, { reason: '    ' }, { reason: 'non' }, { reason: 42 }]) {
      expect((await failure(w.service.rejectArtisan(9, profile.id, dto as any))).getStatus()).toBe(400);
    }

    expect(w.profiles.rows[0].verificationStatus).toBe('PENDING_REVIEW');
    expect(w.mails).toEqual([]);
  });

  it('only an application that waits can be refused: an approved artisan is suspended instead', async () => {
    const w = makeWorld();

    for (const verificationStatus of ['APPROVED', 'REJECTED', 'SUSPENDED']) {
      const profile = w.applicant({ verificationStatus });
      const error = await failure(w.service.rejectArtisan(9, profile.id, { reason: 'Motif valable' } as any));

      expect(error.getStatus()).toBe(400);
    }

    expect(w.mails).toEqual([]);
  });
});

describe('adding a technician by hand (P1-11)', () => {
  const dto = (extra: Record<string, unknown> = {}) =>
    ({ name: 'Sami', email: 'sami@mail.tn', phone: '55 222 333', specialties: ['Plomberie'], yearsExperience: 3, ...extra }) as any;

  it('is an invitation: the artisan exists at once, approved, with the zones picked from the list, and gets the link', async () => {
    const w = makeWorld();

    const answer: any = await w.service.createArtisanManually(9, dto({ zoneIds: [1] }));

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'APPROVED', isAcceptingJobs: true, verifiedById: 9, serviceTypes: ['PLOMBIER'] });
    expect(w.users.rows[0]).toMatchObject({ role: 'ARTISAN', isActive: true });
    expect(w.zones.rows.map((zone) => [zone.label, zone.latitude, zone.radiusKm, zone.adminZoneId])).toEqual([['Tunis', 36.8, 20, 1]]);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0].subject).toBe('Création de votre mot de passe');
    expect(w.texts).toHaveLength(1);
    expect(answer.passwordSetupUrl).toBeUndefined();
  });

  it('while the mails are simulated the link is in the answer', async () => {
    const w = makeWorld({ simulated: true });

    const answer: any = await w.service.createArtisanManually(9, dto());

    expect(answer.passwordSetupUrl).toMatch(/\/reset-password\?token=[0-9a-f]{64}$/);
    expect(answer.profile.id).toBe(w.profiles.rows[0].id);
  });

  it('with no zone the artisan is not limited to a place', async () => {
    const w = makeWorld();

    await w.service.createArtisanManually(9, dto());

    expect(w.zones.rows).toEqual([]);
    expect(w.profiles.rows).toHaveLength(1);
  });

  it('a zone that is switched off or unknown is a 400 before anything is made', async () => {
    const w = makeWorld();

    for (const zoneIds of [[2], [99]]) {
      expect((await failure(w.service.createArtisanManually(9, dto({ zoneIds })))).getStatus()).toBe(400);
    }

    expect(w.users.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('a number that cannot be one is a 400 pointing at the number, and nothing is made', async () => {
    const w = makeWorld();

    const error = await failure(w.service.createArtisanManually(9, dto({ phone: 'call me' })));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Numéro de téléphone invalide');
    expect(w.users.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('a number already on another account is refused whatever the spelling', async () => {
    const w = makeWorld();

    w.users.insert({ email: 'client@mail.tn', role: 'CLIENT', phone: '55 222 333', phoneKey: '+21655222333' });

    const error = await failure(w.service.createArtisanManually(9, dto({ email: 'other@mail.tn', phone: '+216 55 222 333' })));

    expect(error.getStatus()).toBe(400);
    expect(w.profiles.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('the database refusing the number at the last moment (two invitations at once) is a 409, and no link is sent', async () => {
    const w = makeWorld();
    const realFindFirst = w.users.findFirst.bind(w.users);

    w.users.findFirst = async () => {
      w.users.findFirst = realFindFirst;
      w.users.insert({ email: 'racer@mail.tn', phone: '55 222 333', phoneKey: '+21655222333' });

      return null;
    };

    const error = await failure(w.service.createArtisanManually(9, dto()));

    expect(error.getStatus()).toBe(409);
    expect(w.profiles.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('an e-mail that is taken is a 400, and no link is sent', async () => {
    const w = makeWorld();

    await w.service.createArtisanManually(9, dto());
    const mails = w.mails.length;

    const error = await failure(w.service.createArtisanManually(9, dto({ phone: '55 999 888' })));

    expect(error.getStatus()).toBe(400);
    expect(w.mails.length).toBe(mails);
  });
});

describe('only a file of the platform counts as an identity document (P1-11)', () => {
  it('an address typed by the applicant (the older form), a broken one, or none is not an identity document', async () => {
    const w = makeWorld();
    const typed = w.applicant({}, [file('IDENTITY', 'PENDING', 'https://example.com/cin.jpg')]);
    const broken = w.applicant({}, [file('IDENTITY', 'PENDING', '/files/abc/download')]);
    const missing = w.applicant({}, [file('IDENTITY', 'PENDING', null)]);

    for (const profile of [typed, broken, missing]) {
      const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('pièce d’identité');
    }

    expect(w.profiles.rows.every((row) => row.verificationStatus === 'PENDING_REVIEW')).toBe(true);
    expect(w.mails).toEqual([]);
  });

  it('the written exception still lets such an application through', async () => {
    const w = makeWorld();
    const profile = w.applicant({}, [file('IDENTITY', 'PENDING', 'https://example.com/cin.jpg')]);

    await w.service.approveArtisan(9, profile.id, { waiveIdentityCheck: true, note: 'Pièce vue en agence' } as any);

    expect(w.profiles.rows[0].verificationStatus).toBe('APPROVED');
    expect(w.notes.rows[0].content).toBe('Approuvé sans pièce d’identité: Pièce vue en agence');
  });

  it('both spellings of the download route count', async () => {
    const w = makeWorld();
    const a = w.applicant({}, [file('IDENTITY', 'PENDING', '/files/7/download')]);
    const b = w.applicant({}, [file('IDENTITY', 'PENDING', '/api/files/8/download')]);

    await w.service.approveArtisan(9, a.id, {} as any);
    await w.service.approveArtisan(9, b.id, {} as any);

    expect(w.profiles.rows.map((row) => row.verificationStatus)).toEqual(['APPROVED', 'APPROVED']);
  });
});

/** Another member of the team decides between the moment the profile is read and the moment it is written. */
function changeAfterRead(w: ReturnType<typeof makeWorld>, to: string) {
  const read = (w.service as any).getArtisanDetail;

  (w.service as any).getArtisanDetail = async (profileId: number) => {
    const seen = await read(profileId);

    w.profiles.rows.find((row) => row.id === profileId)!.verificationStatus = to;

    return seen;
  };
}

describe('two decisions on the same profile at once (P1-11)', () => {
  it('accepting an application that was refused a moment ago is a 409: nothing opens, nothing is sent', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    changeAfterRead(w, 'REJECTED');

    const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

    expect(error.getStatus()).toBe(409);
    expect(w.profiles.rows[0].verificationStatus).toBe('REJECTED');
    expect(w.users.rows[0].isActive).toBe(false);
    expect(w.documents.rows).toEqual([]);
    expect(w.mails).toEqual([]);
    expect(w.texts).toEqual([]);
    expect(w.tokens.rows).toEqual([]);
    expect(w.notes.rows).toEqual([]);
  });

  it('refusing an application that was accepted a moment ago is a 409: the account stays open, no refusal mail', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    w.users.rows[0].isActive = true;
    changeAfterRead(w, 'APPROVED');

    const error = await failure(w.service.rejectArtisan(9, profile.id, { reason: 'Pièce illisible' } as any));

    expect(error.getStatus()).toBe(409);
    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'APPROVED' });
    expect(w.profiles.rows[0].rejectionReason).toBeUndefined();
    expect(w.users.rows[0].isActive).toBe(true);
    expect(w.mails).toEqual([]);
  });

  it('two acceptances at once: the second is the one that fails, and only one link is made', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    changeAfterRead(w, 'APPROVED'); // the first member's write lands before the second's

    const error = await failure(w.service.approveArtisan(9, profile.id, {} as any));

    expect(error.getStatus()).toBe(409);
    expect(w.tokens.rows).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('the message says what happened', async () => {
    const w = makeWorld();
    const profile = w.applicant();

    changeAfterRead(w, 'REJECTED');

    expect((await failure(w.service.approveArtisan(9, profile.id, {} as any))).message).toContain('un autre membre de l’équipe');
  });
});

describe('suspending and reactivating (P1-11)', () => {
  it('only an approved artisan is suspended: a pending, refused or already suspended profile is a 400 and nothing changes', async () => {
    const w = makeWorld();

    for (const verificationStatus of ['PENDING_REVIEW', 'REJECTED', 'SUSPENDED']) {
      const profile = w.applicant({ verificationStatus });
      const error = await failure(w.service.suspendArtisan(9, profile.id, {} as any));

      expect(error.getStatus()).toBe(400);
      expect(w.profiles.rows.find((row) => row.id === profile.id)!.verificationStatus).toBe(verificationStatus);
    }

    expect(w.notes.rows).toEqual([]);
  });

  it('only a suspended artisan is reactivated: a pending or refused application cannot be opened this way', async () => {
    const w = makeWorld();

    for (const verificationStatus of ['PENDING_REVIEW', 'REJECTED', 'APPROVED']) {
      const profile = w.applicant({ verificationStatus });
      const error = await failure(w.service.reactivateArtisan(9, profile.id, {} as any));

      expect(error.getStatus()).toBe(400);
      expect(w.profiles.rows.find((row) => row.id === profile.id)!.verificationStatus).toBe(verificationStatus);
    }

    // none of the accounts was opened, and no identity check was skipped
    expect(w.users.rows.every((user) => user.isActive === false)).toBe(true);
    expect(w.notes.rows).toEqual([]);
  });

  it('an approved artisan is suspended and the account shut; a suspended one comes back with missions on', async () => {
    const w = makeWorld();
    const profile = w.applicant({ verificationStatus: 'APPROVED', isAcceptingJobs: true });

    w.users.rows[0].isActive = true;

    await w.service.suspendArtisan(9, profile.id, { note: 'Plaintes' } as any);

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'SUSPENDED', isAcceptingJobs: false, rejectionReason: 'Plaintes' });
    expect(w.users.rows[0].isActive).toBe(false);

    await w.service.reactivateArtisan(9, profile.id, {} as any);

    expect(w.profiles.rows[0]).toMatchObject({ verificationStatus: 'APPROVED', isAcceptingJobs: true, rejectionReason: null });
    expect(w.users.rows[0].isActive).toBe(true);
    expect(w.notes.rows.map((note) => note.content)).toEqual(['Plaintes', 'Artisan réactivé.']);
  });

  it('a decision made in between is a 409: nothing is changed and no note is written', async () => {
    const w = makeWorld();
    const approved = w.applicant({ verificationStatus: 'APPROVED' });

    changeAfterRead(w, 'SUSPENDED');
    expect((await failure(w.service.suspendArtisan(9, approved.id, {} as any))).getStatus()).toBe(409);

    const w2 = makeWorld();
    const suspended = w2.applicant({ verificationStatus: 'SUSPENDED' });

    changeAfterRead(w2, 'APPROVED');
    expect((await failure(w2.service.reactivateArtisan(9, suspended.id, {} as any))).getStatus()).toBe(409);

    expect(w.notes.rows).toEqual([]);
    expect(w2.notes.rows).toEqual([]);
    expect(w2.users.rows[0].isActive).toBe(false);
  });
});
