import * as crypto from 'crypto';

import sharp from 'sharp';

/**
 * What identifies a photo (P1-07).
 *
 *  - sha256: the exact bytes the phone sent. The same file twice has the same one.
 *  - dhash: 64 bits that describe what the picture looks like (is each pixel of a 9x8 grey
 *    thumbnail brighter than its right neighbour?). A copy that was re-saved, shrunk or slightly
 *    brightened differs by a few bits at most; two different scenes differ by about thirty.
 *  - detail: how much the thumbnail varies (0 for a black or white frame, ~50 for a real scene).
 *
 * None of this is secret and none of it proves a photo is genuine; it catches the cheap ways of
 * answering "send a photo" with a photo that was not taken for this job.
 */
export type Fingerprint = {
  sha256: string;
  /** 16 hexadecimal characters. */
  dhash: string;
  /** Standard deviation of the grey levels of a 16x16 thumbnail (0 to 128). */
  detail: number;
  /** The decoded size in pixels. */
  width: number;
  height: number;
};

/** The most pixels a proof may have once decoded (a 48-megapixel phone is far below this). */
export const PROOF_MAX_PIXELS = 100_000_000;

/** Below this the picture is a covered lens or a black frame. */
export const BLANK_DETAIL = 6;

export function sha256Of(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Reads the picture. Throws when it cannot be decoded (damaged, not an image, too many pixels).
 * The decoding happens in the image library's own threads; the caller limits how many run at once.
 */
export async function fingerprintImage(buffer: Buffer): Promise<Fingerprint> {
  const source = () => sharp(buffer, { limitInputPixels: PROOF_MAX_PIXELS, failOn: 'error' }).rotate();

  const metadata = await source().metadata();
  const turned = (metadata.orientation ?? 1) >= 5;

  // The 9x8 thumbnail for the hash: a 36x32 one averaged by blocks of 4x4. Shrinking straight to
  // 9x8 keeps the noise of the compression; averaging it out is what lets a copy that was saved
  // again, or in another format, keep the same hash (it moved by 10 bits before, by 1 to 4 now).
  const wide = await source().greyscale().resize(36, 32, { fit: 'fill' }).raw().toBuffer();
  const hashPixels = Buffer.alloc(72);

  if (wide.length === 36 * 32) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        let total = 0;

        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) total += wide[(row * 4 + dy) * 36 + col * 4 + dx];
        }

        hashPixels[row * 9 + col] = Math.round(total / 16);
      }
    }
  }

  // The 16x16 thumbnail for the detail.
  const detailPixels = await source().greyscale().resize(16, 16, { fit: 'fill' }).raw().toBuffer();

  if (wide.length !== 36 * 32 || detailPixels.length !== 256) {
    throw new Error('Unexpected thumbnail size.');
  }

  let bits = 0n;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits = (bits << 1n) | (hashPixels[row * 9 + col] > hashPixels[row * 9 + col + 1] ? 1n : 0n);
    }
  }

  let sum = 0;

  for (const value of detailPixels) sum += value;

  const mean = sum / detailPixels.length;
  let squares = 0;

  for (const value of detailPixels) squares += (value - mean) ** 2;

  return {
    sha256: sha256Of(buffer),
    dhash: bits.toString(16).padStart(16, '0'),
    detail: Math.round(Math.sqrt(squares / detailPixels.length) * 100) / 100,
    // The size as the picture is shown: a phone held upright records a rotated picture.
    width: turned ? (metadata.height ?? 0) : (metadata.width ?? 0),
    height: turned ? (metadata.width ?? 0) : (metadata.height ?? 0),
  };
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) => n.toString(2).split('1').length - 1);

/** The number of bits in which two hashes differ (0 to 64); 64 when one of them is not a hash. */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;

  let distance = 0;

  for (let i = 0; i < 16; i++) {
    distance += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }

  return distance;
}

/**
 * The earlier proof this picture looks like: the closest one within `maxBits`, or null.
 * `candidates` are the hashes of the photos kept before (newest first); a tie goes to the newest.
 */
export function findSimilar(
  dhash: string,
  candidates: Array<{ id: number; dhash: string | null }>,
  maxBits: number,
): { id: number; bits: number } | null {
  let best: { id: number; bits: number } | null = null;

  for (const candidate of candidates) {
    if (!candidate.dhash) continue;

    const bits = hammingDistance(dhash, candidate.dhash);

    if (bits <= maxBits && (best === null || bits < best.bits)) best = { id: candidate.id, bits };
  }

  return best;
}
