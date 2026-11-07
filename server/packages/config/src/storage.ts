import { z } from 'zod';
import { ConfigError, envBoolean, envUrl, type ConfigIssue } from './env.js';

/**
 * Object storage and the CDN in front of the media bucket (API and worker).
 * The S3 variables come together or not at all; without them the photo
 * routes answer 503 and the worker's photo jobs wait (development without
 * storage). In production they are required, and so is the CDN.
 */

const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name');

export const storageEnvShape = {
  /** `https://<account>.r2.cloudflarestorage.com`, `https://s3.<region>.amazonaws.com`, ... */
  S3_ENDPOINT: envUrl(['https', 'http']).optional(),
  S3_REGION: z.string().regex(/^[a-z0-9-]{2,40}$/, 'must be a region name such as auto or eu-central-1').default('auto'),
  /** Uploads (`u/<photoId>`): never public, never behind the CDN. */
  S3_BUCKET_PRIVATE: bucket.optional(),
  /** Stripped variants (`p/<photoId>/<blobVer>/<size>.webp`), served by the CDN with signed links. */
  S3_BUCKET_MEDIA: bucket.optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** `endpoint/bucket/key` (true) or `bucket.endpoint/key` (false). */
  S3_PATH_STYLE: envBoolean(true),
  S3_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(500).max(120_000))
    .prefault('10000'),
  /** The CDN origin of the media bucket, e.g. https://cdn.example.com. */
  CDN_BASE_URL: envUrl(['https', 'http']).optional(),
  /** The secret the CDN (or its edge function) checks link signatures with. */
  CDN_SIGNING_KEY: z.string().min(16).optional(),
  /** `hmac` (an edge function checks `exp` and `sig`) or `bunny` (the CDN's token authentication). */
  CDN_SIGNING_SCHEME: z.enum(['hmac', 'bunny']).default('hmac'),
};

type StorageEnv = {
  NODE_ENV: 'development' | 'test' | 'production';
  S3_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_BUCKET_PRIVATE?: string | undefined;
  S3_BUCKET_MEDIA?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_PATH_STYLE: boolean;
  S3_TIMEOUT_MS: number;
  CDN_BASE_URL?: string | undefined;
  CDN_SIGNING_KEY?: string | undefined;
  CDN_SIGNING_SCHEME: 'hmac' | 'bunny';
};

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  privateBucket: string;
  mediaBucket: string;
  timeoutMs: number;
  cdn: { baseUrl: string; signingKey: string; scheme: 'hmac' | 'bunny' } | undefined;
}

const S3_KEYS = ['S3_ENDPOINT', 'S3_BUCKET_PRIVATE', 'S3_BUCKET_MEDIA', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/** The storage settings, or undefined when none are set (outside production). Throws ConfigError naming the variables. */
export function storageConfigOf(env: StorageEnv): StorageConfig | undefined {
  const issues: ConfigIssue[] = [];
  const set = S3_KEYS.filter((key) => env[key] !== undefined);
  const cdnSet = [env.CDN_BASE_URL, env.CDN_SIGNING_KEY].filter((v) => v !== undefined).length;
  if (set.length > 0 && set.length < S3_KEYS.length) {
    for (const key of S3_KEYS) if (env[key] === undefined) issues.push({ variable: key, message: 'required with the other S3_* variables' });
  }
  if (cdnSet === 1) {
    issues.push({ variable: env.CDN_BASE_URL === undefined ? 'CDN_BASE_URL' : 'CDN_SIGNING_KEY', message: 'CDN_BASE_URL and CDN_SIGNING_KEY come together' });
  }
  if (env.NODE_ENV === 'production') {
    if (set.length === 0) for (const key of S3_KEYS) issues.push({ variable: key, message: 'required in production' });
    if (cdnSet === 0) issues.push({ variable: 'CDN_BASE_URL', message: 'required in production (with CDN_SIGNING_KEY)' });
  }
  if (set.length === S3_KEYS.length && env.S3_BUCKET_PRIVATE === env.S3_BUCKET_MEDIA) {
    issues.push({ variable: 'S3_BUCKET_MEDIA', message: 'must differ from S3_BUCKET_PRIVATE (uploads are never public)' });
  }
  if (issues.length > 0) throw new ConfigError(issues);
  if (set.length === 0) return undefined;
  return {
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    pathStyle: env.S3_PATH_STYLE,
    privateBucket: env.S3_BUCKET_PRIVATE!,
    mediaBucket: env.S3_BUCKET_MEDIA!,
    timeoutMs: env.S3_TIMEOUT_MS,
    cdn:
      env.CDN_BASE_URL && env.CDN_SIGNING_KEY
        ? { baseUrl: env.CDN_BASE_URL, signingKey: env.CDN_SIGNING_KEY, scheme: env.CDN_SIGNING_SCHEME }
        : undefined,
  };
}
