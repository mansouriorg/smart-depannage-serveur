import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { classifyProofUrl, migrateLegacyProofs } from './legacy-proofs';
import { scene } from './test-photos';

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proofs-'));
  const interventions = new FakeTable({
    defaults: () => ({
      artisanId: 7,
      beforePhotoUrl: null,
      beforePhotoLat: null,
      beforePhotoLng: null,
      beforePhotoAt: null,
      afterPhotoUrl: null,
      afterPhotoLat: null,
      afterPhotoLng: null,
      afterPhotoAt: null,
    }),
  });
  const proofs = new FakeTable({ unique: ['sha256'] });
  const assets = new FakeTable({
    defaults: () => ({ isImage: true, purpose: 'ARTISAN_AFTER_PHOTO', visibility: 'PRIVATE', mimeType: 'image/jpeg', publicUrl: null }),
  });
  const db: any = withTransactions({ intervention: interventions, proofCapture: proofs, fileAsset: assets }, [interventions, proofs, assets]);

  const legacyFile = async (name: string, bytes: Buffer) => {
    fs.mkdirSync(path.join(root, 'proofs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proofs', name), bytes);
  };
  const exists = (relative: string) => fs.existsSync(path.join(root, relative));

  return { root, db, interventions, proofs, assets, legacyFile, exists };
}

describe('classifyProofUrl', () => {
  it('knows the three kinds of address', () => {
    expect(classifyProofUrl('/uploads/proofs/proof-1760-42.jpg')).toEqual({ type: 'legacy-file', name: 'proof-1760-42.jpg' });
    expect(classifyProofUrl('/files/12/download')).toEqual({ type: 'asset', id: 12, prefixed: false });
    expect(classifyProofUrl('/api/files/12/download')).toEqual({ type: 'asset', id: 12, prefixed: true });
  });

  it('anything else, and anything that tries to leave the folder, is outside', () => {
    for (const url of [
      'https://example.com/a.jpg',
      '/uploads/proofs/../private/secret.pdf',
      '/uploads/proofs/..',
      '/uploads/proofs/a/b.jpg',
      '/uploads/proofs/',
      '/uploads/public/a.jpg',
      '/files/abc/download',
      '/files/12/download?x=1',
      '',
    ]) {
      expect(classifyProofUrl(url)).toEqual({ type: 'external' });
    }
  });
});

