import { describe, expect, it } from 'vitest';
import {
  DESIGN_GRADIENT_DARK,
  FALLBACK_TEMPLATE,
  TEMPLATE_DEFAULT_CHOICE,
  UI_TEMPLATES_DEFAULT,
  adminAppearanceSchema,
  adminAppearanceUpdateSchema,
  configSchema,
  neonGradientOf,
  effectiveTemplate,
  parseAppConfigValue,
  settingsPatchSchema,
  settingsSchema,
  templateChoices,
  uiConfigSchema,
  uiSettingsOf,
  uiTemplateChoice,
  uiTemplates,
} from '../src/index.js';

/** The template list, its code table, the stored setting and the wire shapes that carry them. */

describe('the template list', () => {
  it('is the code table of profiles.ui_template, with default first and codes that never move', () => {
    expect(uiTemplateChoice.names).toEqual([TEMPLATE_DEFAULT_CHOICE, ...uiTemplates]);
    expect([...templateChoices]).toEqual([...uiTemplateChoice.names]);
    expect(uiTemplateChoice.code('default')).toBe(0);
    expect(uiTemplateChoice.code('neon')).toBe(1);
    expect(uiTemplateChoice.code('white')).toBe(2);
    expect(uiTemplates).toContain(FALLBACK_TEMPLATE);
  });

  it('seeds every template offered, with the fallback as the default', () => {
    expect(UI_TEMPLATES_DEFAULT).toEqual({ default: 'neon', offered: ['neon', 'white'] });
    expect(uiSettingsOf(UI_TEMPLATES_DEFAULT)).toEqual({ defaultTemplate: 'neon', templates: ['neon', 'white'] });
  });
});

describe('the stored setting as served', () => {
  it('lists the offered templates in display order, whatever order was stored', () => {
    expect(uiSettingsOf({ default: 'white', offered: ['white', 'neon'] })).toEqual({ defaultTemplate: 'white', templates: ['neon', 'white'] });
    expect(uiSettingsOf({ default: 'white', offered: ['white'] })).toEqual({ defaultTemplate: 'white', templates: ['white'] });
  });

  it('always holds the default, and keeps only ids this build knows', () => {
    expect(uiSettingsOf({ default: 'white', offered: ['neon'] })).toEqual({ defaultTemplate: 'white', templates: ['neon', 'white'] });
    expect(uiSettingsOf({ default: 'white', offered: [] })).toEqual({ defaultTemplate: 'white', templates: ['white'] });
    // A default written by a newer build: the first known offered template, else the fallback.
    expect(uiSettingsOf({ default: 'sand', offered: ['sand', 'white'] })).toEqual({ defaultTemplate: 'white', templates: ['white'] });
    expect(uiSettingsOf({ default: 'sand', offered: ['sand'] })).toEqual({ defaultTemplate: 'neon', templates: ['neon'] });
  });

  it('loads a stored value with ids it does not know, and refuses a malformed one', () => {
    expect(parseAppConfigValue('ui.templates', { default: 'sand', offered: ['sand', 'neon'] })).toEqual({ default: 'sand', offered: ['sand', 'neon'] });
    expect(() => parseAppConfigValue('ui.templates', { default: 'Neon!', offered: [] })).toThrow(/ui\.templates/);
    expect(() => parseAppConfigValue('ui.templates', { default: 'neon' })).toThrow();
    expect(() => parseAppConfigValue('ui.templates', { default: 'neon', offered: ['neon'], extra: 1 })).toThrow();
  });
});

