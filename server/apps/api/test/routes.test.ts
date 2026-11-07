import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiApp } from '../src/app.js';
import { testApp } from './support.js';

/**
 * The route registry of the whole API as it is built for production: every
 * route of the milestone is there exactly once (Fastify refuses a second
 * registration of a method and path, so building the app proves it), no
 * stand-in or forgotten route is left, every route declares its statement
 * budget, and every JSON answer declares its schema (which is what the "no
 * raw user id" check reads).
 */

type Operation = { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> };
type OpenApi = { paths: Record<string, Record<string, Operation>> };

/** Method, path (OpenAPI form) and the status of the success answer; `null`: no body. */
const ROUTES: [method: string, path: string, success: string, body: boolean][] = [
  ['GET', '/healthz', '200', true],
  ['GET', '/readyz', '200', true],
  // §3.2
  ['GET', '/v1/config', '200', true],
  // §3.3
  ['POST', '/v1/auth/otp/start', '200', true],
  ['POST', '/v1/auth/otp/verify', '200', true],
  ['POST', '/v1/auth/google/nonce', '200', true],
  ['POST', '/v1/auth/google', '200', true],
  ['POST', '/v1/auth/refresh', '200', true],
  ['POST', '/v1/auth/logout', '204', false],
  ['POST', '/v1/me/phone/start', '200', true],
  ['POST', '/v1/me/phone/verify', '204', false],
  // §3.4
  ['GET', '/v1/me', '200', true],
  ['PUT', '/v1/me/basics', '200', true],
  ['GET', '/v1/me/consents', '200', true],
  ['PUT', '/v1/me/consents/{kind}', '200', true],
  ['PATCH', '/v1/me/profile', '200', true],
  ['PATCH', '/v1/me/preferences', '200', true],
  ['PATCH', '/v1/me/settings', '200', true],
  ['PATCH', '/v1/me/notifications', '200', true],
  ['PUT', '/v1/me/location', '200', true],
  ['GET', '/v1/cities', '200', true],
  ['POST', '/v1/me/photos', '201', true],
  ['POST', '/v1/me/photos/{photoId}/complete', '202', true],
  ['PUT', '/v1/me/photos/order', '200', true],
  ['DELETE', '/v1/me/photos/{photoId}', '204', false],
  // §3.5
  ['PUT', '/v1/devices/current', '204', false],
  // §3.6
  ['GET', '/v1/deck', '200', true],
  ['POST', '/v1/swipes', '200', true],
  // §3.7 and §3.4 (a profile opened from a list)
  ['GET', '/v1/likes', '200', true],
  ['GET', '/v1/profiles/{publicUid}', '200', true],
  // §3.8 (the list and the unmatch; messages are W4)
  ['GET', '/v1/conversations', '200', true],
  ['DELETE', '/v1/conversations/{id}', '204', false],
  // §3.11 (reads and appeals; the API name of the actions is "moderation")
  ['GET', '/v1/me/moderation', '200', true],
  ['POST', '/v1/appeals', '201', true],
  // §3.13
  ['POST', '/v1/realtime/token', '200', true],
  // §3.14
  ['GET', '/v1/me/deletion/preflight', '200', true],
  ['POST', '/v1/me/deletion', '202', true],
  ['POST', '/v1/me/restore', '200', true],
  ['POST', '/v1/public/account-deletion/start', '202', true],
  ['POST', '/v1/public/account-deletion/confirm', '202', true],
  ['POST', '/v1/public/account-deletion/google', '202', true],
];

describe('the route registry', () => {
  let app: ApiApp;
  let doc: OpenApi;

  beforeAll(async () => {
    app = await testApp();
    await app.ready();
    doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
  });
  afterAll(async () => {
    await app?.close();
  });

  const registered = () =>
    Object.entries(doc.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();

  it('holds every route of the milestone, once, and nothing else', () => {
    const expected = ROUTES.map(([method, path]) => `${method} ${path}`).sort();
    expect(new Set(expected).size).toBe(expected.length);
    expect(registered()).toEqual(expected);
    for (const [method, path] of ROUTES) {
      const url = path.replace(/\{(\w+)\}/g, ':$1');
      expect(app.hasRoute({ method, url }), `${method} ${path}`).toBe(true);
    }
    // The document itself is served too, outside the published paths.
    expect(app.hasRoute({ method: 'GET', url: '/openapi.json' })).toBe(true);
  });

  it('gives every route a statement budget', () => {
    expect(app.routesWithoutBudget()).toEqual([]);
  });

  it('declares the schema of every JSON answer, and no body where there is none', () => {
    for (const [method, path, status, body] of ROUTES) {
      const responses = doc.paths[path]?.[method.toLowerCase()]?.responses ?? {};
      const schema = responses[status]?.content?.['application/json']?.schema;
      if (body) expect(schema, `${method} ${path} ${status}`).toBeDefined();
      else expect(schema, `${method} ${path} ${status}`).toBeUndefined();
    }
  });

  it('answers an unknown /v1 route with 404, not with a stand-in', async () => {
    for (const url of ['/v1/likes/nope', '/v1/matches', '/v1/test']) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-client': 'play/120' } });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
