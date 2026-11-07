import { describe, expect, it } from 'vitest';
import { FakeObjectStorage, S3Storage, authorizationHeader, presignUrl } from '../../src/server/index.js';

// The worked examples of AWS's Signature Version 4 documentation for S3
// (examplebucket, us-east-1, 2013-05-24T00:00:00Z, the documentation's keys).
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const date = new Date('2013-05-24T00:00:00Z');
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('AWS Signature Version 4', () => {
  it('signs the documented GET object request', () => {
    const header = authorizationHeader({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY,
      date,
      region: 'us-east-1',
      service: 's3',
      credentials,
    });
    expect(header).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('presigns the documented GET object URL', () => {
    const url = presignUrl(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: {},
        payloadHash: 'UNSIGNED-PAYLOAD',
        date,
        region: 'us-east-1',
        service: 's3',
        credentials,
      },
      86_400,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  });
});

describe('S3 storage', () => {
  const storage = new S3Storage({ endpoint: 'https://s3.example.test', region: 'auto', credentials, now: () => date });

  it('presigns an upload whose type and length are signed', async () => {
    const put = await storage.presignPut({ bucket: 'private-bucket', key: 'u/1287390234923410099', contentType: 'image/jpeg', contentLength: 2481337, expiresInSeconds: 3_600 });
    const url = new URL(put.url);
    expect(url.pathname).toBe('/private-bucket/u/1287390234923410099');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(put.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': '2481337' });
    expect(put.expiresAt.toISOString()).toBe('2013-05-24T01:00:00.000Z');
    expect(() => storage.objectUrl('private-bucket', '../x')).toThrow(TypeError);
    expect(() => storage.objectUrl('private-bucket', 'u/./1')).toThrow(TypeError);
    expect(() => storage.objectUrl('Bad_Bucket', 'u/1')).toThrow(TypeError);
    expect(() => storage.objectUrl('private-bucket', 'u//1')).toThrow(TypeError);
    await expect(storage.presignPut({ bucket: 'private-bucket', key: 'u/1', contentType: 'image/jpeg', contentLength: 1, expiresInSeconds: 8 * 86_400 })).rejects.toThrow(RangeError);
  });

  it('signs its own requests and maps 404 to null', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const s3 = new S3Storage({
      endpoint: 'https://s3.example.test',
      region: 'auto',
      credentials,
      now: () => date,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(init?.method === 'GET' ? null : 'x', { status: init?.method === 'GET' ? 404 : 200 });
      },
    });
    expect(await s3.getObject('media-bucket', 'p/1/1/320.webp')).toBeNull();
    await s3.putObject('media-bucket', 'p/1/1/320.webp', new Uint8Array([1, 2, 3]), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
    await s3.deleteObject('media-bucket', 'p/1/1/320.webp');
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PUT', 'DELETE']);
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(headers['x-amz-content-sha256']).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  });
});

describe('fake object storage', () => {
  it('checks an upload as S3 would', async () => {
    const fake = new FakeObjectStorage();
    const put = await fake.presignPut({ bucket: 'private-bucket', key: 'u/9', contentType: 'image/jpeg', contentLength: 3, expiresInSeconds: 60 });
    expect(() => fake.upload(put.url, new Uint8Array(4), 'image/jpeg')).toThrow(/content length/);
    expect(() => fake.upload(put.url, new Uint8Array(3), 'image/png')).toThrow(/content type/);
    fake.upload(put.url, new Uint8Array(3), 'image/jpeg');
    expect(await fake.headObject('private-bucket', 'u/9')).toEqual({ size: 3, contentType: 'image/jpeg' });
    fake.now = () => new Date(Date.now() + 120_000);
    expect(() => fake.upload(put.url, new Uint8Array(3), 'image/jpeg')).toThrow(/expired/);
    await fake.deleteObject('private-bucket', 'u/9');
    expect(fake.keys('private-bucket')).toEqual([]);
  });
});
