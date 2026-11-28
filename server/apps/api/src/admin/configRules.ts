import { createHash } from 'node:crypto';
import { ADMIN_CONFIG_BOUNDS, appConfigSchemas, type AdminConfigKey, type AdminFieldCode, type AppConfig } from '@app/shared';
import type { z } from 'zod';
import { fieldInvalid } from './problems.js';

/**
 * The admin panel's rules for the app_config keys it writes, beyond the
 * stored schemas (which stay as they are, so values already stored keep
 * loading): bounds, legal versions that only go up, no test SMS provider in
 * production. Each refusal is a 422 `field_invalid` naming the field
 * (`/value/...`) and the admin field code. The bounds are checked on the
 * value as sent, before its schema: where a stored schema has a range of its
 * own (the same or wider), a number outside the bounds still answers
 * `out_of_range` at its field, never the schema's `invalid`.
 */

/** JSON with object keys sorted at every level: one text per value, whatever order it was written in. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The version of a stored value (a missing row has one too). */
export function settingsVersion(value: unknown, salt = 'v'): string {
  return createHash('sha256').update(salt).update('\u0000').update(stableJson(value)).digest('base64url').slice(0, 22);
}

const pointerOf = (path: readonly PropertyKey[]) => `/value${path.map((p) => `/${String(p)}`).join('')}`;

interface Range {
  readonly min: number;
  readonly max: number;
}

/** The numbers each key's bounds hold: their paths into the value and their ranges. */
function boundedNumbers(key: AdminConfigKey): readonly (readonly [path: readonly string[], range: Range])[] {
  const name: AdminConfigKey = key;
  switch (name) {
    case 'app.min_version':
      return (['cafe_bazaar', 'google_play'] as const).flatMap((store) =>
        (['required', 'recommended'] as const).map((field) => [[store, field], { min: 0, max: ADMIN_CONFIG_BOUNDS.versionCodeMax }] as const),
      );
    case 'retention.message_requests_days':
    case 'retention.unsent_body_hours':
    case 'retention.report_evidence_days':
    case 'retention.unmatched_messages_days':
    case 'retention.deleted_account_days':
      return [[[], ADMIN_CONFIG_BOUNDS.retention[name]]];
    case 'legal.versions':
      return (['terms', 'privacy', 'guidelines'] as const).map((field) => [[field], { min: 1, max: ADMIN_CONFIG_BOUNDS.legalVersionMax }] as const);
    case 'limits.rates':
      return (Object.keys(ADMIN_CONFIG_BOUNDS.limits) as (keyof typeof ADMIN_CONFIG_BOUNDS.limits)[]).map((field) => [[field], ADMIN_CONFIG_BOUNDS.limits[field]] as const);
    default:
      return [];
  }
}

function at(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** The key's bounds on the value as sent: a number outside them answers `out_of_range` at its field; anything else is left to the schema. */
function checkBounds(key: AdminConfigKey, value: unknown): void {
  for (const [path, range] of boundedNumbers(key)) {
    const found = at(value, path);
    if (typeof found === 'number') bound(pointerOf(path), found, range);
  }
}

/** Checks the key's bounds, then parses the value with its schema; the first issue answers 422 at its field. */
export function parseConfigValue<K extends AdminConfigKey>(key: K, value: unknown): AppConfig[K] {
  checkBounds(key, value);
  const schema = appConfigSchemas[key] as z.ZodType;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as AppConfig[K];
  const issue = parsed.error.issues[0]!;
  if (key === 'app.min_version' && issue.code === 'custom' && issue.path.length === 1) {
    throw fieldInvalid(`${pointerOf(issue.path)}/recommended`, 'below_required', 'The suggested version cannot be below the required one.');
  }
  throw fieldInvalid(pointerOf(issue.path), 'invalid', 'This value is not valid.');
}

function bound(pointer: string, value: number, range: Range): void {
  if (value < range.min || value > range.max) throw fieldInvalid(pointer, 'out_of_range', `Use a number from ${range.min} to ${range.max}.`);
}

function refuse(pointer: string, code: AdminFieldCode, message: string): never {
  throw fieldInvalid(pointer, code, message);
}

/** The key's own rules beyond its bounds (which {@link parseConfigValue} checked); `before` is the stored value (null when none parses). */
export function checkConfigRules<K extends AdminConfigKey>(key: K, before: AppConfig[K] | null, after: AppConfig[K], options: { production: boolean }): void {
  const name: AdminConfigKey = key;
  switch (name) {
    case 'legal.versions': {
      const value = after as AppConfig['legal.versions'];
      const was = before as AppConfig['legal.versions'] | null;
      for (const name of ['terms', 'privacy', 'guidelines'] as const) {
        if (was && value[name] < was[name]) refuse(`/value/${name}`, 'version_lowered', 'A version can only go up.');
      }
      return;
    }
    case 'safety.child_safety_contact': {
      const value = after as AppConfig['safety.child_safety_contact'];
      if (value.name !== null && (value.name.trim().length === 0 || [...value.name].length > ADMIN_CONFIG_BOUNDS.contactNameMax)) {
        refuse('/value/name', 'out_of_range', `Use 1 to ${ADMIN_CONFIG_BOUNDS.contactNameMax} characters.`);
      }
      return;
    }
    case 'auth.sms_routing': {
      if (!options.production) return;
      const value = after as AppConfig['auth.sms_routing'];
      value.routes.forEach((route, i) =>
        route.providers.forEach((name, j) => {
          if (name === 'fake') refuse(`/value/routes/${i}/providers/${j}`, 'fake_provider', 'The test provider is never used in production.');
        }),
      );
      value.default.forEach((name, j) => {
        if (name === 'fake') refuse(`/value/default/${j}`, 'fake_provider', 'The test provider is never used in production.');
      });
      return;
    }
    default:
      return;
  }
}
