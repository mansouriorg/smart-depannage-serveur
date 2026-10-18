import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

import { FilesService } from './files.service';

async function makeWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-spec-'));
  const assets: any[] = [];
  const interventions: any[] = [{ id: 7, clientId: 70, photos: [] as string[] }];
  const events: any[] = [];

  const prisma: any = {
    fileAsset: {
      create: async ({ data }: any) => {
        const row = { id: assets.length + 1, ...data };
        assets.push(row);

        return row;
      },
    },
    intervention: {
      update: async ({ where, data }: any) => {
        const row = interventions.find((item) => item.id === where.id)!;
        if (data.photos?.push) row.photos.push(data.photos.push);

        return row;
      },
    },
  };

  const service = new FilesService(prisma, { create: async (event: any) => events.push(event) } as any);
  (service as any).uploadRoot = root;

  return { service, root, assets, interventions, events };
}

const upload = (buffer: Buffer, mimetype = 'image/jpeg', size = buffer.length) =>
  ({ originalname: 'photo', mimetype, size, buffer }) as any;

async function jpeg(width = 40, height = 30) {
  return sharp({ create: { width, height, channels: 3, background: '#cc3333' } })
    .jpeg()
    .toBuffer();
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('a photo from the holder of a tracking link (P1-04)', () => {
  it('is stored private, re-encoded, for the guest profile, and added to the request', async () => {
    const w = await makeWorld();

    const asset = await w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(await jpeg()));

    expect(asset.uploadedById).toBe(70);
    expect(asset.visibility).toBe('PRIVATE');
    expect(asset.publicUrl).toBe(undefined);
    expect(asset.purpose).toBe('CLIENT_DAMAGE_PHOTO');
    expect(asset.entityType).toBe('INTERVENTION');
    expect(asset.entityId).toBe(7);
    expect(asset.mimeType).toBe('image/webp');
    expect(w.interventions[0].photos).toEqual([`/files/${asset.id}/download`]);
    expect(w.events.length).toBe(1);
    expect(w.events[0].createdById).toBe(70);

    const onDisk = await fs.readFile(path.join(w.root, asset.relativePath));
    expect((await sharp(onDisk).metadata()).format).toBe('webp');
  });

  it('keeps no metadata of the original (a phone photo carries the GPS position)', async () => {
    const w = await makeWorld();
    const withExif = await sharp(await jpeg())
      .withExif({ IFD0: { Copyright: 'Somebody' } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif !== undefined).toBe(true);

    const asset = await w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(withExif));
    const stored = await sharp(await fs.readFile(path.join(w.root, asset.relativePath))).metadata();

    expect(stored.exif).toBe(undefined);
  });

  it('refuses a file that says it is an image and is not one (text, SVG, a script)', async () => {
    const w = await makeWorld();

    // The image library would happily decode an SVG or a GIF whatever the declared
    // type says (checked), so only the first bytes keep them out.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    );
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

    expect((await sharp(svg).webp().toBuffer()).length > 0).toBe(true);
    expect((await sharp(gif).webp().toBuffer()).length > 0).toBe(true);

    for (const body of [svg, gif, Buffer.from('<?php system($_GET["c"]); ?>'), Buffer.from('just text')]) {
      const error = await failure(w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(body, 'image/png')));

      expect(error.status).toBe(400);
    }

    expect(w.assets.length).toBe(0);
    expect(w.interventions[0].photos).toEqual([]);
  });

  it('refuses an empty file and a type that is not JPEG, PNG or WebP', async () => {
    const w = await makeWorld();

    expect((await failure(w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(Buffer.alloc(0))))).status).toBe(400);
    expect(
      (await failure(w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(await jpeg(), 'image/gif')))).status,
    ).toBe(400);
    expect(
      (await failure(w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(await jpeg(), 'application/pdf')))).status,
    ).toBe(400);
  });

  it('refuses more than 5 MB', async () => {
    const w = await makeWorld();

    const error = await failure(
      w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(await jpeg(), 'image/jpeg', 5 * 1024 * 1024 + 1)),
    );

    expect(error.status).toBe(400);
  });

  it('a damaged picture is a 400, not a server error', async () => {
    const w = await makeWorld();
    const damaged = Buffer.concat([(await jpeg()).subarray(0, 30), Buffer.alloc(50, 7)]);

    const error = await failure(w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(damaged)));

    expect(error.status).toBe(400);
    expect(w.assets.length).toBe(0);
  });

  it('a picture with more pixels than allowed is refused before it is decoded', async () => {
    const w = await makeWorld();

    const error = await failure(
      (w.service as any).processImageIfNeeded(upload(await jpeg(200, 100)), true, 1000),
    );

    expect(error.status).toBe(400);
    // and the same picture is fine with the usual ceiling
    expect(((await (w.service as any).processImageIfNeeded(upload(await jpeg(200, 100)), true, 50_000_000)) as any).width).toBe(200);
  });
});

