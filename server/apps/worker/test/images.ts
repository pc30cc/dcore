import sharp from 'sharp';

/**
 * Test pictures: deterministic pixels (a seed draws gradients and blocks,
 * so two seeds are different pictures and one seed is the same picture),
 * saved as JPEG with an EXIF block that carries a GPS position, a camera
 * make and an orientation, written byte by byte so the test does not rely
 * on the library under test to put them there.
 */

export const EXIF_MAKE = 'TestMakeGPS';

function pixels(width: number, height: number, seed: number): Buffer {
  const data = Buffer.alloc(width * height * 3);
  let state = seed * 2_654_435_761 + 1;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 0xffffffff;
  };
  const blocks = Array.from({ length: 12 }, () => ({
    x: rand() * width,
    y: rand() * height,
    w: (0.1 + rand() * 0.4) * width,
    h: (0.1 + rand() * 0.4) * height,
    c: [rand() * 255, rand() * 255, rand() * 255],
  }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = (x / width) * 255 * (seed % 2);
      let g = (y / height) * 255;
      let b = ((x + y) / (width + height)) * 255 * ((seed + 1) % 2);
      for (const block of blocks) {
        if (x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
          [r, g, b] = block.c as [number, number, number];
        }
      }
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return data;
}

/** A little-endian TIFF block: IFD0 (Make, Orientation, GPS pointer) and a GPS IFD (35°41'22.2"N 51°23'20.4"E). */
export function exifBlock(orientation: number): Buffer {
  const tiff = Buffer.alloc(176);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: (b: Buffer, o: number) => void) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    value(tiff, at + 8);
  };
  // IFD0 at 8: 3 entries, then the next-IFD pointer (0).
  tiff.writeUInt16LE(3, 8);
  entry(10, 0x010f, 2, EXIF_MAKE.length + 1, (b, o) => b.writeUInt32LE(50, o));
  entry(22, 0x0112, 3, 1, (b, o) => b.writeUInt16LE(orientation, o));
  entry(34, 0x8825, 4, 1, (b, o) => b.writeUInt32LE(62, o));
  tiff.writeUInt32LE(0, 46);
  tiff.write(`${EXIF_MAKE}\0`, 50, 'latin1');
  // GPS IFD at 62: 5 entries.
  tiff.writeUInt16LE(5, 62);
  entry(64, 0x0000, 1, 4, (b, o) => b.set([2, 3, 0, 0], o));
  entry(76, 0x0001, 2, 2, (b, o) => b.write('N\0', o, 'latin1'));
  entry(88, 0x0002, 5, 3, (b, o) => b.writeUInt32LE(128, o));
  entry(100, 0x0003, 2, 2, (b, o) => b.write('E\0', o, 'latin1'));
  entry(112, 0x0004, 5, 3, (b, o) => b.writeUInt32LE(152, o));
  tiff.writeUInt32LE(0, 124);
  const rationals = (at: number, values: [number, number][]) =>
    values.forEach(([n, d], i) => {
      tiff.writeUInt32LE(n, at + i * 8);
      tiff.writeUInt32LE(d, at + i * 8 + 4);
    });
  rationals(128, [[35, 1], [41, 1], [222, 10]]);
  rationals(152, [[51, 1], [23, 1], [204, 10]]);
  return tiff;
}

/** Puts an APP1 Exif segment after the SOI (and the JFIF APP0, when there is one). */
export function withExif(jpeg: Buffer, tiff: Buffer): Buffer {
  const header = Buffer.from('Exif\0\0', 'latin1');
  const length = 2 + header.length + tiff.length;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), header, tiff]);
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), app1, jpeg.subarray(at)]);
}

export interface PictureOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** EXIF orientation (1 upright, 6 rotate 90° clockwise to show). */
  orientation?: number;
  gps?: boolean;
  quality?: number;
}

/** A JPEG as a phone would send it, with GPS in its EXIF unless `gps: false`. */
export async function picture(options: PictureOptions = {}): Promise<Buffer> {
  const width = options.width ?? 1600;
  const height = options.height ?? 1280;
  const jpeg = await sharp(pixels(width, height, options.seed ?? 1), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: options.quality ?? 90 })
    .toBuffer();
  return options.gps === false ? jpeg : withExif(jpeg, exifBlock(options.orientation ?? 1));
}

/** The chunk ids of a RIFF/WebP file (VP8, VP8L, VP8X, ALPH, ICCP, EXIF, XMP ...). */
export function webpChunks(file: Uint8Array): string[] {
  const buffer = Buffer.from(file);
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  const chunks: string[] = [];
  let at = 12;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('latin1', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    chunks.push(id);
    at += 8 + size + (size % 2);
  }
  return chunks;
}
