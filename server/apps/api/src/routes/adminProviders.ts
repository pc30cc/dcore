import {
  ProviderSettingsError,
  auditViewOf,
  effectiveProviders,
  mergeProviderUpdate,
  openStoredProvider,
  providerConfigKey,
  providerFingerprint,
  secretFieldFingerprint,
  type EnvProviders,
  type OpenedProvider,
} from '@app/config';
import { configValueDelete, configValueForUpdate, configValueSave, configValues, type ConfigValueRow } from '@app/db';
import {
  PROVIDER_WRITES_PER_HOUR,
  adminProviderDeleteSchema,
  adminProviderParamsSchema,
  adminProviderSchema,
  adminProviderUpdateSchema,
  adminProvidersSchema,
  providerKinds,
  providerSecretFields,
  providerSourceSchema,
  wireTime,
  type AdminProvider,
  type ProviderApplied,
  type ProviderKind,
  type ProviderSource,
  type SecretView,
} from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, adminWrite } from '../admin/audit.js';
import { settingsVersion } from '../admin/configRules.js';
import { takeAdminLimit } from '../admin/limits.js';
import { adminConflict, adminForbidden, fieldInvalid } from '../admin/problems.js';
import { adminRefOf } from '../admin/refs.js';

/**
 * Provider credentials in the admin panel (`config.providers`, restricted: superadmin;
 * a second factor while one is required):
 *
 *   GET    /v1/admin/providers          the six kinds: the panel's entry, the deployment's values, what each
 *                                       process applied (secrets as fingerprints only), and the read-only
 *                                       storage, LiveKit and photo-moderation state
 *   PUT    /v1/admin/providers/{kind}   { kind, baseVersion, enabled, settings, secrets? } (secrets not sent are kept)
 *   DELETE /v1/admin/providers/{kind}   { baseVersion }: back to the deployment's values
 *
 * Secrets are write-only: sealed (AES-256-GCM under PROVIDER_KEYS, purpose
 * `providers.<kind>.secrets`), never in an answer, a log line or an audit
 * row (fingerprints there). A write is one transaction with its audit row
 * (`config.update`, key `providers.<kind>`), at most 60 an hour per admin,
 * then `cfg:changed`: every API process rebuilds the provider's client from
 * memory, the worker within 5 seconds (FCM, stores). The first save of a
 * kind inserts its row only if no other first save made it meanwhile
 * (409 `settings_changed` otherwise). A Play entry must carry its RTDN
 * audience while the deployment's Play has one (422 `rtdn_required`).
 */

const APPLIED_FRESH_MS = 3 * 60_000;
const APPLIED_PRUNE_MS = 60 * 60_000;

const appliedEntrySchema = z.object({
  atMs: z.number().int(),
  hash: z.string(),
  kinds: z.record(z.string(), z.object({ source: providerSourceSchema, fp: z.string().nullable() })),
  moderation: z.object({ provider: z.string(), autoApprove: z.boolean() }).optional(),
});
type AppliedEntry = z.infer<typeof appliedEntrySchema> & { field: string };

const unset: SecretView = { set: false, fingerprint: null, unreadable: false };
const secretView = (value: string | undefined, field: string): SecretView =>
  value ? { set: true, fingerprint: secretFieldFingerprint(field, value), unreadable: false } : unset;

/** Reads the processes' reports; old ones are left out (and those older than an hour removed). */
async function readApplied(app: FastifyInstance, request: FastifyRequest): Promise<AppliedEntry[] | null> {
  let raw: Record<string, string>;
  try {
    raw = await app.redis.hgetall(app.keys.providersApplied());
  } catch (error) {
    request.log.warn({ err: error }, 'providers: the processes\' reports could not be read');
    return null;
  }
  const now = Date.now();
  const entries: AppliedEntry[] = [];
  const stale: string[] = [];
  for (const [field, value] of Object.entries(raw)) {
    let parsed: z.infer<typeof appliedEntrySchema> | null;
    try {
      const result = appliedEntrySchema.safeParse(JSON.parse(value));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed || now - parsed.atMs > APPLIED_PRUNE_MS) stale.push(field);
    else if (now - parsed.atMs <= APPLIED_FRESH_MS) entries.push({ ...parsed, field });
  }
  if (stale.length > 0) {
    void app.redis.hdel(app.keys.providersApplied(), ...stale).catch((error: unknown) => request.log.debug({ err: error }, 'providers: old reports not removed'));
  }
  return entries;
}

