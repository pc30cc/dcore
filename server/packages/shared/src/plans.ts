import { z } from 'zod';
import { entitlementFeatureKeys } from './api/common.js';
import type { Locale } from './locale.js';

/**
 * What a plan can give, as the code knows it: switches (`plan_features`
 * rows with a boolean) and quotas (rows with a number; -1 is unlimited).
 * The admin panel edits exactly these; a value a plan has no row for is the
 * default here. A new feature is added here and in the code that reads it.
 *
 * - switches: the entitlement features (see likes, rewind, read receipts,
 *   incognito, travel mode, advanced filters, profile views, second look,
 *   priority likes) and the call switches (`audio_calls`, `video_calls`:
 *   calls are open unless a plan turns them off);
 * - quotas: daily likes, weekly super likes, daily direct messages, the
 *   weekly direct-message gift, monthly boosts.
 */

export const planFlagKeys = [...entitlementFeatureKeys, 'audio_calls', 'video_calls'] as const;
export type PlanFlag = (typeof planFlagKeys)[number];

export const planQuotaKeys = ['daily_likes', 'weekly_superlikes', 'daily_dm', 'weekly_dm_gift', 'monthly_boosts'] as const;
export type PlanQuota = (typeof planQuotaKeys)[number];

/** The value of a switch a plan has no row for. */
export const planFlagDefaults: Readonly<Record<PlanFlag, boolean>> = {
  see_likes: false,
  rewind: false,
  read_receipts: false,
  incognito: false,
  travel_mode: false,
  advanced_filters: false,
  profile_views: false,
  second_look: false,
  priority_likes: false,
  audio_calls: true,
  video_calls: true,
};

/** A quota a plan has no row for gives nothing. */
export const PLAN_QUOTA_DEFAULT = 0;
/** -1 is unlimited; anything above this is a typing error. */
export const PLAN_QUOTA_MAX = 1_000_000;

/** The key of a plan made in the panel: neutral, at most 31 characters, never reused. */
export const NEW_PLAN_KEY = /^[a-z][a-z0-9_]{1,30}$/;
/** Everyone's plan: the baseline every other plan ranks above. */
export const FREE_PLAN_KEY = 'free';

export const PLAN_NAME_MAX = 40;
export const PLAN_DESCRIPTION_MAX = 200;

export type PlanFeatureValues = Readonly<Record<string, number | boolean>>;

/** Every switch of a plan, the defaults filling what it has no row for. */
export function planFlags(features: PlanFeatureValues | undefined): Record<PlanFlag, boolean> {
  return Object.fromEntries(
    planFlagKeys.map((key) => {
      const value = features?.[key];
      return [key, typeof value === 'boolean' ? value : planFlagDefaults[key]];
    }),
  ) as Record<PlanFlag, boolean>;
}

/** Every quota of a plan (-1 unlimited); a missing or malformed value is 0. */
export function planQuotas(features: PlanFeatureValues | undefined): Record<PlanQuota, number> {
  return Object.fromEntries(
    planQuotaKeys.map((key) => {
      const value = features?.[key];
      return [key, typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : PLAN_QUOTA_DEFAULT];
    }),
  ) as Record<PlanQuota, number>;
}

/** A text of a per-locale map in `locale`, else Persian, else English. */
export function localizedText(texts: Readonly<Record<string, unknown>> | undefined, locale: Locale): string | undefined {
  for (const key of [locale, 'fa', 'en']) {
    const value = texts?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The name of a plan in `locale`: the plan's own names (the panel's), with
 * the brand's `planNames` filling a locale the plan has none for; then
 * Persian, then English; the key as the last resort.
 */
export function planDisplayName(
  key: string,
  names: Readonly<Record<string, unknown>> | undefined,
  brandNames: Readonly<Record<string, Partial<Record<Locale, string>>>> | undefined,
  locale: Locale,
): string {
  const own = Object.fromEntries(Object.entries(names ?? {}).filter(([, value]) => typeof value === 'string' && value.length > 0));
  return localizedText({ ...(brandNames?.[key] ?? {}), ...own }, locale) ?? key;
}

export const planFlagsSchema = z.object(
  Object.fromEntries(planFlagKeys.map((key) => [key, z.boolean()])) as Record<PlanFlag, z.ZodBoolean>,
);
export const planQuotasSchema = z.object(
  Object.fromEntries(planQuotaKeys.map((key) => [key, z.number().int().min(-1)])) as Record<PlanQuota, z.ZodNumber>,
);
