import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import sharp from 'sharp';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { FilesService } from '../files/files.service';
import { ProofsService } from './proofs.service';
import { flat, halves, scene, upload } from './test-photos';

// A job in Tunis (Avenue Habib Bourguiba). 0.001 degree of latitude is ~111 m.
const JOB = { latitude: 36.8008, longitude: 10.1815 };
const north = (meters: number) => JOB.latitude + meters / 111_195;
const T0 = new Date('2026-10-17T10:00:00Z');

class ClockedProofs extends ProofsService {
  clock = new Date(T0);

  protected now(): Date {
    return new Date(this.clock);
  }
}

type Options = {
  proofCreateThrows?: Error;
  eventsThrow?: boolean;
  notifyThrows?: boolean;
};

function makeWorld(options: Options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofs-spec-'));

  const interventions = new FakeTable({
    defaults: () => ({
      status: 'IN_PROGRESS',
      clientId: 3,
      artisanId: 7,
      latitude: JOB.latitude,
      longitude: JOB.longitude,
      savedAddress: null,
      address: '12 avenue Habib Bourguiba, Tunis',
      serviceType: 'PLUMBING',
      beforePhotoUrl: null,
      beforePhotoLat: null,
      beforePhotoLng: null,
      beforePhotoAt: null,
      afterPhotoUrl: null,
      afterPhotoLat: null,
      afterPhotoLng: null,
      afterPhotoAt: null,
      workCompletedAt: null,
    }),
  });
  const proofs = new FakeTable({ unique: ['sha256'], defaults: () => ({ reasons: [], reviewedAt: null, reviewedById: null, reviewNote: null }) });
  const assets = new FakeTable();
  const locks: number[][] = [];

  if (options.proofCreateThrows) {
    const failure = options.proofCreateThrows;

    proofs.create = async () => {
      throw failure;
    };
  }

  const prisma: any = withTransactions(
    {
      intervention: interventions,
      proofCapture: proofs,
      fileAsset: assets,
      $executeRaw: async (_strings: TemplateStringsArray, ...values: number[]) => {
        locks.push(values);
        return 1;
      },
    },
    [interventions, proofs, assets],
  );

  const timeline: any[] = [];
  const events: any = {
    create: async (data: any) => {
      if (options.eventsThrow) throw new Error('timeline down');
      timeline.push(data);
    },
  };

  const told: Array<{ what: string; args: any }> = [];
  const notifications: any = {
    notifyProofNeedsReview: async (args: any) => {
      if (options.notifyThrows) throw new Error('sms provider down');
      told.push({ what: 'needs-review', args });
    },
    notifyProofRefused: async (args: any) => {
      told.push({ what: 'refused', args });
    },
  };

  const files = new FilesService(prisma, events);

  (files as any).uploadRoot = root;

  const service = new ClockedProofs(prisma, files, events, notifications);
  const job = (data: Record<string, unknown> = {}) => interventions.insert(data);

  const onDisk = () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    };

    walk(root);

    return found;
  };

  return { service, prisma, interventions, proofs, assets, timeline, told, locks, job, onDisk, root };
}

const ARTISAN = { id: 7, role: 'ARTISAN' as any };
const OTHER_ARTISAN = { id: 8, role: 'ARTISAN' as any };
const CLIENT = { id: 3, role: 'CLIENT' as any };
const DISPATCHER = { id: 20, role: 'DISPATCHER' as any };

/** What a phone on site sends. */
const onSite = (over: Record<string, unknown> = {}) => ({
  latitude: String(JOB.latitude),
  longitude: String(JOB.longitude),
  accuracy: '8',
  mocked: 'false',
  capturedAt: T0.toISOString(),
  ...over,
});

/** Nest answers { message } for an exception made with a sentence; the test runner's stand-in answers the sentence. */
const messageOf = (body: any): string => (typeof body === 'string' ? body : String(body?.message ?? ''));

async function refusedWith(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { status: error.getStatus?.(), body: error.getResponse?.(), error };
  }

  throw new Error('expected the photo to be refused');
}