function appliedOf(kind: ProviderKind, entries: readonly AppliedEntry[]): ProviderApplied[] {
  const out: ProviderApplied[] = [];
  for (const entry of entries) {
    const applied = entry.kinds[kind];
    if (!applied) continue;
    const [process, ...name] = entry.field.split(':');
    if (process !== 'api' && process !== 'worker') continue;
    out.push({ process, name: name.join(':'), source: applied.source, fingerprint: applied.fp, at: wireTime(entry.atMs) });
  }
  return out.sort((a, b) => a.process.localeCompare(b.process) || a.name.localeCompare(b.name));
}

/** The deployment's values of a kind as the panel shows them. */
function envView(kind: ProviderKind, env: EnvProviders): AdminProvider['env'] {
  if (kind === 'fcm') return { known: false, set: false };
  const present = { known: true, set: true } as const;
  switch (kind) {
    case 'kavenegar': {
      const c = env.kavenegar;
      return c ? { ...present, settings: { template: c.template }, secrets: { apiKey: secretView(c.apiKey, 'apiKey') } } : { known: true, set: false };
    }
    case 'smsir': {
      const c = env.smsir;
      return c ? { ...present, settings: { templateId: c.templateId, parameter: c.parameter }, secrets: { apiKey: secretView(c.apiKey, 'apiKey') } } : { known: true, set: false };
    }
    case 'telnyx': {
      const c = env.telnyx;
      return c ? { ...present, settings: { verifyProfileId: c.verifyProfileId }, secrets: { apiKey: secretView(c.apiKey, 'apiKey') } } : { known: true, set: false };
    }
    case 'play': {
      const c = env.play;
      if (!c) return { known: true, set: false };
      return {
        ...present,
        settings: { packageName: c.packageName, rtdnAudience: c.rtdn?.audience ?? null, rtdnPushServiceAccountEmail: c.rtdn?.pushServiceAccountEmail ?? null },
        secrets: { serviceAccountJson: { set: true, fingerprint: providerFingerprint(c.serviceAccount.privateKey), unreadable: false } },
        account: { clientEmail: c.serviceAccount.clientEmail },
      };
    }
    case 'bazaar': {
      const c = env.bazaar;
      if (!c) return { known: true, set: false };
      const auth = c.auth;
      return {
        ...present,
        settings: { packageName: c.packageName, rsaPublicKey: c.rsaPublicKey, auth: auth.kind, clientId: auth.kind === 'oauth' ? auth.clientId : null },
        secrets:
          auth.kind === 'pishkhan'
            ? { pishkhanToken: secretView(auth.token, 'pishkhanToken') }
            : { clientSecret: secretView(auth.clientSecret, 'clientSecret'), refreshToken: secretView(auth.refreshToken, 'refreshToken') },
      };
    }
  }
}

function settingsView(settings: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** A service account's e-mail (and FCM's project), shown in clear. */
function accountOf(kind: ProviderKind, opened: OpenedProvider): AdminProvider['env']['account'] {
  const json = opened.secrets['serviceAccountJson'];
  if ((kind !== 'play' && kind !== 'fcm') || !json) return undefined;
  try {
    const text = json.trim();
    const parsed = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8')) as Record<string, unknown>;
    const clientEmail = typeof parsed['client_email'] === 'string' ? parsed['client_email'] : null;
    if (!clientEmail) return undefined;
    const projectId = kind === 'fcm' ? (opened.settings['projectId'] as string | null) ?? (typeof parsed['project_id'] === 'string' ? parsed['project_id'] : null) : null;
    return projectId ? { clientEmail, projectId } : { clientEmail };
  } catch {
    return undefined;
  }
}

function panelView(app: FastifyInstance, kind: ProviderKind, value: unknown): AdminProvider['panel'] {
  const opened = openStoredProvider(kind, value, app.providers.sealer);
  if (opened === null) return null;
  if (opened === 'unreadable') {
    const raw = (value ?? {}) as { enabled?: unknown; settings?: unknown };
    return {
      enabled: raw.enabled === true,
      settings: typeof raw.settings === 'object' && raw.settings !== null ? settingsView(raw.settings as Record<string, unknown>) : {},
      secrets: Object.fromEntries(providerSecretFields[kind].map((name) => [name, { set: true, fingerprint: null, unreadable: true }])),
    };
  }
  const view = auditViewOf(opened);
  const account = accountOf(kind, opened);
  return {
    enabled: opened.enabled,
    settings: settingsView(opened.settings),
    secrets: Object.fromEntries(Object.entries(view.secrets).map(([name, fp]) => [name, { set: true, fingerprint: fp, unreadable: false }])),
    ...(account ? { account } : {}),
  };
}

