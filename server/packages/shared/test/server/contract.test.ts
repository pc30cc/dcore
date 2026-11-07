import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PUBLIC_UID_PATTERN,
  errorCodes,
  isErrorCode,
  problemSchemaFor,
  pushDataSchema,
  pushTypeNames,
  pushTypes,
  realtimeEnvelopeSchema,
  realtimeEventTypes,
  realtimePayloads,
  responseSchemas,
  type ErrorCode,
  type RealtimeEventType,
} from '../../src/index.js';

/**
 * The shared fixtures are the contract between the server and the app: every
 * file is valid for its schema, strictly (a key the schema does not know is
 * an error, not something to strip), and every schema has an example.
 */

const FIXTURES = new URL('../../fixtures/', import.meta.url);

function names(dir: string): string[] {
  return readdirSync(new URL(`${dir}/`, FIXTURES))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

function read(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${dir}/${name}.json`, FIXTURES), 'utf8'));
}

/** Parses strictly: the output (unknown keys stripped) must equal the input. */
function strict(schema: z.ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${z.prettifyError(result.error)}`);
  expect(result.data, `${label} has keys its schema does not know`).toEqual(value);
}

const PROBLEM_FIXTURES: Record<string, ErrorCode> = {
  'problem-otp-invalid': 'otp_invalid',
  'problem-suspended': 'account_suspended',
  'problem-deleted': 'account_deleted',
  'problem-consent-required': 'consent_required',
  'problem-upgrade-required': 'upgrade_required',
  'problem-maintenance': 'maintenance',
  'problem-quota': 'quota_exceeded',
  'problem-validation': 'validation_failed',
  'problem-rate-limited': 'rate_limited',
};

describe('response fixtures', () => {
  const files = names('v1');

  it('has a schema for every file and a file for every schema', () => {
    const responses = files.filter((name) => !name.startsWith('problem-'));
    expect(responses).toEqual(Object.keys(responseSchemas).sort());
    expect(files.filter((name) => name.startsWith('problem-'))).toEqual(Object.keys(PROBLEM_FIXTURES).sort());
  });

  for (const [name, schema] of Object.entries(responseSchemas as Record<string, z.ZodType>)) {
    it(`${name} matches its schema`, () => strict(schema, read('v1', name), name));
  }

  for (const [name, code] of Object.entries(PROBLEM_FIXTURES)) {
    it(`${name} is a ${code} problem with exactly its extension members`, () => {
      const body = read('v1', name) as { code: string };
      expect(isErrorCode(body.code)).toBe(true);
      strict(problemSchemaFor(code), body, name);
    });
  }
});

describe('realtime fixtures', () => {
  it('has one example per event type', () => {
    expect(names('realtime')).toEqual([...realtimeEventTypes].sort());
  });

  for (const t of realtimeEventTypes) {
    it(`${t} is a valid envelope`, () => {
      const envelope = read('realtime', t) as { t: RealtimeEventType; d: unknown };
      expect(envelope.t).toBe(t);
      strict(realtimeEnvelopeSchema, envelope, t);
      strict(realtimePayloads[t], envelope.d, `${t}.d`);
    });
  }
});

describe('push fixtures', () => {
  it('has one example per push type', () => {
    expect(names('push')).toEqual([...pushTypeNames].sort());
  });

  for (const type of pushTypeNames) {
    it(`${type} carries only its own keys, all strings`, () => {
      const data = read('push', type) as Record<string, unknown>;
      expect(data['type']).toBe(type);
      for (const value of Object.values(data)) expect(typeof value).toBe('string');
      strict(pushDataSchema, data, type);
      const { type: _type, ...rest } = data;
      strict(pushTypes[type].data, rest, `${type} data`);
    });
  }
});

