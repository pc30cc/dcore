import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { problemSchema } from '@app/shared';
import type { ApiApp } from '../src/app.js';
import { ADMIN_ORIGIN, testApp } from './support.js';

let app: ApiApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function started(setup?: (instance: ApiApp) => void): Promise<ApiApp> {
  app = await testApp();
  setup?.(app);
  await app.ready();
  return app;
}

function parseProblem(body: string) {
  return problemSchema.parse(JSON.parse(body));
}

describe('probes', () => {
  it('answers /healthz from memory with security headers and a request id', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('reports dependencies that are down on /readyz without leaking addresses', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; checks: Record<string, { status: string; reason?: string }> }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks['postgres']?.status).toBe('down');
    expect(body.checks['redis']?.status).toBe('down');
    expect(res.body).not.toContain('127.0.0.1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports shutting_down once shutdown has begun', async () => {
    const instance = await started();
    instance.readiness.beginShutdown();
    const res = await instance.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'shutting_down', checks: {} });
  });
});

describe('request ids', () => {
  it('keeps a well-formed inbound id and replaces a malformed one', async () => {
    const instance = await started();
    const kept = await instance.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'edge-1234abcd' } });
    expect(kept.headers['x-request-id']).toBe('edge-1234abcd');
    const replaced = await instance.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id\n' } });
    expect(replaced.headers['x-request-id']).not.toBe('bad id\n');
  });
});

describe('problem+json errors', () => {
  const setup = (instance: ApiApp) => {
    instance.post(
      '/test/items',
      { schema: { body: z.object({ name: z.string().min(2), tags: z.array(z.string()).max(2) }) } },
      async (request) => ({ name: request.body.name }),
    );
    instance.get('/test/crash', async () => {
      throw new Error('secret database detail');
    });
  };

  it('answers an unknown route with 404', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/nope?token=abc' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    const body = parseProblem(res.body);
    expect(body).toMatchObject({ code: 'not_found', status: 404, instance: '/nope', type: 'urn:problem-type:not-found' });
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('lists validation issues with JSON Pointers', async () => {
    const res = await (await started(setup)).inject({
      method: 'POST',
      url: '/test/items',
      payload: { name: 'x', tags: ['a', 'b', 'c'] },
    });
    expect(res.statusCode).toBe(400);
    const body = parseProblem(res.body);
    expect(body.code).toBe('validation_failed');
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'body', pointer: '/name', code: 'too_small' }),
        expect.objectContaining({ in: 'body', pointer: '/tags', code: 'too_big' }),
      ]),
    );
  });

  it('maps malformed JSON and wrong media types', async () => {
    const instance = await started(setup);
    const badJson = await instance.inject({
      method: 'POST',
      url: '/test/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(parseProblem(badJson.body).code).toBe('bad_request');

    const media = await instance.inject({
      method: 'POST',
      url: '/test/items',
      headers: { 'content-type': 'text/csv' },
      payload: 'a,b',
    });
    expect(media.statusCode).toBe(415);
    expect(parseProblem(media.body).code).toBe('unsupported_media_type');
  });

  it('hides the details of server errors', async () => {
    const res = await (await started(setup)).inject({ method: 'GET', url: '/test/crash' });
    expect(res.statusCode).toBe(500);
    const body = parseProblem(res.body);
    expect(body.code).toBe('internal');
    expect(res.body).not.toContain('secret database detail');
    expect(body.requestId).toBeTruthy();
  });
});

describe('CORS', () => {
  it('allows the admin origin only', async () => {
    const instance = await started();
    const preflight = (origin: string) =>
      instance.inject({
        method: 'OPTIONS',
        url: '/healthz',
        headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
      });
    const allowed = await preflight(ADMIN_ORIGIN);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const other = await preflight('https://elsewhere.test.invalid');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('serves an OpenAPI 3.1 document with the shared Problem schema', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/healthz', '/readyz', '/v1/config', '/v1/me']));
    expect(doc.components.schemas).toHaveProperty('Problem');
  });
});
