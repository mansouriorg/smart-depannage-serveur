import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { FilesService } from '../files/files.service';
import { ArtisansService } from './artisans.service';

const ARABIC = /[؀-ۿ]/;

/**
 * The technician who applies is written to in the language the form was shown in (P3-04): the account opens in it, the e-mail and the
 * text that confirm the application are written in it. No language: French, as before. An account that already exists keeps its own.
 */
async function makeWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apply-locale-spec-'));

  const profiles = new FakeTable({ unique: ['userId'], defaults: () => ({ specialty: null, specialties: [], serviceTypes: [], verificationStatus: 'PENDING_REVIEW' }) });
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    honourSelect: true,
    defaults: () => ({ isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null, locale: 'fr' }),
    include: { artisanProfile: (row) => profiles.rows.find((profile) => profile.userId === row.id) },
  });
  const documents = new FakeTable();
  const assets = new FakeTable();
  const zones = new FakeTable();
  const platform = new FakeTable();

  platform.insert({ name: 'Tunis', city: 'Tunis', postalCode: null, latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  platform.insert({ name: 'Sfax', city: 'Sfax', postalCode: null, latitude: 34.7, longitude: 10.8, radiusKm: 30, isActive: true });

  const prisma: any = withTransactions(
    { user: users, artisanProfile: profiles, artisanDocument: documents, fileAsset: assets, adminServiceZone: platform, artisanServiceZone: zones },
    [users, profiles, documents, assets, zones],
  );

  const sent: any[] = [];
  const notifications: any = {
    sendEmail: async (...args: any[]) => (sent.push(['email', ...args]), { queued: true }),
    sendSms: async (...args: any[]) => (sent.push(['sms', ...args]), { queued: true }),
    notifyArtisanApplication: async () => undefined,
  };
  const files = new FilesService(prisma, {} as any);
  (files as any).uploadRoot = root;

  const service = new ArtisansService(prisma, notifications, {} as any, { allowSendTo: () => true } as any, {} as any, files);

  return { service, users, sent };
}

const form = (over: Record<string, unknown> = {}) =>
  ({ name: 'Sami Ben Salah', email: 'sami@mail.tn', phone: '55 222 333', specialties: ['Plomberie', 'Électricité'], yearsExperience: 4, zoneIds: [1, 2], ...over }) as any;

const pdf = (name = 'cin.pdf') =>
  ({ originalname: name, mimetype: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20)]), size: 309 }) as any;

describe('a technician’s application, in the language of the form (P3-04)', () => {
  it('Arabic: the account opens in Arabic and the confirmation mail and text are Arabic', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() }, 'ar');

    expect(w.users.rows[0].locale).toBe('ar');

    const [mail] = w.sent.filter((entry) => entry[0] === 'email');
    const [text] = w.sent.filter((entry) => entry[0] === 'sms');

    expect(mail[2]).toBe('تم استلام طلب الانضمام');
    expect(ARABIC.test(mail[3])).toBe(true);
    expect(ARABIC.test(text[2])).toBe(true);
    expect(text[2]).toContain('Smart-Dépannage');
  });

  it('French: the mail and the text it always was, and the account stays French', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() }, 'fr');

    expect(w.users.rows[0].locale).toBe('fr');

    const [mail] = w.sent.filter((entry) => entry[0] === 'email');
    const [text] = w.sent.filter((entry) => entry[0] === 'sms');

    expect(mail.slice(2)).toEqual(['Candidature artisan reçue', 'Votre candidature artisan a bien été reçue. Notre équipe va l’examiner.']);
    expect(text.slice(2)).toEqual(['Smart Dépannage: votre candidature artisan a bien été reçue.']);
  });

  it('no language: French, and the account starts in French', async () => {
    const w = await makeWorld();

    await w.service.apply(form(), { identity: pdf() });

    expect(w.users.rows[0].locale).toBe('fr');
    expect(w.sent.filter((entry) => entry[0] === 'email')[0][2]).toBe('Candidature artisan reçue');
  });
});
