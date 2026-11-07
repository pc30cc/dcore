import { describe, expect, it } from 'vitest';
import { ConfigError, storageConfigOf } from '../src/index.js';

const base = { NODE_ENV: 'development' as const, S3_REGION: 'auto', S3_PATH_STYLE: true, S3_TIMEOUT_MS: 10_000, CDN_SIGNING_SCHEME: 'hmac' as const };
const s3 = {
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET_PRIVATE: 'uploads',
  S3_BUCKET_MEDIA: 'media',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};
const cdn = { CDN_BASE_URL: 'https://cdn.example.com', CDN_SIGNING_KEY: 'k'.repeat(32) };

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues.map((i) => i.variable);
    throw error;
  }
  return [];
}

describe('storage settings', () => {
  it('are optional outside production and come together', () => {
    expect(storageConfigOf(base)).toBeUndefined();
    expect(storageConfigOf({ ...base, ...s3, ...cdn })).toMatchObject({ privateBucket: 'uploads', mediaBucket: 'media', cdn: { scheme: 'hmac' } });
    expect(storageConfigOf({ ...base, ...s3 })?.cdn).toBeUndefined();
    expect(issues(() => storageConfigOf({ ...base, S3_ENDPOINT: s3.S3_ENDPOINT }))).toEqual(['S3_BUCKET_PRIVATE', 'S3_BUCKET_MEDIA', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
    expect(issues(() => storageConfigOf({ ...base, ...s3, CDN_BASE_URL: cdn.CDN_BASE_URL }))).toEqual(['CDN_SIGNING_KEY']);
    expect(issues(() => storageConfigOf({ ...base, ...s3, S3_BUCKET_MEDIA: 'uploads' }))).toEqual(['S3_BUCKET_MEDIA']);
  });

  it('are required in production, the CDN too', () => {
    expect(issues(() => storageConfigOf({ ...base, NODE_ENV: 'production' }))).toContain('S3_ENDPOINT');
    expect(issues(() => storageConfigOf({ ...base, NODE_ENV: 'production', ...s3 }))).toEqual(['CDN_BASE_URL']);
    expect(storageConfigOf({ ...base, NODE_ENV: 'production', ...s3, ...cdn })).toBeDefined();
  });

  it('never put a value in a message', () => {
    try {
      storageConfigOf({ ...base, S3_SECRET_ACCESS_KEY: 'very-secret-value' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('very-secret-value');
    }
  });
});