describe('ProofsService.submit: a good photo', () => {
  it('is kept, privately, and copied onto the job with the SERVER time', async () => {
    const w = makeWorld();
    const job = w.job();
    // The phone says the photo was taken at 09:58; the server received it at 10:00.
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(1)),
      capture: onSite({ capturedAt: '2026-10-17T09:58:00Z' }),
    });

    expect(result.view.status).toBe('ACCEPTED');
    expect(result.view.message).toBe('Photo enregistrée.');
    expect(result.completed).toBe(false);
    expect(result.replay).toBe(false);

    const row = w.interventions.rows[0];

    expect(row.afterPhotoUrl).toBe(`/api/files/${w.assets.rows[0].id}/download`);
    expect(row.afterPhotoAt.toISOString()).toBe(T0.toISOString());
    expect(row.afterPhotoLat).toBe(JOB.latitude);
    expect(row.afterPhotoLng).toBe(JOB.longitude);
    expect(row.beforePhotoUrl).toBeNull();
    // The job is not closed by a plain upload.
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('is written once: one capture, one file row, one private file, one line in the timeline', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(2)), capture: onSite() });

    expect(w.proofs.rows.length).toBe(1);
    expect(w.proofs.rows[0]).toMatchObject({
      interventionId: job.id,
      kind: 'BEFORE',
      source: 'ARTISAN',
      submittedById: 7,
      status: 'ACCEPTED',
      mocked: false,
      accuracyM: 8,
      distanceM: 0,
    });
    expect(w.proofs.rows[0].receivedAt.toISOString()).toBe(T0.toISOString());
    expect(w.proofs.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.proofs.rows[0].dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(w.proofs.rows[0].photoUrl).toBe(w.interventions.rows[0].beforePhotoUrl);

    expect(w.assets.rows.length).toBe(1);
    expect(w.assets.rows[0]).toMatchObject({
      visibility: 'PRIVATE',
      purpose: 'ARTISAN_BEFORE_PHOTO',
      entityType: 'INTERVENTION',
      entityId: job.id,
      uploadedById: 7,
      mimeType: 'image/webp',
    });
    expect(w.assets.rows[0].publicUrl).toBeUndefined();

    // Behind the login: nothing under the folders the web server serves.
    const files = w.onDisk();

    expect(files.length).toBe(1);
    expect(files[0].startsWith('private/artisan_before_photo/')).toBe(true);

    expect(w.timeline.length).toBe(1);
    expect(w.timeline[0]).toMatchObject({ interventionId: job.id, type: 'BEFORE_PHOTO_UPLOADED', createdById: 7 });
    expect(w.timeline[0].message).not.toMatch(/vérif|distance|GPS/i);
  });

  it('takes the job lock inside the transaction', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(3)), capture: onSite() });

    expect(w.locks.some((values) => values[1] === job.id)).toBe(true);
  });

  it('a phone that sends the position of today only (no accuracy, no mocked flag, "timestamp") still passes on site', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(4)),
      capture: { latitude: JOB.latitude, longitude: JOB.longitude, capturedAt: T0.toISOString() },
    });

    expect(result.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows[0].mocked).toBeNull();
    expect(w.proofs.rows[0].accuracyM).toBeNull();
  });

  it('what the artisan is told carries no distance, no limit and no reason', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(5)),
      capture: onSite({ latitude: String(north(800)) }),
    });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(Object.keys(result.view).sort()).toEqual(['id', 'kind', 'message', 'photoUrl', 'receivedAt', 'status']);
    expect(JSON.stringify(result.view)).not.toMatch(/distance|FAR_FROM|800|GPS/i);
  });
});

describe('ProofsService.submit: a photo that is not where the job is', () => {
  it('between the two limits: kept, flagged, and the back office is told', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(6)),
      capture: onSite({ latitude: String(north(800)) }),
    });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(result.view.message).toContain('vérifiera');
    expect(w.proofs.rows[0].status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows[0].reasons).toEqual(['FAR_FROM_JOB']);
    expect(w.interventions.rows[0].afterPhotoUrl).not.toBeNull();

    expect(w.told.length).toBe(1);
    expect(w.told[0].what).toBe('needs-review');
    expect(w.told[0].args).toMatchObject({ interventionId: job.id, proofId: w.proofs.rows[0].id, kind: 'AFTER', artisanId: 7 });
    expect(w.told[0].args.details[0]).toMatch(/de l’adresse/);
  });

  it('far from the job: refused with what to do, recorded without the picture, nothing written on the job', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({
        interventionId: job.id,
        kind: 'AFTER',
        actor: ARTISAN,
        file: upload(await scene(7)),
        capture: onSite({ latitude: String(north(5000)) }),
      }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PROOF_REJECTED');
    expect(refused.body.reasons).toEqual(['TOO_FAR_FROM_JOB']);
    expect(messageOf(refused.body)).toContain('5,0 km');
    expect(messageOf(refused.body)).toContain('reprenez la photo');

    expect(w.proofs.rows.length).toBe(1);
    expect(w.proofs.rows[0]).toMatchObject({ status: 'REJECTED', reasons: ['TOO_FAR_FROM_JOB'], sha256: null, dhash: null, fileAssetId: null, photoUrl: null });
    expect(w.proofs.rows[0].distanceM).toBeGreaterThan(4900);

    expect(w.assets.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
    expect(w.interventions.rows[0].afterPhotoAt).toBeNull();
    expect(w.timeline).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it('a position the phone says is simulated is refused, even exactly at the job', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(8)), capture: onSite({ mocked: 'true' }) }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.reasons).toEqual(['MOCKED_LOCATION']);
    expect(messageOf(refused.body)).toContain('simulée');
    expect(w.proofs.rows[0]).toMatchObject({ status: 'REJECTED', mocked: true });
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
  });

  it('a hopelessly imprecise position is refused', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(9)), capture: onSite({ accuracy: '4000' }) }),
    );

    expect(refused.body.reasons).toEqual(['ACCURACY_TOO_LOW']);
  });

  it('no position at all, or (0, 0), is refused', async () => {
    const w = makeWorld();
    const job = w.job();

    for (const [seed, capture] of [
      [10, {}],
      [11, { latitude: '0', longitude: '0' }],
      [12, { latitude: 'abc', longitude: '10' }],
    ] as const) {
      const refused = await refusedWith(
        w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(seed)), capture }),
      );

      expect(refused.body.reasons).toEqual(['POSITION_INVALID']);
    }

    expect(w.proofs.rows.length).toBe(3);
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
  });

  it('a phone whose clock is hours off is kept, flagged, and the stamped time is still the server one', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(13)),
      capture: onSite({ capturedAt: '2026-10-16T01:00:00Z' }),
    });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows[0].reasons).toEqual(['CLOCK_DIFFERENCE']);
    expect(w.proofs.rows[0].clockOffsetSeconds).toBeLessThan(-3600);
    expect(w.proofs.rows[0].receivedAt.toISOString()).toBe(T0.toISOString());
    expect(w.interventions.rows[0].afterPhotoAt.toISOString()).toBe(T0.toISOString());
    expect(w.proofs.rows[0].clientCapturedAt.toISOString()).toBe('2026-10-16T01:00:00.000Z');
  });

  it('a job that is not on the map: noted, nobody is asked to look, the other checks still apply', async () => {
    const w = makeWorld();
    const job = w.job({ latitude: null, longitude: null });
    const result = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(14)), capture: onSite() });

    expect(result.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows[0].reasons).toEqual(['JOB_NOT_LOCATED']);
    expect(w.told).toEqual([]);

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(15)), capture: onSite({ mocked: 'true' }) }),
    );

    expect(refused.body.reasons).toEqual(['MOCKED_LOCATION']);
  });

  it('a job without coordinates of its own is located by the saved address it was made from', async () => {
    const w = makeWorld();
    const job = w.job({ latitude: null, longitude: null, savedAddress: { latitude: JOB.latitude, longitude: JOB.longitude } });
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(16)), capture: onSite({ latitude: String(north(9000)) }) }),
    );

    expect(refused.body.reasons).toEqual(['TOO_FAR_FROM_JOB']);
  });
});

