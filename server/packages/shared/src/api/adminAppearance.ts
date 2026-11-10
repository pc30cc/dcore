import { z } from 'zod';
import { uiTemplateSchema, uiTemplates } from '../templates.js';

/**
 * The admin panel's appearance routes (`/v1/admin/appearance`): which
 * visual template is the default and which ones people may choose. Every
 * template this build knows is listed, in display order; the default is
 * always offered.
 */

/** A version of the stored setting (opaque): a save names the one its form was built from. */
export const appearanceVersionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const hexColor = z.string().regex(/^#[0-9A-F]{6}$/);

export const adminAppearanceSchema = z.object({
  version: appearanceVersionSchema,
  defaultTemplate: uiTemplateSchema,
  templates: z.array(z.object({ id: uiTemplateSchema, offered: z.boolean() })),
  /** The "yes" gradient `neon` is drawn with in the app: the active brand's dark stops. */
  neonGradient: z.object({ start: hexColor, mid: hexColor, end: hexColor }),
});
export type AdminAppearance = z.infer<typeof adminAppearanceSchema>;

/**
 * `PUT /v1/admin/appearance`: the whole setting, and the version it
 * replaces (409 `conflict` when another save came in between). An unknown
 * id is refused by the schema; a default that is not offered by the route
 * (422 `field_invalid`, code `default_not_offered`).
 */
export const adminAppearanceUpdateSchema = z.strictObject({
  baseVersion: appearanceVersionSchema,
  defaultTemplate: uiTemplateSchema,
  offered: z
    .array(uiTemplateSchema)
    .min(1)
    .max(uiTemplates.length)
    .refine((ids) => new Set(ids).size === ids.length, 'a template is listed twice'),
});
export type AdminAppearanceUpdate = z.infer<typeof adminAppearanceUpdateSchema>;
