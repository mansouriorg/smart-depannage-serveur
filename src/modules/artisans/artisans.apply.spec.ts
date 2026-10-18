import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { FilesService } from '../files/files.service';
import { ArtisansService } from './artisans.service';

/**
 * P1-11: an application is one request. The account (inactive), the profile (waiting for review),
 * the zones picked from the platform's list and the documents are made together, with the real
 * files service writing the files; a refused application leaves nothing, in the database or on
 * the disk.
 */

type Options = {
  /** Makes the zones fail after the account and the profile were written, to see everything undone. */
  zonesFail?: boolean;
  notifyAdminsFails?: boolean;
  /** Destinations the rate limit refuses, by kind ('email' / 'sms'). */
  refuseSendTo?: Array<'email' | 'sms'>;
};

async function makeWorld(options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apply-spec-'));

  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({ specialty: null, specialties: [], serviceTypes: [], verificationStatus: 'PENDING_REVIEW' }),
  });
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
    include: { artisanProfile: (row) => profiles.rows.find((profile) => profile.userId === row.id) },
  });
  const documents = new FakeTable();
  const assets = new FakeTable();
  const zones = new FakeTable();
  const platform = new FakeTable();

  platform.insert({ name: 'Tunis', city: 'Tunis', postalCode: null, latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  platform.insert({ name: 'Sfax', city: 'Sfax', postalCode: null, latitude: 34.7, longitude: 10.8, radiusKm: 30, isActive: true });
  platform.insert({ name: 'Off', city: null, postalCode: null, latitude: 35, longitude: 10, radiusKm: 10, isActive: false });
  platform.insert({ name: 'Typed', city: null, postalCode: null, latitude: null, longitude: null, radiusKm: 10, isActive: true });

  const prisma: any = withTransactions(
    {
      user: users,
      artisanProfile: profiles,
      artisanDocument: documents,
      fileAsset: assets,
      adminServiceZone: platform,
      artisanServiceZone: options.zonesFail
        ? { createMany: async () => { throw new Error('zones table down'); } }
        : zones,
    },
    [users, profiles, documents, assets, zones],
  );

  const sent: any[] = [];
  const toTheBackOffice: any[] = [];
  const notifications: any = {
    sendEmail: async (...args: any[]) => (sent.push(['email', ...args]), { queued: true }),
    sendSms: async (...args: any[]) => (sent.push(['sms', ...args]), { queued: true }),
    notifyArtisanApplication: async (params: any) => {
      if (options.notifyAdminsFails) throw new Error('admins lookup down');
      toTheBackOffice.push(params);
    },
  };
  const files = new FilesService(prisma, {} as any);
  (files as any).uploadRoot = root;

  const service = new ArtisansService(prisma, notifications, {} as any, { allowSendTo: (kind: 'email' | 'sms') => !(options.refuseSendTo ?? []).includes(kind) } as any, {} as any, files);

  const stored = async () => {
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else found.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
      }
    };

    await walk(root);

    return found.sort();
  };

  return { service, users, profiles, documents, assets, zones, sent, toTheBackOffice, stored, platform };
}

const form = (over: Record<string, unknown> = {}) =>
  ({
    name: 'Sami Ben Salah',
    email: 'sami@mail.tn',
    phone: '55 222 333',
    specialties: ['Plomberie', 'Électricité'],
    yearsExperience: 4,
    zoneIds: [1, 2],
    ...over,
  }) as any;

const pdf = (name = 'cin.pdf') =>
  ({
    originalname: name,
    mimetype: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20)]),
    size: 309,
  }) as any;