describe('ProofsService.submit: where the job is, when its own coordinates are no place', () => {
  it('a job whose coordinates are (0, 0) is located by the saved address, not taken as being in the Atlantic', async () => {
    const w = makeWorld();
    const job = w.job({ latitude: 0, longitude: 0, savedAddress: { latitude: JOB.latitude, longitude: JOB.longitude } });
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(17)), capture: onSite({ latitude: String(north(9000)) }) }),
    );

    expect(refused.body.reasons).toEqual(['TOO_FAR_FROM_JOB']);

    const ok = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(18)), capture: onSite() });

    expect(ok.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows[w.proofs.rows.length - 1].reasons).toEqual([]);
  });

  it('coordinates out of range (a latitude of 400) are no place either', async () => {
    const w = makeWorld();
    const job = w.job({ latitude: 400, longitude: 10, savedAddress: { latitude: JOB.latitude, longitude: JOB.longitude } });
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(19)), capture: onSite({ latitude: String(north(9000)) }) }),
    );

    expect(refused.body.reasons).toEqual(['TOO_FAR_FROM_JOB']);
  });

  it('(0, 0) and no saved address: the job is not on the map, the photo is only noted', async () => {
    const w = makeWorld();
    const job = w.job({ latitude: 0, longitude: 0 });
    const ok = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(26)), capture: onSite() });

    expect(ok.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows[0].reasons).toEqual(['JOB_NOT_LOCATED']);
  });
});

