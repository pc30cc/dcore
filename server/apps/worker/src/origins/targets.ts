import { S3Storage, bodySnippet, defaultFetch, fetchWithTimeout, type Fetch, type MediaStore } from '@app/shared/server';
import { z } from 'zod';

/**
 * Where the signed origins document is published, besides `GET /v1/origins`:
 * places on other hosts and providers that apps try when the API cannot be
 * reached (their public URLs are the document's `bootstrap` list and
 * brand.json's `origins.bootstrap`). The document is public and signed, so
 * a copy only has to be readable; what a target needs to accept the upload
 * (keys, tokens) is a secret of the worker's environment and is never logged.
 */

/** The object key of the copy in the media bucket, served by the CDN at `<cdn>/bootstrap/origins.json`. */
export const ORIGINS_OBJECT_KEY = 'bootstrap/origins.json';
export const ORIGINS_CACHE_CONTROL = 'public, max-age=300';
const TIMEOUT_MS = 10_000;

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'id must be 1-32 lowercase letters, digits, "_" or "-"');
const objectKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/, 'key must be an object key').refine((key) => !key.split('/').some((part) => part === '' || part === '.' || part === '..'), 'key must be an object key');

const s3Target = z.strictObject({
  kind: z.literal('s3'),
  id,
  endpoint: z.url({ protocol: /^https?$/ }),
  region: z.string().regex(/^[a-z0-9-]{2,40}$/).default('auto'),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'bucket must be an S3 bucket name'),
  key: objectKey.default(ORIGINS_OBJECT_KEY),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  pathStyle: z.boolean().default(true),
});

const putTarget = z.strictObject({
  kind: z.literal('put'),
  id,
  url: z.url({ protocol: /^https$/ }),
  /** Sent with the upload (an access key header, say). */
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(2_000)).default({}),
});

const targetsSchema = z
  .array(z.discriminatedUnion('kind', [s3Target, putTarget]))
  .max(8)
  .refine((targets) => new Set(targets.map((t) => t.id)).size === targets.length, 'two targets have the same id')
  .refine((targets) => !targets.some((t) => t.id === 'media'), 'the id "media" is the media bucket\'s');

export type PublishTargetConfig = z.infer<typeof targetsSchema>[number];

/** Reads ORIGINS_PUBLISH_TARGETS; the error names the entry and the field, never a value. */
export function parsePublishTargets(text: string): PublishTargetConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('must be a JSON array of targets');
  }
  const parsed = targetsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`target ${issue?.path.join('.') || '(list)'}: ${issue?.message ?? 'not valid'}`);
  }
  return parsed.data;
}

/** One place the document is written to. */
export interface PublishTarget {
  /** Names the target in Valkey (`origins:pub:<id>`) and in logs. */
  readonly id: string;
  put(body: Uint8Array): Promise<void>;
}

export class PublishError extends Error {
  constructor(target: string, message: string, options?: ErrorOptions) {
    super(`${target}: ${message}`, options);
    this.name = 'PublishError';
  }
}

/** The media bucket, which the CDN serves. */
export function mediaTarget(media: MediaStore): PublishTarget {
  return {
    id: 'media',
    async put(body) {
      await media.storage.putObject(media.mediaBucket, ORIGINS_OBJECT_KEY, body, { contentType: 'application/json', cacheControl: ORIGINS_CACHE_CONTROL });
    },
  };
}

export function targetOf(config: PublishTargetConfig, fetchFn: Fetch = defaultFetch): PublishTarget {
  if (config.kind === 's3') {
    const storage = new S3Storage({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      pathStyle: config.pathStyle,
      fetch: fetchFn,
      timeoutMs: TIMEOUT_MS,
    });
    return {
      id: config.id,
      async put(body) {
        await storage.putObject(config.bucket, config.key, body, { contentType: 'application/json', cacheControl: ORIGINS_CACHE_CONTROL });
      },
    };
  }
  return {
    id: config.id,
    async put(body) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          fetchFn,
          config.url,
          { method: 'PUT', headers: { ...config.headers, 'content-type': 'application/json', 'cache-control': ORIGINS_CACHE_CONTROL }, body },
          TIMEOUT_MS,
        );
      } catch (error) {
        throw new PublishError(config.id, 'unreachable', { cause: error });
      }
      if (!response.ok) throw new PublishError(config.id, `answered ${response.status}: ${await bodySnippet(response)}`);
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
