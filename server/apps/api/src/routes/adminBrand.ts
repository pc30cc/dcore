import { brandSettingsForUpdate, brandSettingsSave, brandSettingsValue, type BrandSettingsRow } from '@app/db';
import {
  adminBrandSchema,
  adminBrandUpdateSchema,
  brandAppNameValid,
  brandLegalKeys,
  brandUrlFromOrigin,
  brandUrlOnHosts,
  brandValueKeys,
  wireTime,
  type AdminBrand,
  type AdminBrandValues,
} from '@app/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf, adminWrite } from '../admin/audit.js';
import { settingsVersion, stableJson } from '../admin/configRules.js';
import { adminConflict, adminForbidden, fieldInvalid } from '../admin/problems.js';
import { adminRefOf } from '../admin/refs.js';

/**
 * The run-time brand (what the app and the API read from the active `brands`
 * row and app_config `brand.welcome`):
 *
 *   GET /v1/admin/brand   config.read: brand.json's values, the panel's, the welcome pictures, and the
 *                         colours and fonts built into the app (read-only)
 *   PUT /v1/admin/brand   config.write: the app name and the pictures; a change of the support e-mail or of a
 *                         legal link (the values the privacy policy and the stores name) also needs
 *                         config.legal and the second factor
 *
 * Legal links must be on brand.json's own domains (or the hosts of its own
 * links), and welcome pictures on the deployment's media origin: the app
 * opens the links and loads the pictures before sign-in. The save writes
 * the active row (made when there is none: the row with brand.json's id,
 * which keeps its other keys, or a new one), keeps every other key of its
 * `config` (colours, plan names) and of the welcome (texts, gradient), and
 * refuses (409 `brand_mismatch`) when the active row is another brand's or
 * brand.json's id cannot name a row. One transaction with its audit row
 * (`config.update`, key `brand`), then `cfg:changed`: `/v1/config` serves
 * the new name, links and pictures, and the TOTP issuer follows the name.
 */

const LEGAL_KEYS = brandLegalKeys;
const URL_KEYS = ['privacyUrl', 'termsUrl', 'guidelinesUrl', 'childSafetyUrl', 'deleteAccountUrl'] as const;
const BRAND_KEY = /^[a-z0-9_][a-z0-9_-]{0,31}$/;

/** The hosts a legal link may use: brand.json's domains and the hosts of its own links. */
function linkHostsOf(app: FastifyInstance): string[] {
  const hosts = new Set<string>(Object.values(app.brand.domains).filter((host): host is string => typeof host === 'string').map((host) => host.toLowerCase()));
  for (const value of Object.values(app.brand.legal)) {
    if (typeof value !== 'string' || !value.startsWith('https://')) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // brand.json's own values are checked at load.
    }
  }
  return [...hosts].sort();
}

/** The origin welcome pictures come from: the deployment's media CDN, else brand.json's CDN domain. */
function mediaOriginOf(app: FastifyInstance): string | null {
  const base = app.config.storage?.cdn?.baseUrl ?? (app.brand.domains.cdn ? `https://${app.brand.domains.cdn}` : undefined);
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** A change of a legal value needs config.legal and, while one is required, the second factor. */
async function requireLegal(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const principal = request.principal;
  const roles = principal?.kind === 'admin' ? principal.roles : [];
  if (app.adminAuth.roles.allows(roles, 'config.legal') !== true) {
    throw adminForbidden('role', 'Your role does not allow changing the legal links or the support e-mail.', { headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } });
  }
  await app.requireMfa(request, reply);
}

