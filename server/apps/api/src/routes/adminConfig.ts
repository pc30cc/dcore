import { configValueForUpdate, configValueSave, configValues, type ConfigValueRow } from '@app/db';
import {
  adminConfigItemSchema,
  adminConfigKeyList,
  adminConfigKeys,
  adminConfigListSchema,
  adminConfigNeedsMfa,
  adminConfigParamsSchema,
  adminConfigQuerySchema,
  adminConfigResultSchema,
  adminConfigUpdateSchema,
  adminConfigWritePermission,
  appConfigSchemas,
  isAdminConfigKey,
  wireTime,
  type AdminConfigItem,
  type AdminConfigKey,
  type AppConfig,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf, adminWrite } from '../admin/audit.js';
import { checkConfigRules, parseConfigValue, settingsVersion, stableJson } from '../admin/configRules.js';
import { adminConflict, adminForbidden } from '../admin/problems.js';
import { adminRefOf } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The admin panel's app settings (app_config values by key):
 *
 *   GET /v1/admin/config?keys=a,b   config.read; every key of `adminConfigKeys`, or the ones named
 *   PUT /v1/admin/config/{key}      the key's own permission (config.write, config.legal, config.providers)
 *
 * A write is one transaction: the row locked, its version compared with
 * `baseVersion` (409 `settings_changed` when it moved), the value checked
 * with its schema and the key's rules (422 at the field), written, and its
 * audit row (`config.update`, before and after) inserted; a write that
 * changes nothing writes nothing. After the commit `cfg:changed` makes every
 * API process load the configuration again: `/v1/config`, the client
 * policy (426, 503), the call switches, the waitlist and the limits follow
 * within about a second; the worker's jobs read retention at their next run.
 * Writes of the legal values and the SMS routing also need the second
 * factor while one is required. Logs name the key, never the value.
 */

const MAX_KEYS = 30;

function itemOf(key: AdminConfigKey, row: ConfigValueRow | undefined): AdminConfigItem {
  const value = row?.value ?? null;
  return adminConfigItemSchema.parse({
    key,
    value,
    version: settingsVersion(row ? value : undefined),
    write: adminConfigWritePermission(key),
    updatedAt: row?.updatedAtMs !== null && row?.updatedAtMs !== undefined ? wireTime(row.updatedAtMs) : null,
    updatedBy: adminRefOf(row?.updatedBy ?? null),
  });
}

function storedOrNull<K extends AdminConfigKey>(key: K, value: unknown): AppConfig[K] | null {
  const parsed = appConfigSchemas[key].safeParse(value);
  return parsed.success ? (parsed.data as AppConfig[K]) : null;
}

export const adminConfigRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];

  app.get(
    '/v1/admin/config',
    {
      preHandler: app.requirePermission('config.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The app settings the panel edits', querystring: adminConfigQuerySchema, response: { 200: adminConfigListSchema } },
    },
    async (request, reply) => {
      let keys: AdminConfigKey[] = adminConfigKeyList;
      if (request.query.keys !== undefined) {
        const named = [...new Set(request.query.keys.split(',').map((k) => k.trim()).filter((k) => k.length > 0))];
        if (named.length === 0 || named.length > MAX_KEYS || !named.every(isAdminConfigKey)) {
          throw new HttpProblem('validation_failed', {
            detail: 'keys must name settings of the panel.',
            errors: [{ in: 'query', pointer: '/keys', code: 'invalid', message: 'unknown or too many keys' }],
          });
        }
        keys = named;
      }
      const rows = new Map((await configValues(app.pg, keys)).map((row) => [row.key, row]));
      reply.header('cache-control', 'no-store');
      return { items: keys.map((key) => itemOf(key, rows.get(key))) };
    },
  );

  app.put(
    '/v1/admin/config/:key',
    {
      preHandler: app.requirePermission('config.read'),
      // The locked read, the value, the audit row.
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Change one app setting', params: adminConfigParamsSchema, body: adminConfigUpdateSchema, response: { 200: adminConfigResultSchema } },
    },
    async (request, reply) => {
      const raw = request.params.key;
      if (!isAdminConfigKey(raw)) throw new HttpProblem('not_found', { detail: 'No such setting.' });
      const key: AdminConfigKey = raw;
      const permission = adminConfigKeys[key].write;
      if (permission === null) throw adminForbidden('read_only', 'This setting is not changed from the panel.');
      const principal = request.principal;
      const roles = principal?.kind === 'admin' ? principal.roles : [];
      if (app.adminAuth.roles.allows(roles, permission) !== true) {
        throw adminForbidden('role', 'Your role does not allow this action.', { headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } });
      }
      if (adminConfigNeedsMfa(key)) await app.requireMfa(request, reply);
      const value = parseConfigValue(key, request.body.value);
      const production = app.config.env === 'production';
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const stored = await configValueForUpdate(tx, key);
        if (settingsVersion(stored.exists ? stored.value : undefined) !== request.body.baseVersion) {
          throw adminConflict('settings_changed', 'The setting was changed meanwhile; load it again and save from there.');
        }
        const before = storedOrNull(key, stored.value);
        checkConfigRules(key, before, value, { production });
        if (stored.exists && stableJson(stored.value) === stableJson(value)) {
          trail.unchanged();
          return { changed: false as const, value: stored.value };
        }
        const saved = await configValueSave(tx, key, value, actorOf(request).adminId, stored.exists);
        if (!saved) throw adminConflict('settings_changed', 'The setting was changed meanwhile; load it again and save from there.');
        trail.record({ action: 'config.update', target: 'config', detail: { key, before: stored.exists ? stored.value : null, after: value } });
        return { changed: true as const, row: saved };
      });
      if (outcome.changed) {
        if (!(await app.cfg.announce())) request.log.warn({ key }, 'config: saved; the announcement to the other processes is retried in the background');
        request.log.info({ key }, 'config: setting saved');
        return { item: itemOf(key, outcome.row) };
      }
      const rows = await configValues(app.pg, [key]);
      return { item: itemOf(key, rows[0]) };
    },
  );
};
