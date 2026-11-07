/**
 * Where photo blobs live. The phone's upload goes to the private bucket as
 * `u/<photoId>`; the worker writes the stripped variants to the media bucket
 * as `p/<photoId>/<blobVer>/<size>.webp` and deletes the upload. A path names
 * the photo id, never a user id, and `blobVer` (photos.blob_ver) changes
 * whenever the pixels do, so a CDN never serves an old picture under a new
 * name.
 */

/** Widths of the variants, in pixels (an image narrower than a size is not enlarged). */
export const PHOTO_VARIANT_SIZES = [320, 640, 1080] as const;
export type PhotoVariantSize = (typeof PHOTO_VARIANT_SIZES)[number];

export const PHOTO_VARIANT_MIME = 'image/webp';
/** Variants never change under their name (a new blobVer is a new name). */
export const PHOTO_VARIANT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const ID = /^[1-9][0-9]{0,18}$/;

function checkId(photoId: string): string {
  if (!ID.test(photoId)) throw new TypeError('not a photo id');
  return photoId;
}

function checkVersion(blobVer: number): number {
  if (!Number.isInteger(blobVer) || blobVer < 1 || blobVer > 32_767) throw new RangeError('not a blob version');
  return blobVer;
}

/** The upload in the private bucket. */
export function photoUploadKey(photoId: string): string {
  return `u/${checkId(photoId)}`;
}

/** One variant in the media bucket. */
export function photoVariantKey(photoId: string, blobVer: number, size: PhotoVariantSize): string {
  if (!PHOTO_VARIANT_SIZES.includes(size)) throw new RangeError('not a variant size');
  return `p/${checkId(photoId)}/${checkVersion(blobVer)}/${size}.webp`;
}

/** Every variant of every version up to `blobVer` (what deleting a photo removes). */
export function photoVariantKeys(photoId: string, blobVer: number): string[] {
  const keys: string[] = [];
  for (let version = 1; version <= checkVersion(blobVer); version += 1) {
    for (const size of PHOTO_VARIANT_SIZES) keys.push(photoVariantKey(photoId, version, size));
  }
  return keys;
}