describe('migrateLegacyProofs', () => {
  it('a dry run counts and writes nothing', async () => {
    const w = makeWorld();
    const bytes = await scene(1);

    await w.legacyFile('proof-1.jpg', bytes);
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/proof-1.jpg' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: false });

    expect(report.looked).toBe(1);
    expect(report.moved).toBe(1);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('/uploads/proofs/proof-1.jpg');
    expect(w.proofs.rows.length).toBe(0);
    expect(w.assets.rows.length).toBe(0);
    expect(w.exists('proofs/proof-1.jpg')).toBe(true);
    expect(w.exists('private/artisan_after_photo/proof-1.jpg')).toBe(false);
  });

  it('moves an old public file behind the login and keeps the facts that were recorded', async () => {
    const w = makeWorld();
    const bytes = await scene(2);
    const taken = new Date('2026-09-01T09:30:00Z');

    await w.legacyFile('proof-2.jpg', bytes);
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/proof-2.jpg', afterPhotoLat: 36.8, afterPhotoLng: 10.18, afterPhotoAt: taken });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.moved).toBe(1);
    expect(report.failures).toEqual([]);

    const asset = w.assets.rows[0];

    expect(asset).toMatchObject({
      visibility: 'PRIVATE',
      purpose: 'ARTISAN_AFTER_PHOTO',
      entityType: 'INTERVENTION',
      entityId: 1,
      uploadedById: 7,
      mimeType: 'image/jpeg',
      relativePath: 'private/artisan_after_photo/proof-2.jpg',
    });
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(`/api/files/${asset.id}/download`);
    expect(w.proofs.rows[0]).toMatchObject({
      kind: 'AFTER',
      source: 'ARTISAN',
      status: 'ACCEPTED',
      reasons: [],
      latitude: 36.8,
      longitude: 10.18,
      fileAssetId: asset.id,
      photoUrl: `/api/files/${asset.id}/download`,
    });
    expect(w.proofs.rows[0].receivedAt.toISOString()).toBe(taken.toISOString());
    expect(w.proofs.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.proofs.rows[0].dhash).toMatch(/^[0-9a-f]{16}$/);

    // The picture is private now, and no longer in the public folder.
    expect(w.exists('private/artisan_after_photo/proof-2.jpg')).toBe(true);
    expect(w.exists('proofs/proof-2.jpg')).toBe(false);
    expect(fs.readFileSync(path.join(w.root, 'private/artisan_after_photo/proof-2.jpg')).equals(bytes)).toBe(true);
  });

  it('does both photos of a job, each in its own folder', async () => {
    const w = makeWorld();

    await w.legacyFile('b.jpg', await scene(3));
    await w.legacyFile('a.jpg', await scene(4));
    w.interventions.insert({ beforePhotoUrl: '/uploads/proofs/b.jpg', afterPhotoUrl: '/uploads/proofs/a.jpg' });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.proofs.rows.map((r) => r.kind).sort()).toEqual(['AFTER', 'BEFORE']);
    expect(w.exists('private/artisan_before_photo/b.jpg')).toBe(true);
    expect(w.exists('private/artisan_after_photo/a.jpg')).toBe(true);
  });

  it('can be run again: what is done is skipped', async () => {
    const w = makeWorld();

    await w.legacyFile('proof-5.jpg', await scene(5));
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/proof-5.jpg' });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    const again = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(again.moved).toBe(0);
    expect(again.alreadyDone).toBe(1);
    expect(w.proofs.rows.length).toBe(1);
    expect(w.assets.rows.length).toBe(1);
  });

  it('the same photo on two jobs: both kept, the second one is for review', async () => {
    const w = makeWorld();
    const bytes = await scene(6);

    await w.legacyFile('one.jpg', bytes);
    await w.legacyFile('two.jpg', bytes);
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/one.jpg' });
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/two.jpg' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.duplicates).toBe(1);
    expect(w.proofs.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'NEEDS_REVIEW']);
    expect(w.proofs.rows[1].reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(w.proofs.rows[1].sha256).toBeNull();
    expect(w.interventions.rows.every((r) => r.afterPhotoUrl.startsWith('/api/files/'))).toBe(true);
  });

  it('a file that is gone is reported and the address stays', async () => {
    const w = makeWorld();

    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/gone.jpg' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.missingFiles).toBe(1);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('/uploads/proofs/gone.jpg');
    expect(w.proofs.rows.length).toBe(0);
  });

  it('an address on another site is listed and left alone', async () => {
    const w = makeWorld();

    w.interventions.insert({ afterPhotoUrl: 'https://cdn.example.com/x.jpg', beforePhotoUrl: '/uploads/proofs/../private/doc.pdf' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.external).toEqual([
      { interventionId: 1, column: 'beforePhotoUrl' },
      { interventionId: 1, column: 'afterPhotoUrl' },
    ]);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('https://cdn.example.com/x.jpg');
  });

  it('a photo of the files module gets its /api prefix and a capture row', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: 'a'.repeat(64), uploadedById: 7, purpose: 'ARTISAN_AFTER_PHOTO' });

    w.interventions.insert({ afterPhotoUrl: `/files/${asset.id}/download` });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.prefixed).toBe(1);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(`/api/files/${asset.id}/download`);
    expect(w.proofs.rows[0]).toMatchObject({ fileAssetId: asset.id, source: 'ARTISAN', status: 'ACCEPTED', sha256: 'a'.repeat(64) });
  });

  it('an address that already has its prefix but no capture row gets the row, and its address stays', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: 'c'.repeat(64), uploadedById: 7, purpose: 'ARTISAN_AFTER_PHOTO' });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });

    const dry = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: false });

    expect(dry).toMatchObject({ captured: 1, prefixed: 0, alreadyDone: 0 });
    expect(w.proofs.rows.length).toBe(0);

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report).toMatchObject({ captured: 1, prefixed: 0, alreadyDone: 0 });
    expect(w.proofs.rows[0]).toMatchObject({ fileAssetId: asset.id, photoUrl: `/api/files/${asset.id}/download`, status: 'ACCEPTED' });
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(`/api/files/${asset.id}/download`);

    // ...and the next run finds nothing left to do.
    expect(await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true })).toMatchObject({ captured: 0, alreadyDone: 1 });
  });

  it('a photo added by the back office is recorded as theirs', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: 'b'.repeat(64), uploadedById: 20 });

    w.interventions.insert({ afterPhotoUrl: `/files/${asset.id}/download` });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.proofs.rows[0]).toMatchObject({ source: 'STAFF', submittedById: 20 });
  });

  it('an address of the files module whose file is not in the database is reported', async () => {
    const w = makeWorld();

    w.interventions.insert({ afterPhotoUrl: '/files/999/download' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.missingFiles).toBe(1);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('/files/999/download');
  });

  it('a photo of a job that changed while the migration ran is left alone, and nothing is half done', async () => {
    const w = makeWorld();

    await w.legacyFile('late.jpg', await scene(40));
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/late.jpg' });

    // The artisan sends a new proof between the moment the job was read and the moment it is changed.
    const run = w.db.$transaction.bind(w.db);

    w.db.$transaction = async (work: any) => {
      w.interventions.rows[0].afterPhotoUrl = '/api/files/999/download';
      return run(work);
    };

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.failures.length).toBe(1);
    expect(report.failures[0].reason).toMatch(/changed while the migration ran/);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('/api/files/999/download');
    expect(w.proofs.rows.length).toBe(0);
    expect(w.assets.rows.length).toBe(0);
    expect(w.exists('proofs/late.jpg')).toBe(true);
    expect(w.exists('private/artisan_after_photo/late.jpg')).toBe(false);
  });

  it('two jobs that point at the same old file both keep their photo, the second is for review, the file goes last', async () => {
    const w = makeWorld();

    await w.legacyFile('shared.jpg', await scene(41));
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/shared.jpg' });
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/shared.jpg' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.missingFiles).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.moved).toBe(2);
    expect(w.interventions.rows.every((r) => r.afterPhotoUrl.startsWith('/api/files/'))).toBe(true);
    expect(w.proofs.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'NEEDS_REVIEW']);
    expect(w.proofs.rows[1].reasons).toEqual(['PHOTO_ALREADY_USED']);
    // Two files, two paths: the proofs do not share one.
    expect(new Set(w.assets.rows.map((a) => a.relativePath)).size).toBe(2);
    expect(w.assets.rows.every((a) => w.exists(a.relativePath))).toBe(true);
    expect(w.exists('proofs/shared.jpg')).toBe(false);
  });

  it('the old file stays while one job still points at it', async () => {
    const w = makeWorld();

    await w.legacyFile('x.jpg', await scene(42));
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/x.jpg' });
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/x.jpg' });

    // Only the first job is looked at: the second one is outside this run (the job id is bounded).
    const find = w.db.intervention.findMany.bind(w.db.intervention);

    w.db.intervention.findMany = async (args: any) => (await find(args)).filter((row: any) => row.id === 1);

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.exists('proofs/x.jpg')).toBe(true);
    expect(w.interventions.rows[1].afterPhotoUrl).toBe('/uploads/proofs/x.jpg');
  });

  it('the same old file as the before and the after of one job: both are done', async () => {
    const w = makeWorld();

    await w.legacyFile('same.jpg', await scene(43));
    w.interventions.insert({ beforePhotoUrl: '/uploads/proofs/same.jpg', afterPhotoUrl: '/uploads/proofs/same.jpg' });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.missingFiles).toBe(0);
    expect(report.moved).toBe(2);
    expect(w.proofs.rows.map((r) => r.kind)).toEqual(['BEFORE', 'AFTER']);
    expect(w.proofs.rows[1].status).toBe('NEEDS_REVIEW');
    expect(w.exists('proofs/same.jpg')).toBe(false);
  });

  it('a proof photo that was made public goes back behind the login', async () => {
    const w = makeWorld();
    const bytes = await scene(44);

    fs.mkdirSync(path.join(w.root, 'public/artisan_after_photo'), { recursive: true });
    fs.writeFileSync(path.join(w.root, 'public/artisan_after_photo/open.jpg'), bytes);

    const asset = w.assets.insert({
      checksum: 'd'.repeat(64),
      uploadedById: 7,
      visibility: 'PUBLIC',
      relativePath: 'public/artisan_after_photo/open.jpg',
      fileName: 'open.jpg',
      publicUrl: '/uploads/public/artisan_after_photo/open.jpg',
    });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });

    const dry = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: false });

    expect(dry.madePrivate).toBe(1);
    expect(w.assets.rows[0].visibility).toBe('PUBLIC');
    expect(w.exists('public/artisan_after_photo/open.jpg')).toBe(true);

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.madePrivate).toBe(1);
    expect(w.assets.rows[0]).toMatchObject({ visibility: 'PRIVATE', relativePath: 'private/artisan_after_photo/open.jpg', publicUrl: null });
    expect(w.exists('public/artisan_after_photo/open.jpg')).toBe(false);
    expect(fs.readFileSync(path.join(w.root, 'private/artisan_after_photo/open.jpg')).equals(bytes)).toBe(true);
    expect(w.proofs.rows.length).toBe(1);

    const again = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(again.madePrivate).toBe(0);
    expect(again.alreadyDone).toBe(1);
  });

  it('a public proof whose file is gone from the disk is still made private in the database', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: 'e'.repeat(64), uploadedById: 7, visibility: 'PUBLIC', relativePath: 'public/artisan_after_photo/gone.jpg', fileName: 'gone.jpg' });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.assets.rows[0]).toMatchObject({ visibility: 'PRIVATE', relativePath: 'private/artisan_after_photo/gone.jpg' });
  });

  it('a file that is not a proof photo is listed and left as it is', async () => {
    const w = makeWorld();
    const pdf = w.assets.insert({ isImage: false, mimeType: 'application/pdf', purpose: 'INVOICE_PDF', checksum: 'f'.repeat(64) });
    const other = w.assets.insert({ purpose: 'QUOTE_ATTACHMENT', checksum: '1'.repeat(64) });

    w.interventions.insert({ afterPhotoUrl: `/files/${pdf.id}/download` });
    w.interventions.insert({ afterPhotoUrl: `/api/files/${other.id}/download` });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.external).toEqual([
      { interventionId: 1, column: 'afterPhotoUrl' },
      { interventionId: 2, column: 'afterPhotoUrl' },
    ]);
    expect(w.proofs.rows.length).toBe(0);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(`/files/${pdf.id}/download`);
  });

  it('a proof photo that is not an image (a PDF stored under the proof purpose) is listed, not made a proof', async () => {
    const w = makeWorld();
    const pdf = w.assets.insert({ isImage: false, mimeType: 'application/pdf', purpose: 'ARTISAN_AFTER_PHOTO', checksum: '3'.repeat(64) });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${pdf.id}/download` });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.external.length).toBe(1);
    expect(w.proofs.rows.length).toBe(0);
  });

  it('an image of another purpose (not a proof photo) is listed, not made a proof', async () => {
    const w = makeWorld();
    const other = w.assets.insert({ purpose: 'INTERVENTION_PHOTO', checksum: '4'.repeat(64) });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${other.id}/download` });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.external.length).toBe(1);
    expect(w.proofs.rows.length).toBe(0);
  });

  it('an address already migrated whose file is still public is made private without a second row', async () => {
    const w = makeWorld();
    const bytes = await scene(45);

    fs.mkdirSync(path.join(w.root, 'public/artisan_after_photo'), { recursive: true });
    fs.writeFileSync(path.join(w.root, 'public/artisan_after_photo/still.jpg'), bytes);

    const asset = w.assets.insert({
      checksum: '5'.repeat(64),
      uploadedById: 7,
      visibility: 'PUBLIC',
      relativePath: 'public/artisan_after_photo/still.jpg',
      fileName: 'still.jpg',
    });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });
    w.proofs.insert({ fileAssetId: asset.id, interventionId: 1, kind: 'AFTER', status: 'ACCEPTED', sha256: '5'.repeat(64) });

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.madePrivate).toBe(1);
    expect(report.alreadyDone).toBe(0);
    expect(w.proofs.rows.length).toBe(1);
    expect(w.assets.rows[0].visibility).toBe('PRIVATE');
    expect(w.exists('private/artisan_after_photo/still.jpg')).toBe(true);
  });

  it('a file without a checksum used by two jobs is still a second use', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: null, uploadedById: 7 });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });
    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.proofs.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'NEEDS_REVIEW']);
    expect(w.proofs.rows[1].reasons).toEqual(['PHOTO_ALREADY_USED']);
  });

  it('if the database refuses while a public proof is being moved, the copy is taken away and the public file stays', async () => {
    const w = makeWorld();

    fs.mkdirSync(path.join(w.root, 'public/artisan_after_photo'), { recursive: true });
    fs.writeFileSync(path.join(w.root, 'public/artisan_after_photo/stay.jpg'), await scene(46));

    const asset = w.assets.insert({
      checksum: '6'.repeat(64),
      uploadedById: 7,
      visibility: 'PUBLIC',
      relativePath: 'public/artisan_after_photo/stay.jpg',
      fileName: 'stay.jpg',
    });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });
    w.proofs.create = async () => {
      throw new Error('database down');
    };

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.failures.length).toBe(1);
    expect(w.assets.rows[0]).toMatchObject({ visibility: 'PUBLIC', relativePath: 'public/artisan_after_photo/stay.jpg' });
    expect(w.exists('public/artisan_after_photo/stay.jpg')).toBe(true);
    expect(w.exists('private/artisan_after_photo/stay.jpg')).toBe(false);
  });

  it('a file of the files module used by two jobs: the second job gets its own row, for review', async () => {
    const w = makeWorld();
    const asset = w.assets.insert({ checksum: '2'.repeat(64), uploadedById: 7 });

    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });
    w.interventions.insert({ afterPhotoUrl: `/api/files/${asset.id}/download` });

    await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(w.proofs.rows.map((r) => [r.interventionId, r.status])).toEqual([
      [1, 'ACCEPTED'],
      [2, 'NEEDS_REVIEW'],
    ]);
    expect(w.proofs.rows[1]).toMatchObject({ fileAssetId: asset.id, sha256: null, reasons: ['PHOTO_ALREADY_USED'] });
  });

  it('a failure on one job is reported and does not stop the others, nor leave half a job', async () => {
    const w = makeWorld();

    await w.legacyFile('ok.jpg', await scene(7));
    await w.legacyFile('bad.jpg', await scene(8));
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/bad.jpg' });
    w.interventions.insert({ afterPhotoUrl: '/uploads/proofs/ok.jpg' });

    const create = w.proofs.create;
    let calls = 0;

    w.proofs.create = async (args: any) => {
      calls++;
      if (calls === 1) throw new Error('database down');
      return create(args);
    };

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.failures.length).toBe(1);
    expect(report.failures[0]).toMatchObject({ interventionId: 1, column: 'afterPhotoUrl', reason: 'database down' });
    // Nothing of the failed one stayed in the tables, and its old file is still where it was.
    expect(w.interventions.rows[0].afterPhotoUrl).toBe('/uploads/proofs/bad.jpg');
    expect(w.assets.rows.length).toBe(1);
    expect(w.exists('proofs/bad.jpg')).toBe(true);
    // The other was moved.
    expect(w.interventions.rows[1].afterPhotoUrl).toMatch(/^\/api\/files\//);
    expect(w.exists('proofs/ok.jpg')).toBe(false);

    // Running again repairs the first one.
    w.proofs.create = create;

    const again = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(again.failures).toEqual([]);
    expect(w.interventions.rows[0].afterPhotoUrl).toMatch(/^\/api\/files\//);
  });

  it('jobs without a photo are not looked at', async () => {
    const w = makeWorld();

    w.interventions.insert({});

    const report = await migrateLegacyProofs({ db: w.db, uploadRoot: w.root, apply: true });

    expect(report.looked).toBe(0);
  });
});
