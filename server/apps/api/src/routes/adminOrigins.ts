import { originsSettingsForUpdate, originsSettingsValue, saveOriginsSettings, withTransaction } from '@app/db';
import {
  ORIGINS_DEFAULT_VERSION,
  originsAdminViewSchema,
  originsSettingsSchema,
  originsUpdateSchema,
  validateOrigins,
  type FieldIssue,
  type OriginsAdminView,
  type OriginsSettings,
} from '@app/shared';
import { jobId } from '@app/shared/server';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The hosts of the signed origins document, from the admin panel (superadmin):
 *
 *   GET /v1/admin/origins   the stored hosts (or the deployment's own), the
 *                           signing key's public part and the document served
 *   PUT /v1/admin/origins   a change of the hosts
 *
 * A save reads the stored row in its transaction (`FOR UPDATE`, never the
 * cached copy), checks the rules (`https` only, origins without a path, no IP
 * address unless `allowIpHosts`, at least one API host), raises the version
 * and writes the value with its audit row (the version and the hosts before
 * and after) in one statement. Then this process serves the new document at
 * once, every other one reloads (`cfg:changed`, which also moves `cfg:v`, so
 * apps revalidating `GET /v1/config` see a new version and fetch the
 * document again), and the worker publishes the copies.
 */

function storedSettings(value: unknown): OriginsSettings | null {
  if (value === null) return null;
  const parsed = originsSettingsSchema.safeParse(value);
  // A value the rules refuse is never served (the configuration keeps its last good load); the panel sees it as unsaved.
  return parsed.success ? parsed.data : null;
}

function viewOf(app: FastifyInstance, stored: OriginsSettings | null): OriginsAdminView {
  const { origins } = app;
  const defaults = origins.defaults;
  const signer = origins.signer;
  const listed = app.brand.origins.publicKeys;
  const served = origins.current();
  return originsAdminViewSchema.parse({
    saved: stored !== null,
    version: stored?.version ?? ORIGINS_DEFAULT_VERSION,
    hosts: stored?.hosts ?? defaults.hosts,
    bootstrap: stored?.bootstrap ?? defaults.bootstrap,
    allowIpHosts: stored?.allowIpHosts ?? false,
    defaults: { hosts: defaults.hosts, bootstrap: defaults.bootstrap },
    signing: {
      configured: signer !== null,
      kid: signer?.kid ?? null,
      publicKey: signer?.publicKey ?? null,
      trusted: signer === null || listed.length === 0 ? null : listed.some((entry) => entry.kid === signer.kid && entry.key === signer.publicKey),
    },
    document: served ? { version: served.payload.version, issuedAt: served.payload.issuedAt, expiresAt: served.payload.expiresAt } : null,
  });
}

function sameContent(a: OriginsSettings, b: Omit<OriginsSettings, 'version'>): boolean {
  return JSON.stringify([a.hosts, a.bootstrap, a.allowIpHosts]) === JSON.stringify([b.hosts, b.bootstrap, b.allowIpHosts]);
}

export const adminOriginsRoutes: FastifyPluginAsyncZod = async (app) => {
  const superadmin = app.requireAdmin('superadmin');

  app.get(
    '/v1/admin/origins',
    {
      preHandler: superadmin,
      config: { pgBudget: 1 },
      schema: { tags: ['admin'], summary: 'The hosts apps are sent to', response: { 200: originsAdminViewSchema } },
    },
    async () => viewOf(app, storedSettings(await originsSettingsValue(app.pg))),
  );

  app.put(
    '/v1/admin/origins',
    {
      preHandler: superadmin,
      config: { pgBudget: 2 },
      schema: { tags: ['admin'], summary: 'Change the hosts apps are sent to', body: originsUpdateSchema, response: { 200: originsAdminViewSchema } },
    },
    async (request) => {
      const body = request.body;
      const principal = request.principal;
      const adminId = principal && /^[1-9][0-9]{0,8}$/.test(principal.subject) ? Number(principal.subject) : null;
      const sessionId = principal && /^[1-9][0-9]{0,18}$/.test(principal.sessionId) ? principal.sessionId : null;
      const auditId = nextId(app);
      const outcome = await withTransaction(app.pg, async (tx) => {
        const raw = await originsSettingsForUpdate(tx);
        const stored = storedSettings(raw);
        if (raw !== null && stored === null) request.log.warn('origins: the stored hosts do not pass the rules; the save replaces them');
        // A hand-written value the rules refuse still holds a version apps may know: never go below it.
        const rawVersion = typeof raw === 'object' && raw !== null && Number.isSafeInteger((raw as { version?: unknown }).version) ? Number((raw as { version: number }).version) : 0;
        const currentVersion = Math.max(stored?.version ?? ORIGINS_DEFAULT_VERSION, rawVersion);
        if (body.baseVersion !== undefined && body.baseVersion !== currentVersion) {
          throw new HttpProblem('conflict', { detail: `The hosts were changed meanwhile (version ${currentVersion}); reload and try again.` });
        }
        const checked = validateOrigins({
          hosts: body.hosts,
          bootstrap: body.bootstrap ?? stored?.bootstrap ?? app.origins.defaults.bootstrap,
          allowIpHosts: body.allowIpHosts ?? false,
        });
        if (!checked.ok) {
          const errors: FieldIssue[] = checked.issues.map((issue) => ({ in: 'body', pointer: issue.pointer, code: 'invalid', message: issue.message }));
          throw new HttpProblem('field_invalid', { detail: checked.issues[0]?.message ?? 'not valid', errors });
        }
        const content = { hosts: checked.hosts, bootstrap: checked.bootstrap, allowIpHosts: checked.allowIpHosts };
        if (stored && sameContent(stored, content)) return { saved: stored, changed: false };
        const value: OriginsSettings = originsSettingsSchema.parse({ version: currentVersion + 1, ...content });
        await saveOriginsSettings(tx, value, {
          auditId,
          adminId,
          sessionId,
          ip: request.clientIp,
          detail: {
            version: { from: currentVersion, to: value.version },
            before: stored ? { hosts: stored.hosts, bootstrap: stored.bootstrap, allowIpHosts: stored.allowIpHosts } : null,
            after: content,
          },
        });
        return { saved: value, changed: true };
      });
      if (outcome.changed) {
        // This process serves the new document now; the others reload on cfg:changed.
        app.origins.update(outcome.saved);
        if (!(await app.cfg.announce())) request.log.warn('origins: saved; the announcement to the other processes is retried in the background');
        await app.jobs
          .add('system', 'origins-publish', jobId('origins-publish', outcome.saved.version), { version: outcome.saved.version }, { attempts: 8, backoffMs: 1_000 })
          .catch((error: unknown) => request.log.warn({ err: error }, 'origins: the publish job was not queued; the worker publishes on its next round'));
        request.log.info({ version: outcome.saved.version }, 'origins: hosts saved');
      }
      return viewOf(app, outcome.saved);
    },
  );
};