function providerOf(app: FastifyInstance, kind: ProviderKind, row: ConfigValueRow | undefined, applied: readonly AppliedEntry[] | null): AdminProvider {
  const key = providerConfigKey(kind);
  const value = row?.value ?? null;
  const reports = appliedOf(kind, applied ?? []);
  let source: ProviderSource = effectiveProviders(app.providers.env, row ? { [key]: value } : {}, app.providers.sealer).sources[kind];
  // FCM is the worker's: without a panel entry, what the workers report.
  if (kind === 'fcm' && !row) source = reports.find((r) => r.process === 'worker')?.source ?? 'none';
  return adminProviderSchema.parse({
    kind,
    source,
    version: settingsVersion(row ? value : undefined, key),
    updatedAt: row?.updatedAtMs !== null && row?.updatedAtMs !== undefined ? wireTime(row.updatedAtMs) : null,
    updatedBy: adminRefOf(row?.updatedBy ?? null),
    panel: panelView(app, kind, row ? value : null),
    env: envView(kind, app.providers.env),
    applied: reports,
  });
}

function readOnlyOf(app: FastifyInstance, applied: readonly AppliedEntry[] | null) {
  const storage = app.config.storage;
  const livekit = app.config.livekit;
  const fp = (value: string | undefined): SecretView => (value ? { set: true, fingerprint: providerFingerprint(value), unreadable: false } : unset);
  const workers = (applied ?? []).filter((entry) => entry.field.startsWith('worker:') && entry.moderation);
  return {
    storage: {
      configured: storage !== undefined,
      endpoint: storage?.endpoint ?? null,
      region: storage?.region ?? null,
      privateBucket: storage?.privateBucket ?? null,
      mediaBucket: storage?.mediaBucket ?? null,
      pathStyle: storage?.pathStyle ?? null,
      accessKeyId: fp(storage?.accessKeyId),
      secretAccessKey: fp(storage?.secretAccessKey),
      cdn: storage?.cdn ? { baseUrl: storage.cdn.baseUrl, scheme: storage.cdn.scheme, signingKey: fp(storage.cdn.signingKey) } : null,
    },
    livekit: {
      configured: livekit !== undefined,
      apiUrl: livekit?.apiUrl ?? null,
      apiKey: livekit?.apiKey ?? null,
      apiSecret: fp(livekit?.apiSecret),
      identitySecret: fp(livekit?.identitySecret),
    },
    moderation: {
      provider: workers[0]?.moderation?.provider ?? 'fake',
      autoApprove: workers.length === 0 ? null : workers.some((entry) => entry.moderation?.autoApprove === true),
    },
  };
}