describe('ProofsService.submit: the same photo', () => {
  it('a photo already used on another job is refused', async () => {
    const w = makeWorld();
    const first = w.job();
    const second = w.job();
    const bytes = await scene(20);

    await w.service.submit({ interventionId: first.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    const refused = await refusedWith(
      w.service.submit({ interventionId: second.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
    );

    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(messageOf(refused.body)).toContain('nouvelle photo');
    expect(w.interventions.rows[1].afterPhotoUrl).toBeNull();
    expect(w.assets.rows.length).toBe(1);
    // Judged before anything is stored: the attempt is on record, without the picture or its fingerprint.
    expect(w.proofs.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED']);
    // (the identical photo also "looks like" the first one: both reasons are on record, only the refusal is told)
    expect(w.proofs.rows[1]).toMatchObject({ interventionId: second.id, reasons: ['PHOTO_ALREADY_USED', 'SIMILAR_TO_EARLIER_PROOF'], fileAssetId: null, photoUrl: null, sha256: null, dhash: null });
    expect(w.onDisk().length).toBe(1);
  });

  it('a photo already used as the "before" cannot be the "after" of the same job', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(21);

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
    );

    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
  });

  it('a photo sent again for the same job by the same person (a reply lost on the way) gets the first answer and writes nothing', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(22);
    const first = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });
    const again = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    expect(again.replay).toBe(true);
    expect(again.view.id).toBe(first.view.id);
    expect(w.proofs.rows.length).toBe(1);
    expect(w.assets.rows.length).toBe(1);
    expect(w.onDisk().length).toBe(1);
    expect(w.timeline.length).toBe(1);
  });

  it('a photo already sent as a proof is not a way to close the job: closing needs a photo that was not used', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(27);

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(w.interventions.rows[0].status).toBe('IN_PROGRESS');
  });

  it('a double tap on the same job: the second request gets the first one\'s answer (a proof) or "already closed" (the job)', async () => {
    const proofWorld = makeWorld();
    const proofJob = proofWorld.job();
    const bytes = await scene(28);
    const taps = await Promise.allSettled([
      proofWorld.service.submit({ interventionId: proofJob.id, kind: 'BEFORE', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
      proofWorld.service.submit({ interventionId: proofJob.id, kind: 'BEFORE', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
    ]);

    expect(taps.every((t) => t.status === 'fulfilled')).toBe(true);
    expect((taps as PromiseFulfilledResult<any>[]).filter((t) => t.value.replay).length).toBe(1);
    expect(proofWorld.proofs.rows.length).toBe(1);
    expect(proofWorld.onDisk().length).toBe(1);

    const closeWorld = makeWorld();
    const closeJob = closeWorld.job();
    const closing = await Promise.allSettled([
      closeWorld.service.submit({ interventionId: closeJob.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite(), completeJob: true }),
      closeWorld.service.submit({ interventionId: closeJob.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite(), completeJob: true }),
    ]);

    expect(closing.filter((t) => t.status === 'fulfilled').length).toBe(1);

    const failed = closing.find((t) => t.status === 'rejected') as PromiseRejectedResult;

    expect(failed.reason.getStatus()).toBe(409);
    expect(messageOf(failed.reason.getResponse())).toMatch(/clôturée/);
    expect(closeWorld.interventions.rows[0].status).toBe('COMPLETED');
    expect(closeWorld.proofs.rows.length).toBe(1);
  });

  it('a closing that loses the race to the same photo sent as a plain proof is refused, not answered as a replay of a closing', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(29);
    const lookup = w.proofs.findUnique.bind(w.proofs);
    let late = true;

    // The plain proof of the same photo is written after the closing looked for it and before it wrote.
    (w.proofs as any).findUnique = async (args: any) => {
      const seen = await lookup(args);

      if (late && args?.where?.sha256) {
        late = false;
        await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });
      }

      return seen;
    };

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(w.interventions.rows[0].status).toBe('IN_PROGRESS');
    expect(w.proofs.rows.length).toBe(1);
    expect(w.onDisk().length).toBe(1);
  });

  it('a photo that looks like the proof of another job (re-saved, smaller) is kept but looked at', async () => {
    const w = makeWorld();
    const first = w.job();
    const second = w.job();
    const original = await scene(23, 640);
    const copy = await sharp(original).resize(300).jpeg({ quality: 60 }).toBuffer();

    await w.service.submit({ interventionId: first.id, kind: 'AFTER', actor: ARTISAN, file: upload(original), capture: onSite() });

    const result = await w.service.submit({ interventionId: second.id, kind: 'AFTER', actor: ARTISAN, file: upload(copy), capture: onSite() });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows[1].reasons).toEqual(['SIMILAR_TO_EARLIER_PROOF']);
    expect(w.told.length).toBe(1);
  });

  it('a refused photo does not use up its bytes: the same photo is judged again once the artisan is on site', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(24);

    await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite({ latitude: String(north(5000)) }) }),
    );

    const result = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    expect(result.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows.map((r) => r.status)).toEqual(['REJECTED', 'ACCEPTED']);
  });

  it('a black frame is kept but looked at', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await flat(0)), capture: onSite() });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows[0].reasons).toEqual(['BLANK_PHOTO']);
  });

  it('a frame that is almost flat (a lens against a dark wall) is looked at too, a faintly shaded wall is not', async () => {
    // Two worlds: the two pictures have the same layout, and would look like each other.
    const a = makeWorld();
    const b = makeWorld();
    const dark = await a.service.submit({ interventionId: a.job().id, kind: 'AFTER', actor: ARTISAN, file: upload(await halves(100, 110)), capture: onSite() });
    const shaded = await b.service.submit({ interventionId: b.job().id, kind: 'AFTER', actor: ARTISAN, file: upload(await halves(100, 116)), capture: onSite() });

    expect(dark.view.status).toBe('NEEDS_REVIEW');
    expect(a.proofs.rows[0].reasons).toEqual(['BLANK_PHOTO']);
    expect(shaded.view.status).toBe('ACCEPTED');
    expect(b.proofs.rows[0].reasons).toEqual([]);
  });

  it('two requests with the same photo at once: the database lets one in, the other is told it was used and leaves no file', async () => {
    const w = makeWorld();
    const job = w.job();
    const other = w.job();
    const bytes = await scene(25);
    const results = await Promise.allSettled([
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
      w.service.submit({ interventionId: other.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);

    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;

    expect(failed.reason.getResponse().reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(w.proofs.rows.filter((r) => r.sha256).length).toBe(1);
    expect(w.assets.rows.length).toBe(1);
    expect(w.onDisk().length).toBe(1);
  });
});

describe('ProofsService.submit: photos that look alike', () => {
  it('the before and the after of one job may look alike (same wall, same angle): not flagged', async () => {
    const w = makeWorld();
    const job = w.job();
    const original = await scene(120, 640);
    const copy = await sharp(original).resize(300).jpeg({ quality: 60 }).toBuffer();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(original), capture: onSite() });

    const result = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(copy), capture: onSite() });

    expect(result.view.status).toBe('ACCEPTED');
  });

  it('a photo the back office refused afterwards still counts: a new one that looks like it is looked at', async () => {
    const w = makeWorld();
    const first = w.job();
    const second = w.job();
    const original = await scene(121, 640);
    const copy = await sharp(original).resize(300).jpeg({ quality: 60 }).toBuffer();

    await w.service.submit({ interventionId: first.id, kind: 'AFTER', actor: ARTISAN, file: upload(original), capture: onSite({ latitude: String(north(800)) }) });
    await w.service.review({ proofId: w.proofs.rows[0].id, decision: 'REJECT', reviewer: DISPATCHER });

    const result = await w.service.submit({ interventionId: second.id, kind: 'AFTER', actor: ARTISAN, file: upload(copy), capture: onSite() });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows[1].reasons).toEqual(['SIMILAR_TO_EARLIER_PROOF']);
  });

  it('a proof older than six months is no longer compared', async () => {
    const w = makeWorld();
    const first = w.job();
    const second = w.job();
    const original = await scene(122, 640);
    const copy = await sharp(original).resize(300).jpeg({ quality: 60 }).toBuffer();

    await w.service.submit({ interventionId: first.id, kind: 'AFTER', actor: ARTISAN, file: upload(original), capture: onSite() });

    w.service.clock = new Date(T0.getTime() + 181 * 24 * 3600_000);

    const late = await w.service.submit({
      interventionId: second.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(copy),
      capture: onSite({ capturedAt: w.service.clock.toISOString() }),
    });

    expect(late.view.status).toBe('ACCEPTED');
  });

  it('a photo the back office refused is not replayed as a success when the artisan sends it again', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(123);

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite({ latitude: String(north(800)) }) });
    await w.service.review({ proofId: w.proofs.rows[0].id, decision: 'REJECT', reviewer: DISPATCHER });

    const refused = await refusedWith(w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() }));

    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
  });

  it('the back office sending the photo an artisan already sent for the same job gets a refusal, not the artisan\'s answer', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(124);

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    const refused = await refusedWith(w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: DISPATCHER, file: upload(bytes) }));

    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
  });
});

