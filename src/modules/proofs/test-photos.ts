/**
 * Photos for the specs: pictures made on the spot, so no file is kept in the repository.
 * Test support only: nothing in the application imports it.
 */
import sharp from 'sharp';

/** A deterministic "scene" of 8x8 coloured blocks: a lot of structure, so two seeds look nothing alike. */
export async function scene(seed: number, size = 320, format: 'jpeg' | 'png' | 'webp' = 'jpeg'): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(size * size * channels);
  let state = seed * 2654435761 + 12345;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };

  const blocks = 8;
  const colours = Array.from({ length: blocks * blocks }, () => [next() * 255, next() * 255, next() * 255]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const block = Math.floor((y / size) * blocks) * blocks + Math.floor((x / size) * blocks);
      for (let c = 0; c < channels; c++) raw[(y * size + x) * channels + c] = Math.round(colours[block][c]);
    }
  }

  const image = sharp(raw, { raw: { width: size, height: size, channels } });

  return format === 'jpeg' ? image.jpeg({ quality: 90 }).toBuffer() : format === 'png' ? image.png().toBuffer() : image.webp().toBuffer();
}

/** A frame of one grey: a covered lens. */
export async function flat(grey: number): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 200, channels: 3, background: { r: grey, g: grey, b: grey } } })
    .jpeg()
    .toBuffer();
}

/** Two greys side by side (left half, right half): the grey levels are `left` and `right`, so the "detail" is |left - right| / 2. */
export async function halves(left: number, right: number): Promise<Buffer> {
  const width = 200;
  const height = 200;
  const raw = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.fill(x < width / 2 ? left : right, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/** What multer hands to a controller for a photo held in memory. */
export function upload(buffer: Buffer, mimetype = 'image/jpeg'): Express.Multer.File {
  return {
    fieldname: 'photo',
    originalname: 'proof.jpg',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}
