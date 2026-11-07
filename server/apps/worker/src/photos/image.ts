import { PHOTO_VARIANT_SIZES, type PhotoVariantSize } from '@app/shared/server';
import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';

/**
 * From an uploaded file to what is published: the picture turned upright
 * (EXIF orientation applied), re-encoded as WebP variants that carry no
 * metadata at all (no EXIF, so no GPS position, camera or time; no XMP; no
 * ICC profile, the pixels converted to sRGB), a blurhash placeholder and a
 * 64-bit perceptual hash for near-duplicate search.
 *
 * Only JPEG and WebP are decoded, recognised by their bytes before the
 * decoder sees them (libvips would also open SVG, PDF, TIFF and others).
 */

export const MIN_SHORT_SIDE = 320;
/** photos.width and height are smallints; no phone takes pictures this wide. */
export const MAX_SIDE = 16_384;
const WEBP_QUALITY = 80;

export type UnreadableReason = 'format' | 'decode' | 'too_large' | 'too_small';

export class UnreadableImageError extends Error {
  readonly reason: UnreadableReason;

  constructor(reason: UnreadableReason, cause?: unknown) {
    super(`photo not usable: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'UnreadableImageError';
    this.reason = reason;
  }
}

export interface PhotoVariant {
  size: PhotoVariantSize;
  body: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  /** Upright size of the original. */
  width: number;
  height: number;
  variants: PhotoVariant[];
  blurhash: string;
  /** 64-bit DCT perceptual hash, as the signed bigint PostgreSQL stores. */
  phash: bigint;
}

export type ImageFormat = 'jpeg' | 'webp';

/** The format by its first bytes, or null for anything else. */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

// DCT-II basis of the 8 lowest frequencies over 32 samples.
const N = 32;
const K = 8;
const COS: Float64Array[] = Array.from({ length: K }, (_, u) => {
  const row = new Float64Array(N);
  for (let x = 0; x < N; x += 1) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return row;
});

/**
 * pHash of a 32 x 32 greyscale picture: the 8 x 8 lowest DCT frequencies,
 * one bit per coefficient (above the median of the 64), row-major from the
 * most significant bit. Re-encoding, resizing and light edits move few bits;
 * different pictures differ in about half of them.
 */
export function perceptualHash(gray: Uint8Array): bigint {
  if (gray.length !== N * N) throw new RangeError('needs 32 x 32 grey samples');
  const coefficients = new Float64Array(K * K);
  for (let u = 0; u < K; u += 1) {
    const cu = COS[u]!;
    for (let v = 0; v < K; v += 1) {
      const cv = COS[v]!;
      let sum = 0;
      for (let y = 0; y < N; y += 1) {
        const wy = cu[y]!;
        const offset = y * N;
        for (let x = 0; x < N; x += 1) sum += gray[offset + x]! * wy * cv[x]!;
      }
      coefficients[u * K + v] = sum;
    }
  }
  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let hash = 0n;
  for (const c of coefficients) hash = (hash << 1n) | (c > median ? 1n : 0n);
  return BigInt.asIntN(64, hash);
}

/** Bits that differ between two hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export interface ProcessOptions {
  /** Pixels (width x height) refused undecoded. */
  maxPixels: number;
}

export async function processImage(input: Uint8Array, options: ProcessOptions): Promise<ProcessedImage> {
  const format = sniffFormat(input);
  if (!format) throw new UnreadableImageError('format');
  const open = () => sharp(input, { failOn: 'error', limitInputPixels: options.maxPixels, autoOrient: true });
  let meta;
  try {
    meta = await open().metadata();
  } catch (error) {
    const tooLarge = error instanceof Error && /pixel limit/i.test(error.message);
    throw new UnreadableImageError(tooLarge ? 'too_large' : 'decode', error);
  }
  if (meta.format !== format) throw new UnreadableImageError('format');
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new UnreadableImageError('decode');
  if (width * height > options.maxPixels || width > MAX_SIDE || height > MAX_SIDE) throw new UnreadableImageError('too_large');
  if (Math.min(width, height) < MIN_SHORT_SIDE) throw new UnreadableImageError('too_small');

  try {
    // No keepMetadata/withMetadata anywhere: the encoder writes pixels only.
    const variants = await Promise.all(
      PHOTO_VARIANT_SIZES.map(async (size) => {
        const { data, info } = await open()
          .resize({ width: size, withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        return { size, body: data, width: info.width, height: info.height } satisfies PhotoVariant;
      }),
    );
    const bw = width >= height ? 32 : Math.max(8, Math.round((32 * width) / height));
    const bh = width >= height ? Math.max(8, Math.round((32 * height) / width)) : 32;
    const small = await open().resize(bw, bh, { fit: 'fill' }).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const blurhash = encodeBlurhash(
      new Uint8ClampedArray(small.data.buffer, small.data.byteOffset, small.data.length),
      small.info.width,
      small.info.height,
      width >= height ? 4 : 3,
      width >= height ? 3 : 4,
    );
    const grey = await open().resize(N, N, { fit: 'fill' }).flatten({ background: '#ffffff' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    const samples = grey.info.channels === 1 ? grey.data : Uint8Array.from({ length: N * N }, (_, i) => grey.data[i * grey.info.channels]!);
    return { width, height, variants, blurhash, phash: perceptualHash(new Uint8Array(samples)) };
  } catch (error) {
    throw new UnreadableImageError('decode', error);
  }
}