describe('ProofsService.submit: closing the job with the photo', () => {
  it('a good photo closes the job in the same write: status, server time, photo columns', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(30)),
      capture: onSite(),
      completeJob: true,
    });

    expect(result.completed).toBe(true);

    const row = w.interventions.rows[0];

    expect(row.status).toBe('COMPLETED');
    expect(row.workCompletedAt.toISOString()).toBe(T0.toISOString());
    expect(row.afterPhotoUrl).toBe(`/api/files/${w.assets.rows[0].id}/download`);
    expect(row.afterPhotoAt.toISOString()).toBe(T0.toISOString());
  });

  it('a refused photo leaves the job in progress', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({
        interventionId: job.id,
        kind: 'AFTER',
        actor: ARTISAN,
        file: upload(await scene(31)),
        capture: onSite({ latitude: String(north(6000)) }),
        completeJob: true,
      }),
    );

    expect(refused.status).toBe(400);
    expect(w.interventions.rows[0].status).toBe('IN_PROGRESS');
    expect(w.interventions.rows[0].workCompletedAt).toBeNull();
  });

  it('a photo that needs a look still closes the job (and the back office is told)', async () => {
    const w = makeWorld();
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(32)),
      capture: onSite({ latitude: String(north(900)) }),
      completeJob: true,
    });

    expect(result.completed).toBe(true);
    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.interventions.rows[0].status).toBe('COMPLETED');
    expect(w.told.length).toBe(1);
  });

  it('a job already closed answers 409 before the photo is read', async () => {
    const w = makeWorld();
    const job = w.job({ status: 'COMPLETED' });
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(33)), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(409);
    expect(w.proofs.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
  });

  it('...and says so even to a photo that could not be decoded: the job is looked at first', async () => {
    const w = makeWorld();
    const job = w.job({ status: 'COMPLETED' });
    const damaged = (await scene(36, 640)).subarray(0, 600);
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(damaged), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toMatch(/clôturée/);
  });

  it('a job that is not in progress cannot be closed with a photo', async () => {
    const w = makeWorld();
    const job = w.job({ status: 'ARTISAN_ON_THE_WAY' });
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(34)), capture: onSite(), completeJob: true }),
    );

    expect([403, 409]).toContain(refused.status);
    expect(w.interventions.rows[0].status).toBe('ARTISAN_ON_THE_WAY');
  });

  it('only the "after" photo closes a job', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(35)), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(400);
  });

  it('if the job is closed by someone else while the photo is being read, nothing is kept', async () => {
    const w = makeWorld();
    const job = w.job();
    const original = (w.service as any).assertMayAdd.bind(w.service);
    let calls = 0;

    // The first check (before the photo is read) passes; then the job is closed behind our back.
    (w.service as any).assertMayAdd = (...args: any[]) => {
      calls++;
      if (calls === 2) w.interventions.rows[0].status = 'COMPLETED';
      return original(...args);
    };

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(36)), capture: onSite(), completeJob: true }),
    );

    expect(refused.status).toBe(409);
    expect(w.proofs.rows.length).toBe(0);
    expect(w.assets.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
  });
});

describe('ProofsService.submit: who and when', () => {
  it('another artisan does not even learn that the job exists', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: OTHER_ARTISAN, file: upload(await scene(40)), capture: onSite() }),
    );

    expect(refused.status).toBe(404);
    expect(w.proofs.rows.length).toBe(0);
  });

  it('a client cannot add a proof', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: CLIENT, file: upload(await scene(41)), capture: onSite() }),
    );

    expect(refused.status).toBe(403);
  });

  it('a job that does not exist is a 404, and so is an id that is not one', async () => {
    const w = makeWorld();

    for (const id of [999, 0, -1, 1.5, NaN, 2 ** 40]) {
      const refused = await refusedWith(
        w.service.submit({ interventionId: id as number, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(42)), capture: onSite() }),
      );

      expect(refused.status).toBe(404);
    }
  });

  it('the photo is taken on site: before the artisan has arrived, or after the job is closed, it is a 409', async () => {
    const w = makeWorld();

    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'COMPLETED', 'CANCELLED', 'CREATED']) {
      const job = w.job({ status });
      const refused = await refusedWith(
        w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(43)), capture: onSite() }),
      );

      expect(refused.status).toBe(409);
    }

    for (const status of ['ARTISAN_ARRIVED', 'IN_PROGRESS']) {
      const job = w.job({ status });
      const result = await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(44 + status.length)), capture: onSite() });

      expect(result.view.status).toBe('ACCEPTED');
    }
  });

  it('the old spelling of a status counts too', async () => {
    const w = makeWorld();
    const job = w.job({ status: 'ARRIVED' });
    const result = await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(50)), capture: onSite() });

    expect(result.view.status).toBe('ACCEPTED');
  });

  it('thirty attempts in an hour on one job is enough: the thirty-first is a 429', async () => {
    const w = makeWorld();
    const job = w.job();

    for (let i = 0; i < 30; i++) {
      await refusedWith(
        w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(100 + i, 64)), capture: onSite({ mocked: 'true' }) }),
      );
    }

    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(200, 64)), capture: onSite() }),
    );

    expect(refused.status).toBe(429);
    expect(w.proofs.rows.length).toBe(30);

    // An hour later the counter has moved on.
    w.service.clock = new Date(T0.getTime() + 61 * 60_000);

    const later = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(201)),
      capture: onSite({ capturedAt: w.service.clock.toISOString() }),
    });

    expect(later.view.status).toBe('ACCEPTED');
  });
});

