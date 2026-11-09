import { describe, expect, it } from 'vitest';
import { ConfigError, storageConfigOf } from '../src/index.js';

const base = { NODE_ENV: 'production' as const, S3_REGION: 'auto', S3_PATH_STYLE: true, S3_TIMEOUT_MS: 10_000, CDN_SIGNING_SCHEME: 'hmac' as const };
const s3 = {
  S3_ENDPOINT: 'https://storage.example.com',
  S3_BUCKET_PRIVATE: 'uploads',
  S3_BUCKET_MEDIA: 'media',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  CDN_BASE_URL: 'https://cdn.example.com',
  CDN_SIGNING_KEY: 'k'.repeat(32),
};

describe('the internal storage endpoint', () => {
  it('is the servers\' own route to the store; presigned URLs keep the public one', () => {
    expect(storageConfigOf({ ...base, ...s3, S3_INTERNAL_ENDPOINT: 'http://minio:9000' })).toMatchObject({
      endpoint: 'https://storage.example.com',
      internalEndpoint: 'http://minio:9000',
    });
    expect(storageConfigOf({ ...base, ...s3 })?.internalEndpoint).toBeUndefined();
  });

  it('needs the store it is a route to', () => {
    let error: unknown;
    try {
      storageConfigOf({ ...base, NODE_ENV: 'development', S3_INTERNAL_ENDPOINT: 'http://minio:9000' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((issue) => issue.variable)).toEqual(['S3_INTERNAL_ENDPOINT']);
  });
});
