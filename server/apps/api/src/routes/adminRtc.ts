import { rtcSettingsForUpdate, rtcSettingsValue, saveConfigWithAudit, withTransaction } from '@app/db';
import { rtcSettingsPatchSchema, rtcSettingsViewSchema, type RtcSettingsView } from '@app/shared';
import { RTC_SETTINGS_KEY, RtcSettingsError, mergeRtcSettings, rtcSettingsOf, turnSecretFingerprint, type RtcSettings } from '@app/shared/server';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { nextId } from '../auth/sessions.js';
import { settingsVersion } from '../admin/configRules.js';
import { adminConflict } from '../admin/problems.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The admin panel's RTC settings (`config.providers`, superadmin):
 *
 *   GET /v1/admin/providers/rtc   the settings, the relay's secret only as a fingerprint
 *   PUT /v1/admin/providers/rtc   a change (absent fields stay; `sharedSecret` is write-only, '' removes it)
 *
 * The save reads the stored row in its transaction (`FOR UPDATE`, never the
 * cached copy, so keys this build does not know and the sealed secret
 * survive), merges the change, checks the merged value (a TURN URL needs the
 * secret; never LiveKit's own host), seals a new secret (AES-256-GCM under
 * DATA_KEYS), and writes it with its audit row in one statement: the names
 * of the fields that changed, with their values before and after (the
 * secret only as its fingerprint), so a change can be read back from the
 * log. Then every API process reloads its copy (`cfg:changed`).
 */

type AuditedField = 'wsUrl' | 'maxLiveCalls' | 'turn.urls' | 'turn.countries' | 'turn.credentialTtlSeconds' | 'turn.sharedSecret';

/** The audited value of one changed field: what the settings hold, the secret as its fingerprint (or null). */
function auditValue(settings: RtcSettings, field: AuditedField): unknown {
  switch (field) {
    case 'wsUrl':
      return settings.wsUrl;
    case 'maxLiveCalls':
      return settings.maxLiveCalls;
    case 'turn.urls':
      return settings.relay.urls;
    case 'turn.countries':
      return settings.relay.countries;
    case 'turn.credentialTtlSeconds':
      return settings.relay.credentialTtlSeconds;
    case 'turn.sharedSecret':
      return settings.relay.secret ? turnSecretFingerprint(settings.relay.secret) : settings.relay.secretStored ? 'unreadable' : null;
  }
}

function auditDetail(app: FastifyInstance, stored: unknown, merged: Record<string, unknown>, changed: readonly string[]) {
  const before = rtcSettingsOf(stored, app.secrets.sealer);
  const after = rtcSettingsOf(merged, app.secrets.sealer);
  const fields = changed.filter((f): f is AuditedField =>
    ['wsUrl', 'maxLiveCalls', 'turn.urls', 'turn.countries', 'turn.credentialTtlSeconds', 'turn.sharedSecret'].includes(f),
  );
  return {
    changed,
    before: Object.fromEntries(fields.map((f) => [f, auditValue(before, f)])),
    after: Object.fromEntries(fields.map((f) => [f, auditValue(after, f)])),
  };
}

/** A hash of the stored row: the view's `version`, which a change may name (`baseVersion`). */
function versionOf(stored: unknown): string {
  return settingsVersion(stored ?? undefined, RTC_SETTINGS_KEY);
}

function viewOf(app: FastifyInstance, settings: RtcSettings, version: string): RtcSettingsView {
  const secret = settings.relay.secret;
  return rtcSettingsViewSchema.parse({
    wsUrl: settings.wsUrl,
    effectiveWsUrl: app.calls.rtc.clientWsUrl(settings),
    turnUrls: settings.relay.urls,
    countries: settings.relay.countries,
    credentialTtlSeconds: settings.relay.credentialTtlSeconds,
    maxLiveCalls: settings.maxLiveCalls,
    sharedSecret: { stored: settings.relay.secretStored, fingerprint: secret ? turnSecretFingerprint(secret) : null },
    version,
  });
}

export const adminRtcRoutes: FastifyPluginAsyncZod = async (app) => {
  // config.providers is restricted (superadmin), with a second factor while one is required.
  const guard = [app.requirePermission('config.providers'), app.requireMfa];

  app.get(
    '/v1/admin/providers/rtc',
    {
      preHandler: guard,
      config: { pgBudget: 1 },
      schema: { tags: ['admin'], summary: 'The call network settings', response: { 200: rtcSettingsViewSchema } },
    },
    async () => {
      const value = await rtcSettingsValue(app.pg, RTC_SETTINGS_KEY);
      return viewOf(app, rtcSettingsOf(value, app.secrets.sealer), versionOf(value));
    },
  );

  app.put(
    '/v1/admin/providers/rtc',
    {
      preHandler: guard,
      config: { pgBudget: 2 },
      schema: { tags: ['admin'], summary: 'Change the call network settings', body: rtcSettingsPatchSchema, response: { 200: rtcSettingsViewSchema } },
    },
    async (request) => {
      const principal = request.principal;
      const adminId = principal && /^[1-9][0-9]{0,8}$/.test(principal.subject) ? Number(principal.subject) : null;
      const sessionId = principal && /^[1-9][0-9]{0,18}$/.test(principal.sessionId) ? principal.sessionId : null;
      const auditId = nextId(app);
      const saved = await withTransaction(app.pg, async (tx) => {
        const stored = await rtcSettingsForUpdate(tx, RTC_SETTINGS_KEY);
        if (request.body.baseVersion !== undefined && versionOf(stored) !== request.body.baseVersion) {
          throw adminConflict('settings_changed', 'The call settings were changed meanwhile; load them again and save from there.');
        }
        let merged;
        try {
          const { baseVersion: _version, ...patch } = request.body;
          merged = mergeRtcSettings(stored, patch, app.secrets.sealer);
        } catch (error) {
          if (error instanceof RtcSettingsError) {
            throw new HttpProblem('field_invalid', { detail: error.message, errors: [{ in: 'body', pointer: error.pointer, code: 'invalid', message: error.message }] });
          }
          throw error;
        }
        await saveConfigWithAudit(tx, RTC_SETTINGS_KEY, merged.value, {
          auditId,
          adminId,
          sessionId,
          ip: request.clientIp,
          detail: auditDetail(app, stored, merged.value, merged.changed),
        });
        return merged;
      });
      const settings = app.calls.rtc.set(saved.value);
      if (!(await app.cfg.announce())) request.log.warn('rtc: saved; the announcement to the other processes is retried in the background');
      request.log.info({ changed: saved.changed }, 'rtc settings saved');
      return viewOf(app, settings, versionOf(saved.value));
    },
  );
};
