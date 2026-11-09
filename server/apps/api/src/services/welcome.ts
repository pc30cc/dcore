import type { BrandWelcome, Locale, WelcomeConfig, WelcomeOverride } from '@app/shared';

/**
 * The welcome block of `GET /v1/config` for one locale: each text from the
 * panel (app_config `brand.welcome`) when it set one for this locale, else
 * from brand.json; the colours likewise; picture URLs from the panel only
 * (brand.json names files the app ships). No cross-locale fallback here:
 * the app falls back to the brand's default locale and then to its own
 * strings, so a text missing in this locale is simply left out. Undefined
 * when neither sets anything.
 */
export function welcomeFor(brand: BrandWelcome | undefined, override: WelcomeOverride, locale: Locale): WelcomeConfig | undefined {
  const text = (key: 'eyebrow' | 'headline' | 'subtitle'): string | undefined => override[key]?.[locale] ?? brand?.[key]?.[locale];
  const eyebrow = text('eyebrow');
  const headline = text('headline');
  const subtitle = text('subtitle');
  const gradient = override.gradient ?? brand?.gradient;
  const images = override.images ?? [];
  if (eyebrow === undefined && headline === undefined && subtitle === undefined && gradient === undefined && images.length === 0) return undefined;
  return {
    ...(eyebrow === undefined ? {} : { eyebrow }),
    ...(headline === undefined ? {} : { headline }),
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(gradient === undefined ? {} : { gradient: { top: gradient.top, middle: gradient.middle, bottom: gradient.bottom } }),
    images: [...images],
  };
}