async function picture(name = 'assurance.jpg') {
  const buffer = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#336699' } }).jpeg().toBuffer();

  return { originalname: name, mimetype: 'image/jpeg', buffer, size: buffer.length } as any;
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('an application with its documents and zones (P1-11)', () => {
  it('makes an inactive account, a profile waiting for review, the zones copied from the list and the documents waiting for the back office', async () => {
    const w = await makeWorld();

    const answer = await w.service.apply(form(), { identity: pdf(), company: pdf('kbis.pdf'), insurance: await picture() });

    const user = w.users.rows[0];
    const profile = w.profiles.rows[0];

    expect(user).toMatchObject({ role: 'ARTISAN', isActive: false, email: 'sami@mail.tn' });
    expect(profile).toMatchObject({ userId: user.id, verificationStatus: 'PENDING_REVIEW', specialties: ['Plombier', 'Électricien'], serviceTypes: ['PLOMBIER', 'ELECTRICIEN'] });
    expect(answer.profile.id).toBe(profile.id);

    // the zones: the centre and the radius of the platform's zone, and the link to it
    expect(w.zones.rows.map((zone) => [zone.artisanProfileId, zone.label, zone.latitude, zone.longitude, zone.radiusKm, zone.adminZoneId, zone.isActive])).toEqual([
      [profile.id, 'Tunis', 36.8, 10.2, 20, 1, true],
      [profile.id, 'Sfax', 34.7, 10.8, 30, 2, true],
    ]);

    // the documents: three, waiting, each with its private file for the new account
    expect(w.documents.rows.map((doc) => [doc.type, doc.status, doc.artisanProfileId])).toEqual([
      ['IDENTITY', 'PENDING', profile.id],
      ['COMPANY_LEGAL', 'PENDING', profile.id],
      ['INSURANCE', 'PENDING', profile.id],
    ]);
    expect(w.assets.rows.map((asset) => [asset.purpose, asset.visibility, asset.entityType, asset.entityId, asset.uploadedById])).toEqual([
      ['IDENTITY_DOCUMENT', 'PRIVATE', 'ARTISAN_PROFILE', profile.id, user.id],
      ['ARTISAN_DOCUMENT', 'PRIVATE', 'ARTISAN_PROFILE', profile.id, user.id],
      ['INSURANCE_CERTIFICATE', 'PRIVATE', 'ARTISAN_PROFILE', profile.id, user.id],
    ]);
    expect(w.documents.rows.map((doc) => doc.fileUrl)).toEqual(w.assets.rows.map((asset) => `/files/${asset.id}/download`));
    expect((await w.stored()).length).toBe(3);
    expect((await w.stored()).every((file) => file.startsWith('private/'))).toBe(true);
  });

  it('only the identity document is required: a form with it alone makes one document', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() });

    expect(w.documents.rows.map((doc) => doc.type)).toEqual(['IDENTITY']);
    expect((await w.stored()).length).toBe(1);
  });

  it('the applicant is thanked, and the back office is told there is an application to look at', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() });

    expect(w.sent.map((message) => message[0])).toEqual(['email', 'sms']);
    expect(w.toTheBackOffice).toEqual([{ profileId: w.profiles.rows[0].id, name: 'Sami Ben Salah', trades: ['Plombier', 'Électricien'] }]);
  });

  it('a destination that has had its share of messages this hour is not written to again, and the application still goes through', async () => {
    const noMail = await makeWorld({ refuseSendTo: ['email'] });
    await noMail.service.apply(form(), { identity: pdf() });
    expect(noMail.sent.map((message) => message[0])).toEqual(['sms']);
    expect(noMail.profiles.rows).toHaveLength(1);

    const noText = await makeWorld({ refuseSendTo: ['sms'] });
    await noText.service.apply(form(), { identity: pdf() });
    expect(noText.sent.map((message) => message[0])).toEqual(['email']);
    expect(noText.profiles.rows).toHaveLength(1);
  });

  it('a failure while telling the back office does not undo the application', async () => {
    const w = await makeWorld({ notifyAdminsFails: true });

    await w.service.apply(form(), { identity: pdf() });

    expect(w.profiles.rows).toHaveLength(1);
    expect(w.sent.map((message) => message[0])).toEqual(['email', 'sms']);
  });

  it('no identity document: a 400 that says so, and nothing is made or stored', async () => {
    const w = await makeWorld();

    for (const documents of [{}, { company: pdf() }, { insurance: await picture() }]) {
      const error = await failure(w.service.apply(form(), documents));

      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('pièce d’identité est obligatoire');
    }

    expect(w.users.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a document that is not what it says it is: a 400 naming the document, and the others sent with it are not stored either', async () => {
    const w = await makeWorld();
    const fake = { ...pdf('cin.pdf'), buffer: Buffer.from('<html><script>alert(1)</script></html>') };

    const error = await failure(w.service.apply(form(), { identity: pdf(), company: fake }));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Document de l’entreprise');
    expect(w.users.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a document over 5 MB or of another type is a 400', async () => {
    const w = await makeWorld();

    expect((await failure(w.service.apply(form(), { identity: { ...pdf(), size: 6 * 1024 * 1024 } }))).getStatus()).toBe(400);
    expect((await failure(w.service.apply(form(), { identity: { ...pdf(), mimetype: 'application/zip' } }))).getStatus()).toBe(400);
    expect(await w.stored()).toEqual([]);
  });

  it('the zones must be in the platform\'s list, switched on and drawn: an unknown, a switched-off or a centreless zone is a 400', async () => {
    const w = await makeWorld();

    for (const zoneIds of [[99], [1, 3], [4]]) {
      const error = await failure(w.service.apply(form({ zoneIds }), { identity: pdf() }));

      expect(error.getStatus()).toBe(400);
    }

    expect((await failure(w.service.apply(form({ zoneIds: [] }), { identity: pdf() }))).message).toContain('au moins une zone');
    expect(w.users.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a zone picked twice is one zone', async () => {
    const w = await makeWorld();

    await w.service.apply(form({ zoneIds: [2, 2, 1] }), { identity: pdf() });

    expect(w.zones.rows.map((zone) => zone.label)).toEqual(['Sfax', 'Tunis']);
  });

  it('a failure while the rows are written undoes the account and takes the stored files away', async () => {
    const w = await makeWorld({ zonesFail: true });

    const error = await failure(w.service.apply(form(), { identity: pdf(), insurance: await picture() }));

    expect(error.message).toContain('zones table down');
    expect(w.users.rows).toHaveLength(0);
    expect(w.profiles.rows).toHaveLength(0);
    expect(w.documents.rows).toHaveLength(0);
    expect(w.assets.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it('the same person cannot apply twice, and the second try stores nothing', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() });

    const before = await w.stored();
    const error = await failure(w.service.apply(form(), { identity: pdf() }));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('existe déjà');
    expect(w.profiles.rows).toHaveLength(1);
    expect(await w.stored()).toEqual(before);
  });

  it('an e-mail that belongs to a client account is refused', async () => {
    const w = await makeWorld();

    w.users.insert({ email: 'sami@mail.tn', role: 'CLIENT' });

    const error = await failure(w.service.apply(form(), { identity: pdf() }));

    expect(error.getStatus()).toBe(400);
    expect(w.profiles.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a number that cannot be one is a 400 before any file is kept', async () => {
    const w = await makeWorld();

    const error = await failure(w.service.apply(form({ phone: 'call me' }), { identity: pdf() }));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Numéro de téléphone invalide');
    expect(w.users.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a number already on another account is refused whatever the spelling, and nothing is stored', async () => {
    const w = await makeWorld();

    w.users.insert({ email: 'client@mail.tn', role: 'CLIENT', phone: '55 222 333', phoneKey: '+21655222333' });

    const error = await failure(w.service.apply(form({ email: 'other@mail.tn', phone: '+216 55222333' }), { identity: pdf() }));

    expect(error.getStatus()).toBe(400);
    expect(w.profiles.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('two applications for the same e-mail at once: the database refuses the second with a 409, its files are taken away', async () => {
    const w = await makeWorld();
    const realFindFirst = w.users.findFirst.bind(w.users);

    // the lookup sees nobody, then somebody else gets the e-mail before the insert
    w.users.findFirst = async () => {
      w.users.findFirst = realFindFirst;
      w.users.insert({ email: 'sami@mail.tn', role: 'ARTISAN' });

      return null;
    };

    const error = await failure(w.service.apply(form(), { identity: pdf(), insurance: await picture() }));

    expect(error.getStatus()).toBe(409);
    expect(w.profiles.rows).toHaveLength(0);
    expect(w.documents.rows).toHaveLength(0);
    expect(await w.stored()).toEqual([]);
  });

  it('a trade that is not in the table is refused before anything is stored', async () => {
    const w = await makeWorld();

    const error = await failure(w.service.apply(form({ specialties: ['Sorcier'] }), { identity: pdf() }));

    expect(error.getStatus()).toBe(400);
    expect(await w.stored()).toEqual([]);
  });
});
