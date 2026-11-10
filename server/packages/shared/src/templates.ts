import { z } from 'zod';

/**
 * The app's visual templates. `uiTemplates` is the list this code knows, in
 * display order; ids are neutral and never change once shipped. A person's
 * stored choice is `default` (follow the template the admin panel names as
 * the default) or one of these ids; a new account is `default`.
 *
 * The panel picks the default and which templates are offered (app_config
 * `ui.templates`); the default is always offered. `GET /v1/config` carries
 * the result as `ui` (only ids this build knows, in display order), and the
 * app decides what to show with {@link effectiveTemplate}.
 */
export const uiTemplates = ['neon', 'white'] as const;
export type UiTemplate = (typeof uiTemplates)[number];
export const uiTemplateSchema = z.enum(uiTemplates);

export function isUiTemplate(value: string): value is UiTemplate {
  return (uiTemplates as readonly string[]).includes(value);
}

/** The stored choice that follows the panel's default. */
export const TEMPLATE_DEFAULT_CHOICE = 'default';
export const templateChoices = [TEMPLATE_DEFAULT_CHOICE, ...uiTemplates] as const;
export type TemplateChoice = (typeof templateChoices)[number];
/** A person's choice on the wire (settings): `default` or a template id this build knows. */
export const templateChoiceSchema = z.enum(templateChoices);

/** What is shown when neither the choice nor the default is a template the app ships. */
export const FALLBACK_TEMPLATE: UiTemplate = 'neon';

/** A template id as `GET /v1/config` sends it: apps meet ids a newer server knows, and fall back. */
export const TEMPLATE_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const templateIdSchema = z.string().regex(TEMPLATE_ID);

/**
 * app_config `ui.templates` as stored. Ids are checked for their form only,
 * so a value written by a newer build (a template this one does not know)
 * still loads; {@link uiSettingsOf} keeps the ids this build knows.
 */
export const uiTemplatesConfigSchema = z.strictObject({
  default: templateIdSchema,
  offered: z.array(templateIdSchema).max(32),
});
export type UiTemplatesConfig = z.infer<typeof uiTemplatesConfigSchema>;

/** The value seeded by the migration and used while nothing else was saved. */
export const UI_TEMPLATES_DEFAULT: UiTemplatesConfig = { default: FALLBACK_TEMPLATE, offered: [...uiTemplates] };

/** The `ui` block of `GET /v1/config`. */
export interface UiSettings {
  defaultTemplate: UiTemplate;
  /** Offered templates in display order; always holds `defaultTemplate`. */
  templates: UiTemplate[];
}

/**
 * The panel's stored value as it is served: the offered ids this build
 * knows, in display order, and the default among them. A default this build
 * does not know becomes the first known offered template (else the
 * fallback); a default missing from the offered ids is added to them.
 */
export function uiSettingsOf(stored: UiTemplatesConfig): UiSettings {
  const offered = new Set(stored.offered);
  const known = uiTemplates.filter((id) => offered.has(id));
  const defaultTemplate: UiTemplate = isUiTemplate(stored.default) ? stored.default : (known[0] ?? FALLBACK_TEMPLATE);
  const templates = uiTemplates.filter((id) => id === defaultTemplate || offered.has(id));
  return { defaultTemplate, templates };
}

/**
 * The template an app shows: the person's choice when the app ships it and
 * the panel offers it; else the panel's default when the app ships it; else
 * the fallback. A choice the panel stopped offering stays stored and comes
 * back when it is offered again.
 */
export function effectiveTemplate(choice: string, ui: { defaultTemplate: string; templates: readonly string[] }, shipped: readonly string[]): string {
  if (choice !== TEMPLATE_DEFAULT_CHOICE && shipped.includes(choice) && ui.templates.includes(choice)) return choice;
  if (shipped.includes(ui.defaultTemplate)) return ui.defaultTemplate;
  return FALLBACK_TEMPLATE;
}

/** The three stops of a "yes" gradient (`#RRGGBB`). */
export interface GradientStops {
  start: string;
  mid: string;
  end: string;
}

/** The design system's own dark "yes" stops, for a brand that names none (the app's fallback too). */
export const DESIGN_GRADIENT_DARK: Readonly<GradientStops> = { start: '#7B2BFF', mid: '#C21FD0', end: '#E0157A' };

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function darkStop(colors: Readonly<Record<string, unknown>>, role: string, fallback: string): string {
  const themed = colors[role];
  const dark = typeof themed === 'object' && themed !== null ? (themed as Record<string, unknown>)['dark'] : undefined;
  return typeof dark === 'string' && HEX_COLOR.test(dark) ? dark.toUpperCase() : fallback;
}

/**
 * The stops `neon` (a dark template) draws its "yes" gradient with: the
 * brand's `gradientStart` / `gradientMid` / `gradientEnd`, dark variant,
 * each one the design's own when the brand leaves it out, as the app builds it.
 */
export function neonGradientOf(colors: Readonly<Record<string, unknown>>): GradientStops {
  return {
    start: darkStop(colors, 'gradientStart', DESIGN_GRADIENT_DARK.start),
    mid: darkStop(colors, 'gradientMid', DESIGN_GRADIENT_DARK.mid),
    end: darkStop(colors, 'gradientEnd', DESIGN_GRADIENT_DARK.end),
  };
}
