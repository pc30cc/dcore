import { uiTemplates, type AdminAppearance, type AdminAppearanceUpdate, type FieldIssue, type GradientStops, type UiTemplate } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';

/**
 * The appearance form: which template is the default and which ones people
 * may choose. The default is always offered: choosing a default turns it
 * on, and its switch cannot be turned off.
 */

export interface AppearanceForm {
  defaultTemplate: UiTemplate;
  offered: Record<UiTemplate, boolean>;
}

export function appearanceFormOf(view: AdminAppearance): AppearanceForm {
  const offered = Object.fromEntries(uiTemplates.map((id) => [id, false])) as Record<UiTemplate, boolean>;
  for (const entry of view.templates) offered[entry.id] = entry.offered;
  offered[view.defaultTemplate] = true;
  return { defaultTemplate: view.defaultTemplate, offered };
}

/** A new default, offered from now on. */
export function withDefault(form: AppearanceForm, id: UiTemplate): AppearanceForm {
  return { defaultTemplate: id, offered: { ...form.offered, [id]: true } };
}

/** Offers a template or stops offering it; the default stays offered. */
export function withOffered(form: AppearanceForm, id: UiTemplate, on: boolean): AppearanceForm {
  if (id === form.defaultTemplate && !on) return form;
  return { ...form, offered: { ...form.offered, [id]: on } };
}

/** The offered templates, in display order. */
export function offeredIds(form: AppearanceForm): UiTemplate[] {
  return uiTemplates.filter((id) => form.offered[id]);
}

/** The save: the form, and the version it was built from (a save in between is refused). */
export function appearanceBody(form: AppearanceForm, baseVersion: string): AdminAppearanceUpdate {
  return { baseVersion, defaultTemplate: form.defaultTemplate, offered: offeredIds(form) };
}

export function sameAppearance(a: AppearanceForm, b: AppearanceForm): boolean {
  return a.defaultTemplate === b.defaultTemplate && offeredIds(a).join() === offeredIds(b).join();
}

/** What keeps the form from being saved, if anything (the API checks the same). */
export function appearanceProblem(form: AppearanceForm): MessageKey | null {
  if (!form.offered[form.defaultTemplate]) return 'appearance.error.defaultNotOffered';
  return null;
}

/** The panel's words for a refusal of `PUT /v1/admin/appearance` it knows, else null. */
export function appearanceServerProblem(issues: readonly FieldIssue[]): MessageKey | null {
  return issues.some((issue) => issue.code === 'default_not_offered') ? 'appearance.error.defaultNotOffered' : null;
}

/** The names people see for each template. */
export const templateName: Readonly<Record<UiTemplate, MessageKey>> = {
  neon: 'appearance.template.neon',
  white: 'appearance.template.white',
};

/** The colours a template's preview is drawn with (CSS values), so the panel shows each one as the app does. */
export interface SwatchColors {
  canvas: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  button: string;
  onButton: string;
  accent: string;
}

/** `white`'s palette, fixed in the app. */
const WHITE_SWATCH: SwatchColors = {
  canvas: '#FFFFFF',
  surface: '#F4F4F6',
  line: '#E7E7EB',
  text: '#111114',
  muted: '#8E8E96',
  button: '#111114',
  onButton: '#FFFFFF',
  accent: '#5B2FD9',
};

/**
 * The previews' colours. `neon` takes its "yes" gradient from the active
 * brand (the API's `neonGradient`, as the app builds it); its surfaces are
 * fixed in the app, like all of `white`.
 */
export function templateSwatches(neonGradient: GradientStops): Readonly<Record<UiTemplate, SwatchColors>> {
  return {
    neon: {
      canvas: '#0A090E',
      surface: '#1E1B27',
      line: '#26232F',
      text: '#F5F2FA',
      muted: '#8C8599',
      button: `linear-gradient(250deg, ${neonGradient.start} 0%, ${neonGradient.mid} 52%, ${neonGradient.end} 100%)`,
      onButton: '#FFFFFF',
      accent: '#FF4D9D',
    },
    white: WHITE_SWATCH,
  };
}