describe('the effective template', () => {
  const ui = { defaultTemplate: 'white', templates: ['neon', 'white'] };
  const shipped = ['neon', 'white'];

  it('is the choice when the app ships it and the panel offers it', () => {
    expect(effectiveTemplate('neon', ui, shipped)).toBe('neon');
    expect(effectiveTemplate('white', ui, shipped)).toBe('white');
  });

  it('is the panel’s default for "default", for a choice no longer offered, and for one the app does not ship', () => {
    expect(effectiveTemplate('default', ui, shipped)).toBe('white');
    expect(effectiveTemplate('neon', { defaultTemplate: 'white', templates: ['white'] }, shipped)).toBe('white');
    expect(effectiveTemplate('sand', { defaultTemplate: 'white', templates: ['sand', 'white'] }, shipped)).toBe('white');
  });

  it('falls back to neon when the app does not ship the default', () => {
    expect(effectiveTemplate('default', { defaultTemplate: 'sand', templates: ['sand'] }, shipped)).toBe('neon');
    expect(effectiveTemplate('white', { defaultTemplate: 'sand', templates: ['sand'] }, shipped)).toBe('neon');
  });

  it('follows a later change of the default for everyone on "default"', () => {
    expect(effectiveTemplate('default', { defaultTemplate: 'neon', templates: ['neon', 'white'] }, shipped)).toBe('neon');
    expect(effectiveTemplate('default', { defaultTemplate: 'white', templates: ['neon', 'white'] }, shipped)).toBe('white');
  });
});

describe('the wire', () => {
  it('requires ui in GET /v1/config, its default among the templates; ids a newer server knows still parse', () => {
    expect(uiConfigSchema.safeParse({ defaultTemplate: 'neon', templates: ['neon', 'white'] }).success).toBe(true);
    expect(uiConfigSchema.safeParse({ defaultTemplate: 'sand', templates: ['neon', 'sand'] }).success).toBe(true);
    expect(uiConfigSchema.safeParse({ defaultTemplate: 'white', templates: ['neon'] }).success).toBe(false);
    expect(uiConfigSchema.safeParse({ defaultTemplate: 'neon', templates: [] }).success).toBe(false);
    expect(uiConfigSchema.safeParse({ defaultTemplate: 'Neon', templates: ['Neon'] }).success).toBe(false);
    expect(configSchema.shape.ui.safeParse(undefined).success).toBe(false);
  });

  it('carries the choice in settings and validates it in a patch', () => {
    const settings = { incognito: false, hideAge: false, hideDistance: false, showOnline: true, acceptCalls: true, modeRomance: true, snoozed: false };
    expect(settingsSchema.safeParse({ ...settings, template: 'default' }).success).toBe(true);
    expect(settingsSchema.safeParse(settings).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ template: 'white' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ template: 'sand' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it('takes the whole admin setting with the version it replaces: known ids, once each, nothing else', () => {
    const baseVersion = 'q1w2e3r4t5y6u7i8o9p0aa';
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'white', offered: ['neon', 'white'] }).success).toBe(true);
    expect(adminAppearanceUpdateSchema.safeParse({ defaultTemplate: 'white', offered: ['neon', 'white'] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion: 'a b', defaultTemplate: 'white', offered: ['white'] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'sand', offered: ['neon'] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'neon', offered: ['neon', 'sand'] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'neon', offered: ['neon', 'neon'] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'neon', offered: [] }).success).toBe(false);
    expect(adminAppearanceUpdateSchema.safeParse({ baseVersion, defaultTemplate: 'neon', offered: ['neon'], extra: true }).success).toBe(false);
    const view = { version: baseVersion, defaultTemplate: 'neon', templates: [{ id: 'neon', offered: true }], neonGradient: { ...DESIGN_GRADIENT_DARK } };
    expect(adminAppearanceSchema.safeParse(view).success).toBe(true);
    expect(adminAppearanceSchema.safeParse({ ...view, neonGradient: { ...DESIGN_GRADIENT_DARK, mid: 'violet' } }).success).toBe(false);
  });
});

describe('the gradient neon is drawn with', () => {
  it('is the brand’s dark stops, each the design’s own when the brand leaves it out or names no colour', () => {
    expect(neonGradientOf({ brand: {}, onBrand: {} })).toEqual(DESIGN_GRADIENT_DARK);
    expect(
      neonGradientOf({
        gradientStart: { light: '#000000', dark: '#11ccaa' },
        gradientMid: { light: '#000000', dark: 'teal' },
        gradientEnd: { light: '#000000', dark: '#2255FF' },
      }),
    ).toEqual({ start: '#11CCAA', mid: DESIGN_GRADIENT_DARK.mid, end: '#2255FF' });
    expect(neonGradientOf({ gradientStart: '#11ccaa', gradientEnd: { light: '#2255FF' } })).toEqual(DESIGN_GRADIENT_DARK);
  });
});