export const adminProviderRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const guard = [app.requirePermission('config.providers'), app.requireMfa];
  const keys = providerKinds.map(providerConfigKey);

  app.get(
    '/v1/admin/providers',
    {
      preHandler: guard,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Provider credentials (fingerprints only) and what each process uses', response: { 200: adminProvidersSchema } },
    },
    async (request, reply) => {
      const rows = new Map((await configValues(app.pg, keys)).map((row) => [row.key, row]));
      const applied = await readApplied(app, request);
      reply.header('cache-control', 'no-store');
      return {
        items: providerKinds.map((kind) => providerOf(app, kind, rows.get(providerConfigKey(kind)), applied)),
        readOnly: readOnlyOf(app, applied),
        appliedKnown: applied !== null,
      };
    },
  );

  app.put(
    '/v1/admin/providers/:kind',
    {
      preHandler: guard,
      // The locked read, the value, the audit row.
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Set a provider\'s credentials (write-only secrets)', params: adminProviderParamsSchema, body: adminProviderUpdateSchema, response: { 200: adminProviderSchema } },
    },
    async (request, reply) => {
      const kind = request.params.kind;
      const body = request.body;
      if (body.kind !== kind) throw fieldInvalid('/kind', 'invalid', 'The body names another provider.');
      // Without PROVIDER_KEYS (outside production only) nothing can be sealed: the entries are shown, never written.
      const sealer = app.providers.sealer;
      if (!sealer) throw adminForbidden('read_only', 'PROVIDER_KEYS is not set on this deployment: provider entries cannot be saved.');
      // A panel Play entry replaces the deployment's whole: without its RTDN audience, notifications the deployment
      // took would be refused from then on.
      if (body.kind === 'play' && body.enabled && body.settings.rtdnAudience === null && app.providers.env.play?.rtdn) {
        throw fieldInvalid('/settings/rtdnAudience', 'rtdn_required', 'The deployment receives Play notifications: name their audience and push e-mail too.');
      }
      const key = providerConfigKey(kind);
      const ticket = await takeAdminLimit(app, request, 'provider_write', PROVIDER_WRITES_PER_HOUR);
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const stored = await configValueForUpdate(tx, key);
        if (settingsVersion(stored.exists ? stored.value : undefined, key) !== body.baseVersion) {
          throw adminConflict('settings_changed', 'The provider was changed meanwhile; load it again and save from there.');
        }
        let merged;
        try {
          merged = mergeProviderUpdate(kind, stored.value, { enabled: body.enabled, settings: body.settings, secrets: body.secrets }, sealer);
        } catch (error) {
          if (error instanceof ProviderSettingsError) throw fieldInvalid(error.pointer, error.code, error.message);
          throw error;
        }
        if (stored.exists && merged.changed.length === 0) {
          trail.unchanged();
          return { changed: [] as string[], row: null };
        }
        // A first save of the kind inserts only: another first save that won meanwhile makes this one stale.
        const row = await configValueSave(tx, key, merged.value, actorOf(request).adminId, stored.exists);
        if (!row) throw adminConflict('settings_changed', 'The provider was changed meanwhile; load it again and save from there.');
        trail.record({ action: 'config.update', target: 'config', detail: { key, changed: merged.changed, before: merged.before, after: merged.after } });
        return { changed: merged.changed, row };
      });
      let row: ConfigValueRow | undefined = outcome.row ?? undefined;
      if (outcome.changed.length === 0) {
        await ticket.refund();
        row = (await configValues(app.pg, [key]))[0];
      } else {
        if (!(await app.cfg.announce())) request.log.warn({ kind }, 'providers: saved; the announcement to the other processes is retried in the background');
        request.log.info({ kind, changed: outcome.changed }, 'providers: saved');
      }
      reply.header('cache-control', 'no-store');
      return providerOf(app, kind, row, await readApplied(app, request));
    },
  );

  app.delete(
    '/v1/admin/providers/:kind',
    {
      preHandler: guard,
      // The locked read, the delete, the audit row.
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Use the deployment\'s values for a provider again', params: adminProviderParamsSchema, body: adminProviderDeleteSchema, response: { 200: adminProviderSchema } },
    },
    async (request, reply) => {
      const kind = request.params.kind;
      const key = providerConfigKey(kind);
      const ticket = await takeAdminLimit(app, request, 'provider_write', PROVIDER_WRITES_PER_HOUR);
      const cleared = await adminWrite(app, request, async (tx, trail) => {
        const stored = await configValueForUpdate(tx, key);
        if (settingsVersion(stored.exists ? stored.value : undefined, key) !== request.body.baseVersion) {
          throw adminConflict('settings_changed', 'The provider was changed meanwhile; load it again and save from there.');
        }
        if (!stored.exists) {
          trail.unchanged();
          return false;
        }
        await configValueDelete(tx, key);
        const opened = openStoredProvider(kind, stored.value, app.providers.sealer);
        const before = opened && opened !== 'unreadable' ? auditViewOf(opened) : 'unreadable';
        trail.record({ action: 'config.update', target: 'config', detail: { key, cleared: true, before } });
        return true;
      });
      if (cleared) {
        if (!(await app.cfg.announce())) request.log.warn({ kind }, 'providers: cleared; the announcement to the other processes is retried in the background');
        request.log.info({ kind }, 'providers: back to the deployment values');
      } else {
        await ticket.refund();
      }
      reply.header('cache-control', 'no-store');
      return providerOf(app, kind, undefined, await readApplied(app, request));
    },
  );
};
