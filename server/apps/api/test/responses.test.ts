import { PUBLIC_UID_PATTERN } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiApp } from '../src/app.js';
import { testApp } from './support.js';

/**
 * "No raw user id in a response", over what the API really registers: every
 * route's response schemas as the OpenAPI document publishes them. A member
 * that names a person must be a public id; no member may be called like a
 * raw user id; integer ids are catalogue entries only. And every account
 * route declares its success response, so the check covers it.
 */

type Json = Record<string, unknown>;

/** Walks a JSON schema and yields every object property with its schema and path. */
function* properties(schema: unknown, path: string, seen = new Set<unknown>()): Generator<{ path: string; name: string; schema: Json }> {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);
  const node = schema as Json;
  const props = node['properties'];
  if (props && typeof props === 'object') {
    for (const [name, child] of Object.entries(props as Json)) {
      yield { path: `${path}/${name}`, name, schema: child as Json };
      yield* properties(child, `${path}/${name}`, seen);
    }
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const child = node[key];
    if (Array.isArray(child)) for (const [i, c] of child.entries()) yield* properties(c, `${path}/${key}${i}`, seen);
    else if (child && typeof child === 'object') yield* properties(child, `${path}/${key}`, seen);
  }
}

function patternsOf(schema: Json): string[] {
  const own = typeof schema['pattern'] === 'string' ? [schema['pattern']] : [];
  return [...own, ...((schema['anyOf'] as Json[] | undefined) ?? []).flatMap(patternsOf)];
}

const PERSON = /^(userId|user_id|uid|senderId|by|caller|callee|target|peerId|ownerId|authorId|likerId|actorId|billingRef)$/;
const RAW = /^(userId|user_id|uid|userLo|userHi|user_lo|user_hi)$/;

/** The routes of this part of the API, with the status of their success answer. */
const ACCOUNT_ROUTES: [method: string, path: string, status: string][] = [
  ['get', '/v1/config', '200'],
  ['get', '/v1/me', '200'],
  ['put', '/v1/me/basics', '200'],
  ['patch', '/v1/me/profile', '200'],
  ['patch', '/v1/me/preferences', '200'],
  ['patch', '/v1/me/settings', '200'],
  ['patch', '/v1/me/notifications', '200'],
  ['get', '/v1/me/consents', '200'],
  ['put', '/v1/me/consents/{kind}', '200'],
  ['put', '/v1/me/location', '200'],
  ['get', '/v1/cities', '200'],
  ['post', '/v1/realtime/token', '200'],
  ['get', '/v1/me/moderation', '200'],
  ['post', '/v1/appeals', '201'],
];

type OpenApi = { paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>; components?: { schemas?: Json } };

/** Every member of every response schema that breaks the rule (refs into components followed). */
function check(doc: OpenApi): { violations: string[]; checked: number } {
  const violations: string[] = [];
  let checked = 0;
  const resolve = (schema: unknown): unknown => {
    const ref = (schema as Json | null)?.['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) return doc.components?.schemas?.[ref.slice(21)];
    return schema;
  };
  const walk = function* (schema: unknown, path: string, seen = new Set<unknown>()): Generator<{ path: string; name: string; schema: Json }> {
    for (const property of properties(resolve(schema), path, seen)) {
      const own = resolve(property.schema) as Json;
      yield { ...property, schema: own };
      if (own !== property.schema) yield* walk(own, property.path, seen);
    }
  };
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const [type, content] of Object.entries(response.content ?? {})) {
          const where = `${method.toUpperCase()} ${path} ${status} ${type}`;
          for (const property of walk(content.schema, '')) {
            checked += 1;
            if (RAW.test(property.name)) violations.push(`${where}${property.path} names a raw user id`);
            if (PERSON.test(property.name) && !patternsOf(property.schema).includes(PUBLIC_UID_PATTERN.source)) {
              violations.push(`${where}${property.path} must be a public id`);
            }
            if (/[iI]d$/.test(property.name) && property.schema['type'] === 'integer' && !/^(id|fieldId|promptId|cityId)$/.test(property.name)) {
              violations.push(`${where}${property.path} is an integer id`);
            }
          }
        }
      }
    }
  }
  return { violations, checked };
}

describe('no raw user id in a response (registered routes)', () => {
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

  it('declares the success response of every account route', () => {
    for (const [method, path, status] of ACCOUNT_ROUTES) {
      const schema = doc.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
      expect(schema, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
    }
  });

  it('names people only by public id in every response schema of every route', () => {
    const { violations, checked } = check(doc);
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it('would catch a response that carries a raw user id', async () => {
    const bad = await testApp();
    bad.get('/v1/test/raw', { config: { pgBudget: 0 }, schema: { response: { 200: z.object({ peer: z.object({ userId: z.string(), callee: z.string() }) }) } } }, async () => ({ peer: { userId: '1', callee: '2' } }));
    await bad.ready();
    try {
      const { violations } = check((await bad.inject({ method: 'GET', url: '/openapi.json' })).json());
      expect(violations.every((v) => v.startsWith('GET /v1/test/raw 200'))).toBe(true);
      expect(violations.some((v) => v.endsWith('/peer/userId names a raw user id'))).toBe(true);
      expect(violations.some((v) => v.endsWith('/peer/callee must be a public id'))).toBe(true);
    } finally {
      await bad.close();
    }
  });

  it('describes the account itself by its public id', () => {
    const me = doc.paths['/v1/me']?.['get']?.responses?.['200']?.content?.['application/json']?.schema as Json;
    const id = (me['properties'] as Json)['id'] as Json;
    expect(patternsOf(id)).toContain(PUBLIC_UID_PATTERN.source);
  });
});
