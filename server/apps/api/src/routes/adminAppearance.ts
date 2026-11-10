import { createHash } from 'node:crypto';
import { uiTemplatesForUpdate, uiTemplatesSave, uiTemplatesValue } from '@app/db';
import {
  UI_TEMPLATES_DEFAULT,
  adminAppearanceSchema,
  adminAppearanceUpdateSchema,
  neonGradientOf,
  uiSettingsOf,
  uiTemplates,
  uiTemplatesConfigSchema,
  type AdminAppearance,
  type GradientStops,
  type UiSettings,
  type UiTemplatesConfig,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { actorOf, adminWrite } from '../admin/audit.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The visual templates in the admin panel:
 *
 *   GET /v1/admin/appearance   the default template and, for every template
 *                              this build knows (display order), whether it
 *                              is offered
 *   PUT /v1/admin/appearance   { defaultTemplate, offered }
 *
 * Reads need `config.read`, the save `config.write`. The read goes to the
 * database (one statement), so the panel sees its own save at once. The
 * save locks the row, compares, and writes the value with its audit row
 * (`config.update`, before and after) in one transaction; a save that
 * changes nothing writes nothing and announces nothing. After the commit
 * `cfg:changed` makes every API process load the configuration again, so
 * `GET /v1/config` serves the new `ui` block (and a new ETag) from memory;
 * when Valkey refuses the announcement, this process loads it at once and
 * the announcement is retried (`ConfigService.announce`).
 *
 * The default is always offered (422 `default_not_offered` otherwise). The
 * stored ids follow the display order of this build. A person's stored
 * choice is never touched here: the app shows the default while the choice
 * is not offered.
 *
 * Every read carries a `version` of the stored value; a save names the one
 * its form was built from (`baseVersion`) and is refused with 409
 * `conflict` when the stored value moved meanwhile, so a form built before
 * another admin's save never reverts it. The read also carries the stops
 * of the brand's "yes" gradient that `neon` is drawn with.
 */

function storedValue(raw: unknown): UiTemplatesConfig | null {
  const parsed = uiTemplatesConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The version of a stored value: a hash of what it says (the same value always has the same version). */
function versionOf(raw: unknown): string {
  const parsed = storedValue(raw);
  const canonical = parsed ? ['ui', parsed.default, parsed.offered] : ['raw', raw ?? null];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 22);
}

function viewOf(ui: UiSettings, version: string, neonGradient: GradientStops): AdminAppearance {
  return {
    version,
    defaultTemplate: ui.defaultTemplate,
    templates: uiTemplates.map((id) => ({ id, offered: ui.templates.includes(id) })),
    neonGradient,
  };
}

export const adminAppearanceRoutes: FastifyPluginAsyncZod = async (app) => {
  // The brand this deployment (and its app) is built with: the app draws neon's gradient from its stops.
  const neonGradient = (): GradientStops => neonGradientOf(app.brand.colors);

  app.get(
    '/v1/admin/appearance',
    {
      preHandler: app.requirePermission('config.read'),
      config: { pgBudget: 1 },
      schema: { tags: ['admin'], summary: 'The default template and the templates people may choose', response: { 200: adminAppearanceSchema } },
    },
    async () => {
      const raw = await uiTemplatesValue(app.pg);
      return viewOf(uiSettingsOf(storedValue(raw) ?? UI_TEMPLATES_DEFAULT), versionOf(raw), neonGradient());
    },
  );

  app.put(
    '/v1/admin/appearance',
    {
      preHandler: app.requirePermission('config.write'),
      // The locked read, the value, the audit row.
      config: { pgBudget: 3 },
      schema: {
        tags: ['admin'],
        summary: 'Choose the default template and the templates people may choose',
        body: adminAppearanceUpdateSchema,
        response: { 200: adminAppearanceSchema },
      },
    },
    async (request) => {
      const body = request.body;
      if (!body.offered.includes(body.defaultTemplate)) {
        const message = 'The default template must be one of the offered templates.';
        throw new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer: '/offered', code: 'default_not_offered', message }] });
      }
      const offered = new Set(body.offered);
      const after: UiTemplatesConfig = { default: body.defaultTemplate, offered: uiTemplates.filter((id) => offered.has(id)) };
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const raw = await uiTemplatesForUpdate(tx);
        if (versionOf(raw) !== body.baseVersion) {
          throw new HttpProblem('conflict', { detail: 'The appearance was changed meanwhile; load it again and save from there.' });
        }
        const stored = storedValue(raw);
        const same = stored !== null && stored.default === after.default && JSON.stringify(stored.offered) === JSON.stringify(after.offered);
        if (same) {
          trail.unchanged();
          return { changed: false };
        }
        await uiTemplatesSave(tx, after, actorOf(request).adminId);
        trail.record({
          action: 'config.update',
          target: 'config',
          // before: the stored value (as stored when the schema refuses it, null when missing).
          detail: { key: 'ui.templates', before: stored ?? raw, after },
        });
        return { changed: true };
      });
      if (outcome.changed) {
        if (!(await app.cfg.announce())) request.log.warn('appearance: saved; the announcement to the other processes is retried in the background');
        request.log.info({ defaultTemplate: after.default, offered: after.offered }, 'appearance: templates saved');
      }
      return viewOf(uiSettingsOf(after), versionOf(after), neonGradient());
    },
  );
};
