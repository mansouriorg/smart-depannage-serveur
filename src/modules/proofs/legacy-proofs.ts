import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { fingerprintImage } from './image-fingerprint';

/**
 * Brings the proofs taken before P1-07 under the new rules (run once: `npm run proofs:migrate`).
 *
 * Before, a proof photo was a file in `uploads/proofs/`, served to anybody who knew the address,
 * or a file of the files module whose address was written without the `/api` prefix. Now every
 * proof is a private file read through `/api/files/:id/download`, with a row in ProofCapture.
 *
 * For each intervention with a before/after photo:
 *  - `/uploads/proofs/<name>`: the file is COPIED to the private folder, a file row and a capture
 *    row are written and the intervention follows, in one transaction; only then is the old file
 *    removed. The same photo found on two jobs is kept on both, the second one marked for review.
 *  - `/files/<id>/download` (the older files routes): the address gets its `/api` prefix and a
 *    capture row is written for the file that already exists.
 *  - `/api/files/<id>/download`: already migrated; the capture row is made if it is missing.
 *  - a file of the files module that was made PUBLIC (the old visibility route allowed it for a
 *    proof) is moved to the private folder, wherever the address of it was written.
 *  - anything else (an address on another site, a file that is not a proof photo: the removed
 *    JSON route accepted any address): left as it is and listed, a person decides.
 *
 * Each address on a job is changed only if it still is the one that was read (a photo sent
 * while this runs wins). A file two jobs pointed at is removed only when the last one is done.
 *
 * It can be run again at any time: what is done is skipped.
 */