describe('ProofsService.submit: the file', () => {
  it('no photo: 400', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: undefined, capture: onSite() }));

    expect(refused.status).toBe(400);
    expect(w.proofs.rows.length).toBe(0);
  });

  it('a text file that says it is a JPEG is refused before it is decoded', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(Buffer.from('<html><script>alert(1)</script></html>')), capture: onSite() }),
    );

    expect(refused.status).toBe(400);
    expect(w.proofs.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
  });

  it('a damaged JPEG (right first bytes, nothing after) is refused', async () => {
    const w = makeWorld();
    const job = w.job();
    const bytes = await scene(60, 640);
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes.subarray(0, 600)), capture: onSite() }),
    );

    expect(refused.status).toBe(400);
    expect(messageOf(refused.body)).toMatch(/illisible/);
    expect(w.proofs.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
  });

  it('HEIC is named, so the artisan knows what to change', async () => {
    const w = makeWorld();
    const job = w.job();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(heic, 'image/heic'), capture: onSite() }),
    );

    expect(refused.status).toBe(400);
    expect(messageOf(refused.body)).toContain('HEIC');
    expect(messageOf(refused.body)).toContain('JPEG');
  });

  it('a PNG and a WebP are accepted and kept as WebP', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(61, 320, 'png'), 'image/png'), capture: onSite() });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(62, 320, 'webp'), 'image/webp'), capture: onSite() });

    expect(w.assets.rows.map((a) => a.mimeType)).toEqual(['image/webp', 'image/webp']);
  });

  it('the rows and the file go together: if the capture cannot be written, nothing stays', async () => {
    const w = makeWorld({ proofCreateThrows: new Error('database down') });
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(63)), capture: onSite() }),
    );

    expect(String(refused.error.message)).toContain('database down');
    expect(w.assets.rows.length).toBe(0);
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
    expect(w.onDisk()).toEqual([]);
  });

  it('the timeline and the back office failing do not undo a kept proof', async () => {
    const w = makeWorld({ eventsThrow: true, notifyThrows: true });
    const job = w.job();
    const result = await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(64)),
      capture: onSite({ latitude: String(north(800)) }),
    });

    expect(result.view.status).toBe('NEEDS_REVIEW');
    expect(w.proofs.rows.length).toBe(1);
    expect(w.interventions.rows[0].afterPhotoUrl).not.toBeNull();
  });
});

describe('ProofsService.submit: the back office', () => {
  it('adds a photo without a position: kept as a proof of the back office, no GPS check', async () => {
    const w = makeWorld();
    const job = w.job({ status: 'COMPLETED' });
    const result = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: DISPATCHER, file: upload(await scene(70)) });

    expect(result.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows[0]).toMatchObject({ source: 'STAFF', submittedById: 20, latitude: null, mocked: null, status: 'ACCEPTED' });
    expect(w.interventions.rows[0].afterPhotoUrl).not.toBeNull();
    expect(w.interventions.rows[0].afterPhotoLat).toBeNull();
  });

  it('a photo added next to the artisan\'s never replaces it on the job, nor its position', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(73)), capture: onSite() });

    const artisansPhoto = w.interventions.rows[0].afterPhotoUrl;
    const lat = w.interventions.rows[0].afterPhotoLat;

    const added = await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: DISPATCHER, file: upload(await scene(74)) });

    expect(added.view.status).toBe('ACCEPTED');
    expect(w.proofs.rows.length).toBe(2);
    expect(w.proofs.rows[1]).toMatchObject({ source: 'STAFF', status: 'ACCEPTED' });
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(artisansPhoto);
    expect(w.interventions.rows[0].afterPhotoLat).toBe(lat);
    expect(lat).not.toBeNull();
    expect(added.intervention.afterPhotoUrl).toBe(artisansPhoto);

    // ...but it does fill an empty place, the other kind of photo.
    const before = await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: DISPATCHER, file: upload(await scene(75)) });

    expect(w.interventions.rows[0].beforePhotoUrl).toBe(before.view.photoUrl);
  });

  it('cannot reuse a photo either', async () => {
    const w = makeWorld();
    const first = w.job();
    const second = w.job();
    const bytes = await scene(71);

    await w.service.submit({ interventionId: first.id, kind: 'AFTER', actor: ARTISAN, file: upload(bytes), capture: onSite() });

    const refused = await refusedWith(w.service.submit({ interventionId: second.id, kind: 'AFTER', actor: DISPATCHER, file: upload(bytes) }));

    expect(refused.body.reasons).toEqual(['PHOTO_ALREADY_USED']);
    // No position to judge, but the reuse is judged before anything is stored and is on record.
    expect(w.proofs.rows.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED']);
    expect(w.proofs.rows[1]).toMatchObject({ source: 'STAFF', submittedById: 20, reasons: ['PHOTO_ALREADY_USED'], sha256: null, fileAssetId: null });
    expect(w.interventions.rows[1].afterPhotoUrl).toBeNull();
  });

  it('cannot close a job with a photo', async () => {
    const w = makeWorld();
    const job = w.job();
    const refused = await refusedWith(
      w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: DISPATCHER, file: upload(await scene(72)), completeJob: true }),
    );

    // Refused on the role itself, before the job, the photo or the status table are looked at.
    expect(refused.status).toBe(403);
    expect(w.interventions.rows[0].status).toBe('IN_PROGRESS');
    expect(w.proofs.rows.length).toBe(0);
    expect(w.onDisk()).toEqual([]);
  });
});

