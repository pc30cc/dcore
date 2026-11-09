import { describe, expect, it } from 'vitest';
import { S3Storage, createMediaStore } from '../../src/server/index.js';

/** The internal endpoint: the server's own requests stay on the internal network, presigned URLs name the public host. */

describe('S3 with an internal endpoint', () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3', 'content-type': 'image/webp' } });
  };
  const storage = new S3Storage({
    endpoint: 'https://storage.example.com',
    internalEndpoint: 'http://minio:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
    fetch: fetchFn,
    now: () => new Date('2026-11-09T10:00:00.000Z'),
  });

  it('presigns uploads and reads for the public host', async () => {
    const put = await storage.presignPut({ bucket: 'uploads', key: 'u/123', contentType: 'image/jpeg', contentLength: 10, expiresInSeconds: 600 });
    expect(put.url).toMatch(/^https:\/\/storage\.example\.com\/uploads\/u\/123\?X-Amz-Algorithm=AWS4-HMAC-SHA256/);
    const get = await storage.presignGet({ bucket: 'media', key: 'p/1/1/640.webp', expiresInSeconds: 600 });
    expect(get.url).toMatch(/^https:\/\/storage\.example\.com\/media\/p\/1\/1\/640\.webp\?/);
    expect(requests).toEqual([]);
  });

  it('sends its own reads, writes and deletes to the internal host, signed for that host', async () => {
    await storage.putObject('media', 'bootstrap/origins.json', new TextEncoder().encode('{}'), { contentType: 'application/json' });
    await storage.headObject('media', 'p/1/1/640.webp');
    await storage.getObject('media', 'p/1/1/640.webp');
    await storage.deleteObject('uploads', 'u/123');
    expect(requests.map((r) => r.url)).toEqual([
      'http://minio:9000/media/bootstrap/origins.json',
      'http://minio:9000/media/p/1/1/640.webp',
      'http://minio:9000/media/p/1/1/640.webp',
      'http://minio:9000/uploads/u/123',
    ]);
    // The signature names the host the request goes to (SigV4 signs the host header).
    for (const request of requests) expect(request.headers['authorization']).toMatch(/SignedHeaders=[a-z0-9;-]*host/);
    const publicOnly = new S3Storage({ endpoint: 'https://storage.example.com', region: 'us-east-1', credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' }, fetch: fetchFn });
    requests.length = 0;
    await publicOnly.deleteObject('uploads', 'u/123');
    expect(requests[0]?.url).toBe('https://storage.example.com/uploads/u/123');
  });

  it('is passed on by the media store settings', async () => {
    const media = createMediaStore({
      endpoint: 'https://storage.example.com',
      internalEndpoint: 'http://minio:9000',
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      pathStyle: true,
      privateBucket: 'uploads',
      mediaBucket: 'media',
    });
    expect((media.storage as S3Storage).objectUrl('media', 'x.json', true).toString()).toBe('http://minio:9000/media/x.json');
    expect((media.storage as S3Storage).objectUrl('media', 'x.json').toString()).toBe('https://storage.example.com/media/x.json');
  });
});