export type LegacyDb = {
  intervention: {
    findMany: (args: any) => Promise<any[]>;
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  proofCapture: { findFirst: (args: any) => Promise<any>; create: (args: any) => Promise<any> };
  fileAsset: { create: (args: any) => Promise<any>; findUnique: (args: any) => Promise<any>; update: (args: any) => Promise<any> };
  $transaction: (work: (tx: any) => Promise<any>) => Promise<any>;
};

export type LegacyReport = {
  looked: number;
  moved: number;
  prefixed: number;
  madePrivate: number;
  captured: number;
  alreadyDone: number;
  duplicates: number;
  missingFiles: number;
  external: Array<{ interventionId: number; column: string }>;
  failures: Array<{ interventionId: number; column: string; reason: string }>;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const PROOF_PURPOSES: string[] = ['ARTISAN_BEFORE_PHOTO', 'ARTISAN_AFTER_PHOTO'];

const COLUMNS = [
  { kind: 'BEFORE', url: 'beforePhotoUrl', lat: 'beforePhotoLat', lng: 'beforePhotoLng', at: 'beforePhotoAt', purpose: 'ARTISAN_BEFORE_PHOTO', folder: 'artisan_before_photo' },
  { kind: 'AFTER', url: 'afterPhotoUrl', lat: 'afterPhotoLat', lng: 'afterPhotoLng', at: 'afterPhotoAt', purpose: 'ARTISAN_AFTER_PHOTO', folder: 'artisan_after_photo' },
] as const;

/** What an address of a proof photo is. */
export function classifyProofUrl(url: string): { type: 'legacy-file'; name: string } | { type: 'asset'; id: number; prefixed: boolean } | { type: 'external' } {
  // A name starts with a letter or a digit and has no slash: it cannot leave the folder.
  const legacy = /^\/uploads\/proofs\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(url);

  if (legacy) return { type: 'legacy-file', name: legacy[1] };

  const asset = /^(\/api)?\/files\/(\d{1,10})\/download$/.exec(url);

  if (asset) return { type: 'asset', id: Number(asset[2]), prefixed: !!asset[1] };

  return { type: 'external' };
}

async function exists(file: string) {
  return fs.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

export async function migrateLegacyProofs(params: {
  db: LegacyDb;
  /** The `uploads` folder. */
  uploadRoot: string;
  /** false: look and count, write nothing. */
  apply: boolean;
  log?: (line: string) => void;
}): Promise<LegacyReport> {
  const { db, uploadRoot, apply } = params;
  const log = params.log ?? (() => undefined);
  const report: LegacyReport = {
    looked: 0,
    moved: 0,
    prefixed: 0,
    madePrivate: 0,
    captured: 0,
    alreadyDone: 0,
    duplicates: 0,
    missingFiles: 0,
    external: [],
    failures: [],
  };

  let after = 0;

  for (;;) {
    const batch = await db.intervention.findMany({
      where: { id: { gt: after }, OR: [{ beforePhotoUrl: { not: null } }, { afterPhotoUrl: { not: null } }] },
      orderBy: { id: 'asc' },
      take: 200,
    });

    if (!batch.length) break;

    for (const job of batch) {
      after = job.id;

      for (const column of COLUMNS) {
        const url = job[column.url] as string | null;

        if (!url) continue;

        report.looked++;

        try {
          await one(job, column, url);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);

          report.failures.push({ interventionId: job.id, column: column.url, reason });
          log(`#${job.id} ${column.url}: FAILED (${reason})`);
        }
      }
    }
  }

  async function one(job: any, column: (typeof COLUMNS)[number], url: string) {
    const kind = classifyProofUrl(url);

    if (kind.type === 'external') {
      report.external.push({ interventionId: job.id, column: column.url });
      log(`#${job.id} ${column.url}: address outside the server, left as it is.`);
      return;
    }

    if (kind.type === 'asset') {
      const target = `/api/files/${kind.id}/download`;
      const asset = await db.fileAsset.findUnique({ where: { id: kind.id } });

      if (!asset) {
        report.missingFiles++;
        log(`#${job.id} ${column.url}: file #${kind.id} is not in the database.`);
        return;
      }

      // The removed JSON route took any address: only a proof photo is made a proof here.
      const looksLikeImage = asset.isImage === true || /^image\//i.test(String(asset.mimeType ?? ''));

      if (!looksLikeImage || !PROOF_PURPOSES.includes(asset.purpose)) {
        report.external.push({ interventionId: job.id, column: column.url });
        log(`#${job.id} ${column.url}: file #${kind.id} is not a proof photo, left as it is.`);
        return;
      }

      const known = await db.proofCapture.findFirst({ where: { fileAssetId: asset.id, interventionId: job.id, kind: column.kind } });
      const isPublic = asset.visibility === 'PUBLIC';

      if (kind.prefixed && known && !isPublic) {
        report.alreadyDone++;
        return;
      }

      log(
        `#${job.id} ${column.url}: ${url}${kind.prefixed ? '' : ` -> ${target}`}${known ? '' : ' + capture row'}${isPublic ? ' + made private' : ''}`,
      );

      if (!apply) {
        if (!kind.prefixed) report.prefixed++;
        if (!known) report.captured++;
        if (isPublic) report.madePrivate++;
        return;
      }

      // The file of another capture, or the same bytes: this one is a second use of the photo.
      const otherUse = known ? null : await db.proofCapture.findFirst({ where: { fileAssetId: asset.id } });
      const taken = known ? null : (otherUse ?? (asset.checksum ? await db.proofCapture.findFirst({ where: { sha256: asset.checksum } }) : null));

      // A proof that was made public goes back behind the login: copy, record, remove last.
      let privateMove: { relativePath: string; absolute: string; oldAbsolute: string } | null = null;

      if (isPublic) {
        const oldAbsolute = path.join(uploadRoot, String(asset.relativePath ?? ''));
        let relativePath = `private/${String(asset.purpose).toLowerCase()}/${asset.fileName}`;

        if (await exists(path.join(uploadRoot, relativePath))) {
          relativePath = `private/${String(asset.purpose).toLowerCase()}/${asset.id}-${asset.fileName}`;
        }

        const absolute = path.join(uploadRoot, relativePath);

        if (await exists(oldAbsolute)) {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.copyFile(oldAbsolute, absolute);
        }

        privateMove = { relativePath, absolute, oldAbsolute };
      }

      try {
        await db.$transaction(async (tx) => {
          if (privateMove) {
            await tx.fileAsset.update({
              where: { id: asset.id },
              data: { visibility: 'PRIVATE', relativePath: privateMove.relativePath, publicUrl: null },
            });
          }

          if (!known) {
            await tx.proofCapture.create({
              data: captureRow(job, column, {
                fileAssetId: asset.id,
                photoUrl: target,
                sha256: taken ? null : (asset.checksum ?? null),
                dhash: null,
                detail: null,
                duplicate: !!taken,
                source: asset.uploadedById && asset.uploadedById !== job.artisanId ? 'STAFF' : 'ARTISAN',
                submittedById: asset.uploadedById ?? job.artisanId ?? null,
              }),
            });
          }

          if (!kind.prefixed) await repoint(tx, job, column, url, target);
        });
      } catch (error) {
        if (privateMove) await fs.unlink(privateMove.absolute).catch(() => undefined);
        throw error;
      }

      if (privateMove) await fs.unlink(privateMove.oldAbsolute).catch(() => undefined);

      if (!kind.prefixed) report.prefixed++;
      if (!known) report.captured++;
      if (isPublic) report.madePrivate++;
      return;
    }

    // A file of the old public folder.
    const source = path.join(uploadRoot, 'proofs', kind.name);

    if (!(await exists(source))) {
      report.missingFiles++;
      log(`#${job.id} ${column.url}: ${url} is not on the disk.`);
      return;
    }

    const bytes = await fs.readFile(source);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const extension = path.extname(kind.name).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
    const taken = await db.proofCapture.findFirst({ where: { sha256 } });

    let dhash: string | null = null;
    let detail: number | null = null;
    let width: number | undefined;
    let height: number | undefined;

    try {
      const print = await fingerprintImage(bytes);

      dhash = print.dhash;
      detail = print.detail;
      width = print.width;
      height = print.height;
    } catch {
      // A format the image library cannot read (HEIC): the exact bytes are still compared.
    }

    log(`#${job.id} ${column.url}: ${url} -> private ${column.folder}/${kind.name}${taken ? ' (same photo as an earlier proof: for review)' : ''}`);

    if (taken) report.duplicates++;

    if (!apply) {
      report.moved++;
      report.captured++;
      return;
    }

    // Copy first, record, remove last: a stop at any point is repaired by running again.
    // A name that is taken (two jobs pointed at the same file) gets the number of the job.
    let fileName = kind.name;

    if (await exists(path.join(uploadRoot, 'private', column.folder, fileName))) {
      fileName = `${path.basename(kind.name, extension)}-job${job.id}${extension}`;
    }

    const relativePath = `private/${column.folder}/${fileName}`;
    const copy = path.join(uploadRoot, relativePath);

    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.copyFile(source, copy);

    try {
      await db.$transaction(async (tx) => {
        const asset = await tx.fileAsset.create({
          data: {
            uploadedById: job.artisanId ?? null,
            purpose: column.purpose,
            visibility: 'PRIVATE',
            storageProvider: 'LOCAL',
            entityType: 'INTERVENTION',
            entityId: job.id,
            originalName: kind.name,
            fileName,
            relativePath,
            mimeType,
            extension,
            size: bytes.length,
            checksum: sha256,
            isImage: true,
            width,
            height,
          },
        });
        const photoUrl = `/api/files/${asset.id}/download`;

        await tx.proofCapture.create({
          data: captureRow(job, column, {
            fileAssetId: asset.id,
            photoUrl,
            sha256: taken ? null : sha256,
            dhash,
            detail,
            duplicate: !!taken,
            source: 'ARTISAN',
            submittedById: job.artisanId ?? null,
          }),
        });
        await repoint(tx, job, column, url, photoUrl);
      });
    } catch (error) {
      await fs.unlink(copy).catch(() => undefined);
      throw error;
    }

    // The old file goes when no job points at it any more (two jobs may share one address).
    const stillUsed = await db.intervention.findFirst({
      where: { OR: [{ beforePhotoUrl: url }, { afterPhotoUrl: url }] },
    });

    if (!stillUsed) await fs.unlink(source).catch(() => undefined);

    report.moved++;
    report.captured++;
  }

  return report;
}

/** Points a column at its new address, only if it still holds the address that was read. */
async function repoint(tx: any, job: any, column: (typeof COLUMNS)[number], from: string, to: string) {
  const done = await tx.intervention.updateMany({
    where: { id: job.id, [column.url]: from },
    data: { [column.url]: to },
  });

  if (done.count !== 1) {
    throw new Error('the photo of this job changed while the migration ran: run it again');
  }
}

/** The capture row of a proof taken before the rules existed: no position check, no accuracy, no flag. */
function captureRow(
  job: any,
  column: (typeof COLUMNS)[number],
  facts: {
    fileAssetId: number;
    photoUrl: string;
    sha256: string | null;
    dhash: string | null;
    detail: number | null;
    duplicate: boolean;
    source: 'ARTISAN' | 'STAFF';
    submittedById: number | null;
  },
) {
  const clientTime = job[column.at] ?? null;

  return {
    interventionId: job.id,
    kind: column.kind,
    source: facts.source,
    submittedById: facts.submittedById,
    // Taken before the checks existed. The same photo on two jobs is the one thing that can still be told.
    status: facts.duplicate ? 'NEEDS_REVIEW' : 'ACCEPTED',
    reasons: facts.duplicate ? ['PHOTO_ALREADY_USED'] : [],
    latitude: job[column.lat] ?? null,
    longitude: job[column.lng] ?? null,
    accuracyM: null,
    mocked: null,
    clientCapturedAt: clientTime,
    distanceM: null,
    clockOffsetSeconds: null,
    receivedAt: clientTime ?? job.createdAt ?? new Date(),
    fileAssetId: facts.fileAssetId,
    photoUrl: facts.photoUrl,
    sha256: facts.sha256,
    dhash: facts.dhash,
    detail: facts.detail,
  };
}