describe('ProofsService.review', () => {
  async function waiting(w: ReturnType<typeof makeWorld>, seed = 80, laterStatus?: string) {
    const job = w.job();

    await w.service.submit({
      interventionId: job.id,
      kind: 'AFTER',
      actor: ARTISAN,
      file: upload(await scene(seed)),
      capture: onSite({ latitude: String(north(800)) }),
    });

    // The job moves on after the photo was sent.
    if (laterStatus) w.interventions.rows[w.interventions.rows.length - 1].status = laterStatus;

    return { job, proof: w.proofs.rows[w.proofs.rows.length - 1] };
  }

  it('approving makes it a proof for good, signed and dated by the reviewer', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);

    w.service.clock = new Date(T0.getTime() + 3600_000);

    const reviewed = await w.service.review({ proofId: proof.id, decision: 'APPROVE', note: 'Photo claire, bonne adresse.', reviewer: DISPATCHER });

    expect(reviewed.status).toBe('ACCEPTED');
    expect(reviewed.reviewedById).toBe(20);
    expect(reviewed.reviewNote).toBe('Photo claire, bonne adresse.');
    expect(reviewed.reviewedAt.toISOString()).toBe('2026-10-17T11:00:00.000Z');
    expect(reviewed.withdrawn).toBe(false);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(proof.photoUrl);
  });

  it('refusing marks it refused and, while the job is open, takes it off the job and tells the artisan', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);

    const reviewed = await w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(reviewed.status).toBe('REJECTED');
    expect(reviewed.withdrawn).toBe(true);
    expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
    expect(w.interventions.rows[0].afterPhotoAt).toBeNull();
    expect(w.told.filter((t) => t.what === 'refused').length).toBe(1);
    expect(w.told.find((t) => t.what === 'refused')!.args).toMatchObject({ artisanId: 7, interventionId: proof.interventionId, kind: 'AFTER', actorId: 20 });
  });

  it('refusing the latest photo puts the earlier kept one back on the job', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(81)), capture: onSite({ latitude: String(north(10)) }) });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(82)), capture: onSite({ latitude: String(north(800)) }) });

    const [first, second] = w.proofs.rows;

    expect(w.interventions.rows[0].afterPhotoUrl).toBe(second.photoUrl);

    await w.service.review({ proofId: second.id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(w.interventions.rows[0].afterPhotoUrl).toBe(first.photoUrl);
    expect(w.interventions.rows[0].afterPhotoLat).toBe(first.latitude);
    expect(w.interventions.rows[0].afterPhotoAt.toISOString()).toBe(first.receivedAt.toISOString());
  });

  it('on a closed job the columns stay as the evidence of what was sent', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w, 83, 'COMPLETED');
    const before = w.interventions.rows[0].afterPhotoUrl;
    const reviewed = await w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(reviewed.status).toBe('REJECTED');
    expect(reviewed.withdrawn).toBe(false);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(before);
  });

  it('a job that is cancelled, disputed, waiting for the customer or being paid keeps the photo as the evidence, and the artisan is not told to retake it', async () => {
    for (const status of ['CANCELLED', 'DISPUTED', 'WAITING_CLIENT_VALIDATION', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'COMPLETED']) {
      const w = makeWorld();
      const { proof } = await waiting(w, 100, status);
      const kept = w.interventions.rows[0].afterPhotoUrl;
      const reviewed = await w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: DISPATCHER });

      expect(reviewed.withdrawn).toBe(false);
      expect(w.interventions.rows[0].afterPhotoUrl).toBe(kept);
      expect(w.interventions.rows[0].afterPhotoLat).not.toBeNull();
      expect(w.told.find((t) => t.what === 'refused')!.args.retake).toBe(false);
    }
  });

  it('a job on which the artisan can still take the photo (arrived, in progress) has it taken off, and the artisan is told to retake it', async () => {
    for (const status of ['ARTISAN_ARRIVED', 'IN_PROGRESS']) {
      const w = makeWorld();
      const { proof } = await waiting(w, 101, status);
      const reviewed = await w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: DISPATCHER });

      expect(reviewed.withdrawn).toBe(true);
      expect(w.interventions.rows[0].afterPhotoUrl).toBeNull();
      expect(w.told.find((t) => t.what === 'refused')!.args.retake).toBe(true);
    }
  });

  it('refusing an older photo leaves the job on the newer one', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(125)), capture: onSite({ latitude: String(north(800)) }) });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(126)), capture: onSite() });

    const [older, newer] = w.proofs.rows;
    const reviewed = await w.service.review({ proofId: older.id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(reviewed.withdrawn).toBe(false);
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(newer.photoUrl);
  });

  it('refusing a "before" photo does not touch the "after" columns, and the other way round', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(127)), capture: onSite({ latitude: String(north(800)) }) });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(128)), capture: onSite() });

    const after = w.interventions.rows[0].afterPhotoUrl;

    await w.service.review({ proofId: w.proofs.rows[0].id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(w.interventions.rows[0].beforePhotoUrl).toBeNull();
    expect(w.interventions.rows[0].afterPhotoUrl).toBe(after);
  });

  it('refusing a proof of the back office tells nobody', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: DISPATCHER, file: upload(await scene(84)) });

    // A back-office photo is accepted straight away, so there is nothing waiting; force one.
    w.proofs.rows[0].status = 'NEEDS_REVIEW';
    await w.service.review({ proofId: w.proofs.rows[0].id, decision: 'REJECT', reviewer: DISPATCHER });

    expect(w.told.filter((t) => t.what === 'refused')).toEqual([]);
  });

  it('the decision is made once', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);

    await w.service.review({ proofId: proof.id, decision: 'APPROVE', reviewer: DISPATCHER });

    const locksBefore = w.locks.length;
    const again = await refusedWith(w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: DISPATCHER }));

    expect(again.status).toBe(409);
    expect(w.proofs.rows[0].status).toBe('ACCEPTED');
    // A proof that was already decided is answered without taking the lock of the job.
    expect(w.locks.length).toBe(locksBefore);
  });

  it('two people deciding at the same moment: one decides, the other is told', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);
    const results = await Promise.allSettled([
      w.service.review({ proofId: proof.id, decision: 'APPROVE', reviewer: DISPATCHER }),
      w.service.review({ proofId: proof.id, decision: 'REJECT', reviewer: { id: 21, role: 'SUPPORT' as any } }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
  });

  it('a photo that was not waiting for a look cannot be decided on', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(85)), capture: onSite() });

    const refused = await refusedWith(w.service.review({ proofId: w.proofs.rows[0].id, decision: 'REJECT', reviewer: DISPATCHER }));

    expect(refused.status).toBe(409);
    expect(w.interventions.rows[0].afterPhotoUrl).not.toBeNull();
  });

  it('only the back office decides', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);

    for (const reviewer of [ARTISAN, CLIENT, { id: 30, role: 'ACCOUNTANT' as any }]) {
      const refused = await refusedWith(w.service.review({ proofId: proof.id, decision: 'APPROVE', reviewer }));

      expect(refused.status).toBe(403);
    }

    expect(w.proofs.rows[0].status).toBe('NEEDS_REVIEW');
  });

  it('a decision that is not one, a proof that does not exist', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);

    expect((await refusedWith(w.service.review({ proofId: proof.id, decision: 'MAYBE' as any, reviewer: DISPATCHER }))).status).toBe(400);
    expect((await refusedWith(w.service.review({ proofId: 999, decision: 'APPROVE', reviewer: DISPATCHER }))).status).toBe(404);
    expect((await refusedWith(w.service.review({ proofId: -1, decision: 'APPROVE', reviewer: DISPATCHER }))).status).toBe(404);
  });

  it('a long note is cut', async () => {
    const w = makeWorld();
    const { proof } = await waiting(w);
    const reviewed = await w.service.review({ proofId: proof.id, decision: 'APPROVE', note: 'x'.repeat(2000), reviewer: DISPATCHER });

    expect(reviewed.reviewNote!.length).toBe(500);
  });
});

