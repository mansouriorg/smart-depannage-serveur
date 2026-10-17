import sharp from 'sharp';

import { DEFAULT_POLICY } from './proof-policy';
import { flat, halves, scene } from './test-photos';
import { BLANK_DETAIL, fingerprintImage, findSimilar, hammingDistance, sha256Of } from './image-fingerprint';

describe('hammingDistance', () => {
  it('counts the bits that differ', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1);
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('00000000000000ff', '0000000000000000')).toBe(8);
  });

  it('is symmetric', () => {
    expect(hammingDistance('a5a5a5a5a5a5a5a5', '5a5a5a5a5a5a5a5b')).toBe(hammingDistance('5a5a5a5a5a5a5a5b', 'a5a5a5a5a5a5a5a5'));
  });

  it('something that is not a hash is as far as can be', () => {
    expect(hammingDistance('nonsense', '0000000000000000')).toBe(64);
    expect(hammingDistance('0000000000000000', '')).toBe(64);
    expect(hammingDistance('0000000000000000', 'FFFFFFFFFFFFFFFF')).toBe(64);
  });
});

describe('findSimilar', () => {
  const candidates = [
    { id: 9, dhash: 'ffffffffffffff00' },
    { id: 8, dhash: null },
    { id: 7, dhash: '000000000000000f' },
    { id: 6, dhash: '0000000000000003' },
  ];

  it('gives the closest one within the limit', () => {
    expect(findSimilar('0000000000000000', candidates, 4)).toEqual({ id: 6, bits: 2 });
  });

  it('nothing within the limit: null', () => {
    expect(findSimilar('0000000000000000', candidates, 1)).toBeNull();
    expect(findSimilar('0000000000000000', [], 4)).toBeNull();
  });

  it('the newest wins a tie', () => {
    const tie = [
      { id: 12, dhash: '0000000000000001' },
      { id: 11, dhash: '0000000000000002' },
    ];

    expect(findSimilar('0000000000000000', tie, 4)).toEqual({ id: 12, bits: 1 });
  });

  it('a limit of zero only takes the identical picture', () => {
    expect(findSimilar('0000000000000003', candidates, 0)).toEqual({ id: 6, bits: 0 });
    expect(findSimilar('0000000000000000', candidates, 0)).toBeNull();
  });
});

describe('fingerprintImage (real decoding)', () => {
  it('gives the bytes, a 16-character hash, the detail and the size', async () => {
    const bytes = await scene(1);
    const fingerprint = await fingerprintImage(bytes);

    expect(fingerprint.sha256).toBe(sha256Of(bytes));
    expect(fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint.detail).toBeGreaterThan(BLANK_DETAIL);
    expect(fingerprint.width).toBe(320);
    expect(fingerprint.height).toBe(320);
  });

  it('the same bytes give the same fingerprint', async () => {
    const bytes = await scene(2);

    expect(await fingerprintImage(bytes)).toEqual(await fingerprintImage(Buffer.from(bytes)));
  });

  it('a copy that was shrunk and saved again is the same picture to the eye, not to the bytes', async () => {
    const original = await scene(3, 640);
    const copy = await sharp(original).resize(300).jpeg({ quality: 60 }).toBuffer();
    const a = await fingerprintImage(original);
    const b = await fingerprintImage(copy);

    expect(b.sha256).not.toBe(a.sha256);
    expect(hammingDistance(a.dhash, b.dhash)).toBeLessThanOrEqual(DEFAULT_POLICY.similarityBits);
  });

  it('the same scene saved as PNG, JPEG and WebP is the same picture', async () => {
    const [jpeg, png, webp] = await Promise.all([scene(4, 320, 'jpeg'), scene(4, 320, 'png'), scene(4, 320, 'webp')]);
    const hashes = (await Promise.all([jpeg, png, webp].map((b) => fingerprintImage(b)))).map((f) => f.dhash);

    expect(hammingDistance(hashes[0], hashes[1])).toBeLessThanOrEqual(DEFAULT_POLICY.similarityBits);
    expect(hammingDistance(hashes[1], hashes[2])).toBeLessThanOrEqual(DEFAULT_POLICY.similarityBits);
  });

  it('a brighter copy is the same picture', async () => {
    const original = await scene(5);
    const brighter = await sharp(original).modulate({ brightness: 1.15 }).jpeg().toBuffer();

    expect(hammingDistance((await fingerprintImage(original)).dhash, (await fingerprintImage(brighter)).dhash)).toBeLessThanOrEqual(
      DEFAULT_POLICY.similarityBits,
    );
  });

  it('different scenes are far apart', async () => {
    const hashes: string[] = [];

    for (let seed = 10; seed < 18; seed++) hashes.push((await fingerprintImage(await scene(seed))).dhash);

    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        expect(hammingDistance(hashes[i], hashes[j])).toBeGreaterThan(DEFAULT_POLICY.similarityBits + 4);
      }
    }
  });

  it('a phone held upright: the size is the one the picture is shown at', async () => {
    const wide = await sharp(await scene(6, 400)).resize(400, 200, { fit: 'fill' }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const fingerprint = await fingerprintImage(wide);

    expect(fingerprint.width).toBe(200);
    expect(fingerprint.height).toBe(400);
  });

  it('a black frame and a white frame have no detail', async () => {
    expect((await fingerprintImage(await flat(0))).detail).toBeLessThan(BLANK_DETAIL);
    expect((await fingerprintImage(await flat(255))).detail).toBeLessThan(BLANK_DETAIL);
  });

  it('the detail is the spread of the greys, and the limit for a blank frame sits between a shaded wall and a covered lens', async () => {
    // Half and half: the spread is half the difference between the two greys.
    const covered = (await fingerprintImage(await halves(100, 110))).detail; // ~5
    const shaded = (await fingerprintImage(await halves(100, 116))).detail; // ~8

    expect(covered).toBeGreaterThan(4);
    expect(covered).toBeLessThan(BLANK_DETAIL);
    expect(shaded).toBeGreaterThan(BLANK_DETAIL);
    expect(shaded).toBeLessThan(10);
  });

  it('something that is not a picture cannot be read', async () => {
    await expect(fingerprintImage(Buffer.from('this is a text file, not a photo'))).rejects.toBeDefined();
    await expect(fingerprintImage(Buffer.alloc(0))).rejects.toBeDefined();
  });

  it('a picture cut short cannot be read either', async () => {
    const bytes = await scene(7, 640);

    await expect(fingerprintImage(bytes.subarray(0, Math.floor(bytes.length / 3)))).rejects.toBeDefined();
  });
});