describe('pictures from visitors are decoded two at a time, within a pixel ceiling (P1-04 review)', () => {
  it('never more than two decodes at once, however many calls arrive', async () => {
    const w = await makeWorld();
    let running = 0;
    let peak = 0;
    let ceiling: number | undefined;

    (w.service as any).createFileAsset = async (_user: any, _file: any, options: any) => {
      ceiling = options.maxInputPixels;
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;

      return { id: 1, publicUrl: undefined, purpose: 'CLIENT_DAMAGE_PHOTO' };
    };

    await Promise.all(
      Array.from({ length: 8 }, () => w.service.uploadGuestDamagePhoto({ id: 7, clientId: 70 }, upload(Buffer.from('x')))),
    );

    expect(peak).toBe(2);
    expect(ceiling).toBe(30_000_000);
  });
});

describe('the signature check protects the other uploads too', () => {
  it('a real PNG and a real WebP pass, whatever type was declared', async () => {
    const w = await makeWorld();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).webp().toBuffer();

    expect((w.service as any).hasImageSignature(png)).toBe(true);
    expect((w.service as any).hasImageSignature(webp)).toBe(true);
    expect((w.service as any).hasImageSignature(await jpeg())).toBe(true);
    expect((w.service as any).hasImageSignature(Buffer.from('GIF89a......'))).toBe(false);
    expect((w.service as any).hasImageSignature(Buffer.from('RIFF....WAVE'))).toBe(false);
    expect((w.service as any).hasImageSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe('proof photos in the files module (P1-07)', () => {
  const staff = { id: 20, role: 'ADMIN' as any };
  const artisan = { id: 7, role: 'ARTISAN' as any };

  function withAsset(purpose: string, visibility = 'PRIVATE') {
    const asset = { id: 5, uploadedById: 7, purpose, visibility, relativePath: 'private/x/y.webp', isDeleted: false, isImage: true, mimeType: 'image/webp' };
    const prisma: any = { fileAsset: { findUnique: async () => asset, update: async () => asset } };
    const service = new FilesService(prisma, { create: async () => undefined } as any);

    return { service, asset };
  }

  it('a proof cannot be deleted, not even by the artisan who sent it or by the back office', async () => {
    for (const purpose of ['ARTISAN_BEFORE_PHOTO', 'ARTISAN_AFTER_PHOTO']) {
      for (const user of [artisan, staff]) {
        const { service } = withAsset(purpose);
        const error = await failure(service.deleteFile(user, 5));

        expect(error.getStatus()).toBe(403);
        expect(String(error.message)).toMatch(/preuve/);
      }
    }
  });

  it('a proof cannot be replaced', async () => {
    for (const user of [artisan, staff]) {
      const { service } = withAsset('ARTISAN_AFTER_PHOTO');
      const error = await failure(service.replaceFile(user, 5, upload(await jpeg())));

      expect(error.getStatus()).toBe(403);
    }
  });

  it('a proof cannot be made public', async () => {
    const { service } = withAsset('ARTISAN_AFTER_PHOTO');
    const error = await failure(service.setVisibility(staff, 5, 'PUBLIC' as any));

    expect(error.getStatus()).toBe(403);
    expect(String(error.message)).toMatch(/privée/);
  });

  it('the other files are deleted by their owner as before', async () => {
    const { service } = withAsset('CLIENT_DAMAGE_PHOTO');
    const asset = await service.deleteFile({ id: 7, role: 'CLIENT' as any }, 5);

    expect(asset).toBeDefined();
  });

  it('assertProofImage takes a JPEG, a PNG and a WebP, and nothing else', async () => {
    const { service } = withAsset('ARTISAN_AFTER_PHOTO');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).webp().toBuffer();

    const good = upload(await jpeg());

    expect(() => service.assertProofImage(good)).not.toThrow();
    expect(() => service.assertProofImage(upload(png, 'image/png'))).not.toThrow();
    expect(() => service.assertProofImage(upload(webp, 'image/webp'))).not.toThrow();

    expect(() => service.assertProofImage(undefined)).toThrow();
    expect(() => service.assertProofImage(upload(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml'))).toThrow();
    expect(() => service.assertProofImage(upload(Buffer.from('not a jpeg at all'), 'image/jpeg'))).toThrow();
    expect(() => service.assertProofImage(upload(Buffer.alloc(0), 'image/jpeg'))).toThrow();
    expect(() => service.assertProofImage(upload(good.buffer, 'application/pdf'))).toThrow();
  });

  it('assertProofImage refuses a file that is too big', async () => {
    const { service } = withAsset('ARTISAN_AFTER_PHOTO');
    const big = upload(await jpeg(), 'image/jpeg', 11 * 1024 * 1024);

    expect(() => service.assertProofImage(big)).toThrow();
  });

  it('stages a compressed copy in the private folder, records it in the caller\'s transaction, and takes it away on request', async () => {
    const w = await makeWorld();
    const file = upload(await jpeg(800, 600));
    const stored = await w.service.stageProofPhoto(file, 'ARTISAN_AFTER_PHOTO' as any, 7);

    expect(stored.relativePath.startsWith('private/artisan_after_photo/')).toBe(true);
    expect(stored.publicUrl).toBeUndefined();
    expect(stored.mimeType).toBe('image/webp');
    expect((await fs.stat(path.join(w.root, stored.relativePath))).isFile()).toBe(true);
    // Nothing in the database yet: the caller records it with its own transaction.
    expect(w.assets.length).toBe(0);

    const tx: any = { fileAsset: { create: async ({ data }: any) => ({ id: 31, ...data }) } };
    const asset = await w.service.recordProofAsset(tx, { id: 7, role: 'ARTISAN' as any }, file, stored, 'ARTISAN_AFTER_PHOTO' as any, 7);

    expect(asset).toMatchObject({ id: 31, uploadedById: 7, visibility: 'PRIVATE', entityType: 'INTERVENTION', entityId: 7, purpose: 'ARTISAN_AFTER_PHOTO' });

    await w.service.discardStagedPhoto(stored);

    await expect(fs.stat(path.join(w.root, stored.relativePath))).rejects.toBeDefined();
  });
});

describe('the documents of an applicant (P1-11)', () => {
  const pdf = (size?: number) => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj <<>> endobj\n'), Buffer.alloc(200, 0x20)]);

    return upload(buffer, 'application/pdf', size ?? buffer.length);
  };

  it('takes a PDF and a JPEG, a PNG and a WebP picture', async () => {
    const { service } = await makeWorld();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).webp().toBuffer();

    expect(() => service.assertApplicantDocument(pdf(), 'identity')).not.toThrow();
    expect(() => service.assertApplicantDocument(upload(Buffer.from(png), 'image/png'), 'company')).not.toThrow();
    expect(() => service.assertApplicantDocument(upload(Buffer.from(webp), 'image/webp'), 'insurance')).not.toThrow();
    // a PDF declared as a picture is not a picture
    expect(() => service.assertApplicantDocument(upload(pdf().buffer, 'image/jpeg'), 'identity')).toThrow(/image valide/);
  });

  it('a file that says it is a PDF and starts with something else is refused (a page, a script, a renamed image)', async () => {
    const { service } = await makeWorld();

    for (const bytes of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('MZ\x90\x00 executable'), await jpeg()]) {
      const error = (() => {
        try {
          service.assertApplicantDocument(upload(bytes, 'application/pdf'), 'identity');
        } catch (caught) {
          return caught as any;
        }

        return null;
      })();

      expect(error).not.toBeNull();
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('PDF');
    }
  });

  it('refuses what is missing, empty, too large (5 MB) or of another type, and says which document it is', async () => {
    const { service } = await makeWorld();

    expect(() => service.assertApplicantDocument(undefined, 'identity')).toThrow(/pièce d’identité est obligatoire/);
    expect(() => service.assertApplicantDocument(upload(Buffer.alloc(0), 'application/pdf'), 'company')).toThrow(/Document de l’entreprise/);
    expect(() => service.assertApplicantDocument(pdf(5 * 1024 * 1024 + 1), 'insurance')).toThrow(/Attestation d’assurance/);
    expect(() => service.assertApplicantDocument(upload(Buffer.from('MZ'), 'application/zip'), 'identity')).toThrow(/Type de fichier/);
    expect(() => service.assertApplicantDocument(upload(Buffer.from('<svg/>'), 'image/svg+xml'), 'identity')).toThrow(/Type de fichier/);
  });

  it('a stage goes to the private folder of its purpose, a PDF is kept as it is, a picture is re-encoded; nothing is in the database', async () => {
    const w = await makeWorld();

    const doc = await w.service.stageApplicantDocument(pdf(), 'identity');
    const picture = await w.service.stageApplicantDocument(upload(await jpeg(800, 600)), 'insurance');
    const papers = await w.service.stageApplicantDocument(pdf(), 'company');

    expect(doc.relativePath.startsWith('private/identity_document/')).toBe(true);
    expect(doc.relativePath.endsWith('.pdf')).toBe(true);
    expect(doc.mimeType).toBe('application/pdf');
    expect(picture.relativePath.startsWith('private/insurance_certificate/')).toBe(true);
    expect(picture.mimeType).toBe('image/webp');
    expect(papers.relativePath.startsWith('private/artisan_document/')).toBe(true);
    expect(doc.publicUrl).toBeUndefined();
    expect(w.assets.length).toBe(0);
  });

  it('is recorded in the transaction of the account: the file row for the new user, the document waiting for the back office', async () => {
    const w = await makeWorld();
    const file = { ...pdf(), originalname: 'cin-scan.pdf' };
    const stored = await w.service.stageApplicantDocument(file, 'identity');
    const rows: any = { assets: [], documents: [] };
    const tx: any = {
      fileAsset: { create: async ({ data }: any) => (rows.assets.push(data), { id: 41, ...data }) },
      artisanDocument: { create: async ({ data }: any) => (rows.documents.push(data), { id: 5, ...data }) },
    };

    const { asset, document } = await w.service.recordApplicantDocument(tx, { id: 90, role: 'ARTISAN' as any }, file, stored, 'identity', 12);

    expect(asset).toMatchObject({ uploadedById: 90, visibility: 'PRIVATE', entityType: 'ARTISAN_PROFILE', entityId: 12, purpose: 'IDENTITY_DOCUMENT', originalName: 'cin-scan.pdf' });
    expect(document).toMatchObject({ artisanProfileId: 12, type: 'IDENTITY', status: 'PENDING', fileUrl: '/files/41/download', fileName: 'cin-scan.pdf', mimeType: 'application/pdf' });
  });

  it('the name the visitor gave the file is cut to 120 characters, the kinds map to their document types', async () => {
    const w = await makeWorld();
    const file = { ...pdf(), originalname: `${'a'.repeat(300)}.pdf` };
    const types: string[] = [];
    const tx: any = {
      fileAsset: { create: async ({ data }: any) => ({ id: 1, ...data }) },
      artisanDocument: { create: async ({ data }: any) => (types.push(data.type), { id: 1, ...data }) },
    };

    for (const kind of ['identity', 'company', 'insurance'] as const) {
      const stored = await w.service.stageApplicantDocument(file, kind);
      const { asset } = await w.service.recordApplicantDocument(tx, { id: 90, role: 'ARTISAN' as any }, file, stored, kind, 12);

      expect(asset.originalName.length).toBe(120);
    }

    expect(types).toEqual(['IDENTITY', 'COMPANY_LEGAL', 'INSURANCE']);
  });

  it('pictures from applicants are decoded two at a time, however many applications arrive at once', async () => {
    const w = await makeWorld();
    let running = 0;
    let peak = 0;

    (w.service as any).storeLocalFile = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;

      return { relativePath: 'private/x/y.pdf', mimeType: 'application/pdf' };
    };

    await Promise.all(Array.from({ length: 8 }, () => w.service.stageApplicantDocument(pdf(), 'identity')));

    expect(peak).toBe(2);
  });
});

describe('who reads and who changes the papers of an applicant (P1-11 review)', () => {
  const asset = (extra: Record<string, unknown> = {}) => ({
    id: 5,
    uploadedById: 90,
    purpose: 'IDENTITY_DOCUMENT',
    visibility: 'PRIVATE',
    entityType: 'ARTISAN_PROFILE',
    entityId: 12,
    relativePath: 'private/x/id.webp',
    isDeleted: false,
    isImage: true,
    mimeType: 'image/webp',
    originalName: 'cin.webp',
    ...extra,
  });

  function serviceWith(row: any) {
    const prisma: any = {
      fileAsset: {
        findUnique: async () => row,
        findMany: async () => [row],
        update: async () => row,
      },
    };

    return new FilesService(prisma, { create: async () => undefined } as any);
  }

  const as = (role: string, id = 1) => ({ id, role }) as any;

  it('the team that verifies applicants reads them: admin, super admin, support', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT']) {
      const info = await serviceWith(asset()).getDownloadInfo(as(role), 5);

      expect(info.asset.id).toBe(5);
    }
  });

  it('whoever sent them reads them (the applicant once the account exists)', async () => {
    const info = await serviceWith(asset()).getDownloadInfo(as('ARTISAN', 90), 5);

    expect(info.asset.id).toBe(5);
  });

  it('a dispatcher or an accountant does not, nor does another artisan, a customer, or the same asset listed by its entity', async () => {
    for (const user of [as('DISPATCHER'), as('ACCOUNTANT'), as('ARTISAN', 91), as('CLIENT', 92)]) {
      const service = serviceWith(asset());

      expect((await failure(service.getDownloadInfo(user, 5))).getStatus()).toBe(403);
      expect((await failure(service.findOne(user, 5))).getStatus()).toBe(403);
      expect((await failure(service.findByEntity(user, 'ARTISAN_PROFILE', 12))).getStatus()).toBe(403);
    }
  });

  it('the other private files are still read by every back-office role', async () => {
    const photo = asset({ entityType: 'COMPLAINT_PROOF_X', entityId: null, purpose: 'CLIENT_DAMAGE_PHOTO' });

    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT']) {
      expect((await serviceWith(photo).getDownloadInfo(as(role), 5)).asset.id).toBe(5);
    }
  });

  it('a public file of an artisan (a profile photo) is open to everyone, as before', async () => {
    const info = await serviceWith(asset({ visibility: 'PUBLIC', purpose: 'PROFILE_PHOTO' })).getDownloadInfo(as('CLIENT', 92), 5);

    expect(info.asset.id).toBe(5);
  });

  it('the applicant cannot delete or replace what they sent; the verifying team can', async () => {
    for (const user of [as('ARTISAN', 90), as('DISPATCHER'), as('ACCOUNTANT')]) {
      const service = serviceWith(asset());
      const deleting = await failure(service.deleteFile(user, 5));
      const replacing = await failure(service.replaceFile(user, 5, upload(await jpeg())));

      expect(deleting.getStatus()).toBe(403);
      expect(replacing.getStatus()).toBe(403);
      expect(String(deleting.message)).toMatch(/vérification/);
    }

    expect(await serviceWith(asset()).deleteFile(as('ADMIN'), 5)).toBeDefined();
  });

  it('the other files are deleted by their uploader as before', async () => {
    const photo = asset({ entityType: 'INTERVENTION', entityId: 7, purpose: 'CLIENT_DAMAGE_PHOTO', uploadedById: 7 });

    expect(await serviceWith(photo).deleteFile(as('CLIENT', 7), 5)).toBeDefined();
  });
});