describe('ProofsService.list', () => {
  it('gives the queue oldest first, with the words for the back office and the job beside it', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(90)), capture: onSite({ latitude: String(north(800)) }) });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(91)), capture: onSite() });
    await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(92)), capture: onSite({ accuracy: '250' }) });

    const queue = await w.service.list({ status: 'NEEDS_REVIEW' });

    expect(queue.meta.total).toBe(2);
    expect(queue.data.map((p: any) => p.kind)).toEqual(['BEFORE', 'AFTER']);
    expect(queue.data[0].reasonLabels[0]).toMatch(/de l’adresse/);
    expect(queue.data[1].reasonLabels[0]).toMatch(/peu précis \(250 m\)/);
    expect(queue.data[0].intervention).toEqual({ id: job.id, address: '12 avenue Habib Bourguiba, Tunis', status: 'IN_PROGRESS', serviceType: 'PLUMBING' });
  });

  it('does not hand out the fingerprints', async () => {
    const w = makeWorld();
    const job = w.job();

    await w.service.submit({ interventionId: job.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(93)), capture: onSite() });

    const all = await w.service.list({});

    expect(JSON.stringify(all)).not.toMatch(/sha256|dhash|detail/);
  });

  it('filters by job and by kind, newest first, and pages', async () => {
    const w = makeWorld();
    const job = w.job();
    const other = w.job();

    for (let i = 0; i < 3; i++) {
      await w.service.submit({ interventionId: job.id, kind: 'AFTER', actor: ARTISAN, file: upload(await scene(94 + i)), capture: onSite() });
    }

    await w.service.submit({ interventionId: other.id, kind: 'BEFORE', actor: ARTISAN, file: upload(await scene(98)), capture: onSite() });

    expect((await w.service.list({ interventionId: job.id })).meta.total).toBe(3);
    expect((await w.service.list({ kind: 'BEFORE' })).data.length).toBe(1);

    const page = await w.service.list({ interventionId: job.id, take: 2, skip: 1 });

    expect(page.data.map((p: any) => p.id)).toEqual([2, 1]);
    expect(page.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2, take: 2, skip: 1 });
  });

  it('never hands out more than 200 at a time, and at least one', async () => {
    const w = makeWorld();
    const asked: any[] = [];
    const find = w.proofs.findMany.bind(w.proofs);

    (w.proofs as any).findMany = async (args: any) => {
      asked.push(args);
      return find(args);
    };

    expect((await w.service.list({ take: 100000 })).meta.take).toBe(200);
    expect((await w.service.list({ take: 200 })).meta.take).toBe(200);
    expect((await w.service.list({ take: 150 })).meta.take).toBe(150);
    expect((await w.service.list({ take: 0 })).meta.take).toBe(1);
    expect((await w.service.list({ take: -5 })).meta.take).toBe(1);
    expect((await w.service.list({})).meta.take).toBe(50);
    expect(asked.map((a) => a.take)).toEqual([200, 200, 150, 1, 1, 50]);
  });

  it('refuses a status, a kind or a job that is not one', async () => {
    const w = makeWorld();

    expect((await refusedWith(w.service.list({ status: 'DONE' }))).status).toBe(400);
    expect((await refusedWith(w.service.list({ kind: 'DURING' }))).status).toBe(400);
    expect((await refusedWith(w.service.list({ interventionId: -4 }))).status).toBe(400);
  });
});