/** Walks a JSON schema and yields every object property with its schema and path. */
function* properties(schema: unknown, path: string): Generator<{ path: string; name: string; schema: Record<string, unknown> }> {
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  const props = node['properties'];
  if (props && typeof props === 'object') {
    for (const [name, child] of Object.entries(props as Record<string, unknown>)) {
      yield { path: `${path}/${name}`, name, schema: child as Record<string, unknown> };
      yield* properties(child, `${path}/${name}`);
    }
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const child = node[key];
    if (Array.isArray(child)) for (const [i, c] of child.entries()) yield* properties(c, `${path}/${key}${i}`);
    else if (child && typeof child === 'object') yield* properties(child, `${path}/${key}`);
  }
}

function patternsOf(schema: Record<string, unknown>): string[] {
  const own = typeof schema['pattern'] === 'string' ? [schema['pattern']] : [];
  const alternatives = [...((schema['anyOf'] as Record<string, unknown>[] | undefined) ?? [])].flatMap(patternsOf);
  return [...own, ...alternatives];
}

describe('no raw user id in a response', () => {
  /** Members that name a person. Each must be a public id; a raw user id never leaves the server. */
  const PERSON = /^(userId|user_id|uid|senderId|by|caller|callee|target|peerId|ownerId|authorId|likerId|actorId|billingRef)$/;
  const RAW = /^(userId|user_id|uid|userLo|userHi|user_lo|user_hi)$/;
  const schemas: [string, z.ZodType][] = [
    ...Object.entries(responseSchemas as Record<string, z.ZodType>),
    ...realtimeEventTypes.map((t) => [`realtime:${t}`, realtimePayloads[t]] as [string, z.ZodType]),
    ...pushTypeNames.map((t) => [`push:${t}`, pushTypes[t].data] as [string, z.ZodType]),
  ];

  for (const [name, schema] of schemas) {
    it(`${name}`, () => {
      const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
      for (const property of properties(json, '')) {
        expect(RAW.test(property.name), `${name}${property.path} names a raw user id`).toBe(false);
        if (PERSON.test(property.name)) {
          expect(patternsOf(property.schema), `${name}${property.path} must be a public id`).toContain(PUBLIC_UID_PATTERN.source);
        }
        if (/[iI]d$/.test(property.name) && property.schema['type'] === 'integer') {
          // Integer ids are catalogue entries (fields, prompts, cities), never people or rows.
          expect(property.name, `${name}${property.path}`).toMatch(/^(id|fieldId|promptId|cityId)$/);
        }
      }
    });
  }

  it('names people by public id in the objects that are people', () => {
    const people: z.ZodType[] = [responseSchemas.me, responseSchemas['profile-card'], responseSchemas['own-profile']];
    for (const schema of people) {
      const json = z.toJSONSchema(schema, { io: 'output' }) as unknown as { properties: { id: Record<string, unknown> } };
      expect(patternsOf(json.properties.id)).toContain(PUBLIC_UID_PATTERN.source);
    }
  });
});

describe('problem catalogue', () => {
  it('lists every code the contract names', () => {
    // §2.4 of the contract, plus the generic codes.
    const contract = [
      'phone_invalid', 'otp_invalid', 'google_token_invalid', 'refresh_invalid', 'refresh_reused', 'account_banned',
      'account_suspended', 'account_deleted', 'phone_banned', 'phone_not_allowed', 'device_banned', 'onboarding_incomplete',
      'consent_required', 'snoozed', 'location_required', 'entitlement_required', 'calls_not_allowed', 'store_not_supported',
      'not_found', 'already_set', 'position_taken', 'already_requested', 'already_matched', 'confirm_required', 'caller_busy',
      'not_ringing', 'answered_elsewhere', 'call_not_live', 'appeal_open', 'purchase_other_account', 'otp_expired',
      'conversation_ended', 'under_age', 'field_invalid', 'text_refused', 'message_refused', 'photo_limit', 'photo_min',
      'upload_missing', 'purchase_invalid', 'limit_reached', 'not_appealable', 'upgrade_required', 'rate_limited',
      'quota_exceeded', 'otp_locked', 'maintenance', 'sms_unavailable', 'store_unavailable',
    ];
    for (const code of contract) expect(errorCodes, code).toContain(code);
    // A busy callee is never revealed: there is no such code.
    expect(errorCodes).not.toContain('callee_busy');
  });
});