function buildValues(app: FastifyInstance): AdminBrandValues {
  const brand = app.brand;
  return {
    appName: brand.appName,
    supportEmail: brand.legal.supportEmail,
    privacyUrl: brand.legal.privacyUrl,
    termsUrl: brand.legal.termsUrl,
    guidelinesUrl: brand.legal.guidelinesUrl,
    childSafetyUrl: brand.legal.childSafetyUrl ?? `https://${brand.domains.legal}/child-safety/`,
    deleteAccountUrl: brand.legal.deleteAccountUrl,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The panel's values in a row's `config` (only text values count). */
function savedValues(config: Record<string, unknown> | undefined): Partial<AdminBrandValues> {
  const out: Partial<AdminBrandValues> = {};
  if (!config) return out;
  if (typeof config['appName'] === 'string' && config['appName'].length > 0) out.appName = config['appName'];
  const legal = record(config['legal']);
  for (const key of LEGAL_KEYS) {
    const value = legal[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

function imagesOf(welcome: unknown): string[] {
  const images = record(welcome)['images'];
  return Array.isArray(images) ? images.filter((url): url is string => typeof url === 'string') : [];
}

/** The stored state a form was built from: the active row, the welcome, and (with no active row) the brand's own row. */
function versionOf(row: Pick<BrandSettingsRow, 'active' | 'welcome' | 'sameKey'>): string {
  return settingsVersion([row.active?.config ?? null, row.welcome ?? null, row.active ? null : (row.sameKey?.config ?? null)], 'brand');
}

function viewOf(app: FastifyInstance, row: BrandSettingsRow): AdminBrand {
  const own = row.active?.key === app.brand.id ? row.active : null;
  const updatedAtMs = Math.max(row.active?.updatedAtMs ?? 0, row.welcomeUpdatedAtMs ?? 0);
  const updatedBy = (row.active?.updatedAtMs ?? 0) >= (row.welcomeUpdatedAtMs ?? 0) ? (row.active?.updatedBy ?? row.welcomeUpdatedBy) : row.welcomeUpdatedBy;
  return adminBrandSchema.parse({
    version: versionOf(row),
    brandId: app.brand.id,
    build: buildValues(app),
    saved: savedValues(own?.config ?? row.active?.config),
    welcomeImages: imagesOf(row.welcome),
    linkHosts: linkHostsOf(app),
    mediaOrigin: mediaOriginOf(app),
    colors: { brand: app.brand.colors.brand, onBrand: app.brand.colors.onBrand },
    fonts: { latin: app.brand.fonts.latin, persian: app.brand.fonts.persian },
    updatedAt: updatedAtMs > 0 ? wireTime(updatedAtMs) : null,
    updatedBy: updatedAtMs > 0 ? adminRefOf(updatedBy ?? null) : null,
  });
}

export const adminBrandRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];

  app.get(
    '/v1/admin/brand',
    {
      preHandler: app.requirePermission('config.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The brand values the app reads at run time', response: { 200: adminBrandSchema } },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return viewOf(app, await brandSettingsValue(app.pg, app.brand.id));
    },
  );

  app.put(
    '/v1/admin/brand',
    {
      preHandler: app.requirePermission('config.write'),
      // The locked read, the two rows in one statement, the audit row.
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Change the brand values the app reads at run time', body: adminBrandUpdateSchema, response: { 200: adminBrandSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.appName !== null && !brandAppNameValid(body.appName)) {
        throw fieldInvalid('/appName', 'invalid', 'The app name takes letters, digits and spaces, without { or }.');
      }
      const hosts = linkHostsOf(app);
      for (const key of URL_KEYS) {
        const url = body[key];
        if (url !== null && !brandUrlOnHosts(url, hosts)) throw fieldInvalid(`/${key}`, 'host_not_allowed', 'Use an address on the brand\'s own domains.');
      }
      const media = mediaOriginOf(app);
      body.welcomeImages.forEach((url, index) => {
        if (!brandUrlFromOrigin(url, media)) throw fieldInvalid(`/welcomeImages/${index}`, 'host_not_allowed', 'Pictures come from the media server only.');
        if (body.welcomeImages.indexOf(url) !== index) throw fieldInvalid(`/welcomeImages/${index}`, 'duplicate', 'This picture is listed twice.');
      });
      const brandKey = app.brand.id;
      const saved = await adminWrite(app, request, async (tx, trail) => {
        const row = await brandSettingsForUpdate(tx, brandKey, actorOf(request).adminId);
        if (versionOf(row) !== body.baseVersion) throw adminConflict('settings_changed', 'The brand was changed meanwhile; load it again and save from there.');
        if ((row.active && row.active.key !== brandKey) || !BRAND_KEY.test(brandKey) || row.sameKey?.id === 0) {
          throw adminConflict('brand_mismatch', 'The database holds another brand, or this brand cannot be stored here.');
        }
        // No active row: the brand's own row (deactivated by hand) is made active again with its other keys.
        const config: Record<string, unknown> = { ...(row.active?.config ?? row.sameKey?.config ?? {}) };
        if (body.appName === null) delete config['appName'];
        else config['appName'] = body.appName.trim();
        const legal: Record<string, unknown> = { ...record(config['legal']) };
        for (const key of LEGAL_KEYS) {
          const value = body[key];
          if (value === null) delete legal[key];
          else legal[key] = value;
        }
        if (Object.keys(legal).length > 0) config['legal'] = legal;
        else delete config['legal'];
        const welcome: Record<string, unknown> = { ...record(row.welcome) };
        if (body.welcomeImages.length > 0) welcome['images'] = [...body.welcomeImages];
        else delete welcome['images'];
        const after: BrandSettingsRow = {
          ...row,
          welcome,
          active: { id: row.active?.id ?? row.sameKey?.id ?? row.nextId, key: brandKey, config, updatedAtMs: Date.now(), updatedBy: row.actor ?? null },
          sameKey: { id: row.active?.id ?? row.sameKey?.id ?? row.nextId, config },
        };
        const same = row.active !== null && stableJson(row.active.config) === stableJson(config) && stableJson(row.welcome) === stableJson(welcome);
        if (same) {
          trail.unchanged();
          return { changed: false, row };
        }
        // What the app is served before and after: a legal value that moves needs config.legal and the second factor.
        const servedBefore = savedValues(row.active?.config);
        const servedAfter = savedValues(config);
        if (LEGAL_KEYS.some((key) => (servedBefore[key] ?? null) !== (servedAfter[key] ?? null))) await requireLegal(app, request, reply);
        await brandSettingsSave(tx, { id: after.active!.id, key: brandKey, config, welcome, adminId: actorOf(request).adminId });
        const beforeValues = { ...savedValues(row.active?.config), welcomeImages: imagesOf(row.welcome) };
        const afterValues = { ...savedValues(config), welcomeImages: imagesOf(welcome) };
        trail.record({
          action: 'config.update',
          target: 'config',
          detail: {
            key: 'brand',
            changed: [...brandValueKeys, 'welcomeImages'].filter(
              (k) => stableJson((beforeValues as Record<string, unknown>)[k] ?? null) !== stableJson((afterValues as Record<string, unknown>)[k] ?? null),
            ),
            before: beforeValues,
            after: afterValues,
          },
        });
        return { changed: true, row: after };
      });
      if (saved.changed) {
        if (!(await app.cfg.announce())) request.log.warn('brand: saved; the announcement to the other processes is retried in the background');
        request.log.info('brand: saved');
      }
      reply.header('cache-control', 'no-store');
      return viewOf(app, saved.row);
    },
  );
};
