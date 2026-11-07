import { S3Storage, type ObjectStorage } from '../clients/s3.js';
import { CdnUrlSigner, type CdnSigningScheme } from './cdn.js';
import { photoVariantKey, type PhotoVariantSize } from './layout.js';

/**
 * Object storage as the photo routes and the worker use it: the private
 * bucket (uploads, never public), the media bucket (stripped variants,
 * behind the CDN) and the signed links of the variants. Links are absent
 * while no CDN is configured.
 */
export interface MediaStore {
  storage: ObjectStorage;
  privateBucket: string;
  mediaBucket: string;
  urls: CdnUrlSigner | null;
}

/** The settings a media store is made from (the apps' S3_* and CDN_* variables). */
export interface MediaStoreSettings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  privateBucket: string;
  mediaBucket: string;
  cdn?: { baseUrl: string; signingKey: string; scheme: CdnSigningScheme } | undefined;
}

export function createMediaStore(settings: MediaStoreSettings, options: { timeoutMs?: number | undefined } = {}): MediaStore {
  return {
    storage: new S3Storage({
      endpoint: settings.endpoint,
      region: settings.region,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      pathStyle: settings.pathStyle,
      timeoutMs: options.timeoutMs,
    }),
    privateBucket: settings.privateBucket,
    mediaBucket: settings.mediaBucket,
    urls: settings.cdn ? new CdnUrlSigner(settings.cdn) : null,
  };
}

/** The signed link of one variant, or undefined without a CDN. */
export function photoVariantUrl(media: Pick<MediaStore, 'urls'>, photoId: string, blobVer: number, size: PhotoVariantSize): string | undefined {
  return media.urls ? media.urls.url(photoVariantKey(photoId, blobVer, size)) : undefined;
}
