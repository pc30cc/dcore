import { createHash } from 'node:crypto';
import type { AccountView, AccountViewResult } from '@app/db';
import {
  accountStatus,
  appealStatus,
  consentKind,
  gender,
  intention,
  legalConsentKinds,
  maskToCodes,
  moderationKind,
  notifyFlags,
  photoStatus,
  preferenceFlags,
  store as storeCodes,
  textState,
  wireTime,
  type AppStore,
  type LegalConsentKind,
  type Locale,
  type Me,
  type ModerationAction,
  type NotificationPrefs,
  type OwnProfile,
  type Preferences,
  type Settings,
} from '@app/shared';
import type { ConfigSnapshot } from './cfg.js';
import type { CityIndex } from './cities.js';
import { label, photoRejectLabels } from './labels.js';

/**
 * From the cached own-account view (codes, epoch-ms times) to the wire
 * shapes of `GET /v1/me` and the own-profile edits. Everything that depends
 * on the session (store, build), on the request (language) or on the
 * configuration in memory (legal versions, feature flags, labels) is added
 * here, so one cached view serves every session of the account.
 */

/** Signed media links for the account's own photos; absent while storage is not configured. */
export type OwnPhotoUrl = (photo: { id: string; blobVer: number }) => string | undefined;

export interface MeContext {
  publicUid: string;
  billingRef: string;
  /** The session's store (`st`, else `X-Client`). */
  store: AppStore | undefined;
  versionCode: number | undefined;
  locale: Locale;
  cfg: ConfigSnapshot;
  cities: CityIndex;
  photoUrl: OwnPhotoUrl;
  now?: Date | undefined;
}

const GENDER_CODES = gender.codes;
const INTENTION_CODES = intention.codes;

export function ageOn(birthDate: string, today: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const month = today.getUTCMonth() + 1;
  if (month < m || (month === m && today.getUTCDate() < d)) age -= 1;
  return age;
}

function cityRef(cities: CityIndex, id: number | undefined, locale: Locale): { id: number; name: string } | undefined {
  if (id === undefined) return undefined;
  const city = cities.get(id);
  return city ? { id, name: cities.nameOf(city, locale) } : undefined;
}

export function rejectText(cfg: ConfigSnapshot, code: number | undefined, locale: Locale): string {
  const strings = cfg.strings.get(locale) ?? {};
  const key = code ?? 0;
  return strings[`photo.reject.${key}`] ?? label(photoRejectLabels[key] ?? photoRejectLabels[0], locale, 'Not approved');
}

export function settingsOf(view: AccountView): Settings {
  const p = view.profile;
  return {
    incognito: p?.incognito ?? false,
    hideAge: p?.hideAge ?? false,
    hideDistance: p?.hideDistance ?? false,
    showOnline: p?.showOnline ?? true,
    acceptCalls: p?.acceptCalls ?? true,
    modeRomance: p?.modeMatch ?? true,
    snoozed: view.status === accountStatus.code('snoozed'),
  };
}

export function preferencesOf(view: AccountView): Preferences | undefined {
  const p = view.preferences;
  if (!p) return undefined;
  const filters: Preferences['filters'] = {};
  for (const [key, value] of Object.entries(p.filters)) {
    if (Array.isArray(value) && value.length > 0 && value.every((v) => Number.isInteger(v))) filters[key] = value as number[];
  }
  return {
    interestedIn: maskToCodes(p.interestedIn, GENDER_CODES).map((code) => gender.name(code)),
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    maxDistanceKm: p.maxDistanceKm,
    wholeCountry: (p.flags & preferenceFlags.code('whole_country')) !== 0,
    verifiedOnly: (p.flags & preferenceFlags.code('verified_only')) !== 0,
    intents: maskToCodes(p.intents, INTENTION_CODES).map((code) => intention.name(code)),
    filters,
  };
}

export function notificationsOf(mask: number): NotificationPrefs {
  const on = (name: (typeof notifyFlags.names)[number]) => (mask & notifyFlags.code(name)) !== 0;
  return { messages: on('messages'), matches: on('matches'), likes: on('likes'), calls: on('calls'), offers: on('offers'), previews: on('previews') };
}

/** Completeness 0-100 from what the account has filled in (also written to profiles.completeness). */
export function completenessOf(view: AccountView, cfg: ConfigSnapshot): number {
  const p = view.profile;
  if (!p) return 0;
  let score = 0;
  if (p.name) score += 10;
  if (p.about) score += 15;
  if (p.job) score += 5;
  if (p.intention !== undefined) score += 10;
  const photos = view.photos.filter((ph) => ph.status !== photoStatus.code('rejected')).length;
  score += Math.min(photos, 6) * 5;
  const prompts = view.prompts.filter((pp) => pp.status !== textState.code('rejected')).length;
  score += Math.min(prompts, 3) * 5;
  const active = cfg.fields.filter((f) => f.active);
  if (active.length === 0) score += 15;
  else {
    const answered = new Set(view.fields.map((f) => f.fieldId));
    score += Math.round((15 * active.filter((f) => answered.has(f.id)).length) / active.length);
  }
  return Math.max(0, Math.min(100, score));
}

export function ownProfileOf(view: AccountView, ctx: MeContext): OwnProfile {
  const p = view.profile;
  const now = ctx.now ?? new Date();
  const city = cityRef(ctx.cities, view.location?.travel?.untilMs && view.location.travel.untilMs > now.getTime() ? view.location.travel.cityId : view.location?.cityId, ctx.locale);
  const traveling = view.location?.travel !== undefined && view.location.travel.untilMs > now.getTime();
  return {
    id: ctx.publicUid,
    v: p?.v ?? 1,
    ...(p?.name ? { name: p.name } : {}),
    ...(view.birthDate ? { age: ageOn(view.birthDate, now), birthDate: view.birthDate } : {}),
    ...(view.gender !== undefined ? { gender: gender.name(view.gender) } : {}),
    verified: view.verified,
    ...(p?.intention !== undefined ? { intention: intention.name(p.intention) } : {}),
    ...(p?.job ? { job: p.job } : {}),
    ...(p?.about ? { about: p.about } : {}),
    ...(city ? { city } : {}),
    ...(traveling ? { traveling: true as const } : {}),
    photos: view.photos.map((ph) => {
      const status = photoStatus.name(ph.status);
      const url = status === 'approved' || status === 'review' ? ctx.photoUrl({ id: ph.id, blobVer: ph.blobVer }) : undefined;
      return {
        id: ph.id,
        position: ph.position,
        status,
        ...(status === 'rejected' ? { rejectReason: rejectText(ctx.cfg, ph.rejectReason, ctx.locale) } : {}),
        ...(ph.w !== undefined && ph.h !== undefined && ph.w > 0 && ph.h > 0 ? { w: ph.w, h: ph.h } : {}),
        ...(ph.blurhash ? { blurhash: ph.blurhash } : {}),
        ...(url ? { url } : {}),
      };
    }),
    textState: textState.name(p?.textState ?? textState.code('checking')),
    prompts: view.prompts.map((pp) => ({
      promptId: pp.promptId,
      position: pp.position,
      ...(pp.answer !== undefined ? { answer: pp.answer } : {}),
      ...(pp.audioMs !== undefined ? { audioMs: pp.audioMs } : {}),
      status: textState.name(pp.status),
    })),
    fields: view.fields.map((f) => ({
      fieldId: f.fieldId,
      ...(f.option !== undefined ? { option: f.option } : {}),
      ...(f.options !== undefined ? { options: f.options } : {}),
      ...(f.number !== undefined ? { number: f.number } : {}),
      ...(f.text !== undefined ? { text: f.text } : {}),
    })),
    completeness: completenessOf(view, ctx.cfg),
    settings: settingsOf(view),
  };
}

/** The legal texts whose current version the account has not accepted, from the config in memory. */
export function consentsDueOf(view: AccountView, cfg: ConfigSnapshot): LegalConsentKind[] {
  const versions = cfg.app['legal.versions'];
  return legalConsentKinds.filter((kind) => (view.consents[String(consentKind.code(kind))] ?? 0) < versions[kind]);
}

export function moderationActionOf(action: AccountView['moderation'][number]): ModerationAction | undefined {
  const kind = moderationKind.name(action.kind);
  if (kind !== 'warning' && kind !== 'suspension' && kind !== 'ban') return undefined;
  return {
    id: action.id,
    kind,
    reasonText: action.reasonText,
    startsAt: wireTime(action.startsAtMs),
    ...(action.endsAtMs !== undefined ? { endsAt: wireTime(action.endsAtMs) } : {}),
    ...(action.appeal
      ? {
          appeal: {
            id: action.appeal.id,
            status: appealStatus.name(action.appeal.status),
            ...(action.appeal.decisionText ? { decisionText: action.appeal.decisionText } : {}),
          },
        }
      : {}),
  };
}

function rolloutBucket(flagKey: string, userId: string): number {
  return createHash('sha256').update(`${flagKey}:${userId}`).digest().readUInt32BE(0) % 100;
}

/**
 * Feature flags for this person: on when enabled, inside the rollout
 * (`hash(flag, user) mod 100 < rollout_pct`) and matching every rule the flag
 * names (countries, stores, platforms, min_version). A rule on plans keeps
 * the flag off until entitlements are part of this view.
 */
export function featureFlagsOf(view: AccountView, userId: string, ctx: Pick<MeContext, 'cfg' | 'store' | 'versionCode'>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const storeCode = ctx.store ? storeCodes.code(ctx.store) : undefined;
  for (const flag of ctx.cfg.flags) {
    let on = flag.enabled && rolloutBucket(flag.key, userId) < flag.rolloutPct;
    const rules = flag.rules;
    if (on && Array.isArray(rules['countries'])) {
      const country = view.country ?? view.location?.country;
      on = country !== undefined && (rules['countries'] as unknown[]).includes(country);
    }
    if (on && Array.isArray(rules['stores'])) on = storeCode !== undefined && (rules['stores'] as unknown[]).includes(storeCode);
    if (on && Array.isArray(rules['platforms'])) on = (rules['platforms'] as unknown[]).includes(1);
    if (on && typeof rules['min_version'] === 'number') on = ctx.versionCode !== undefined && ctx.versionCode >= rules['min_version'];
    if (on && rules['plans'] !== undefined) on = false;
    out[flag.key] = on;
  }
  return out;
}

export function meOf(result: AccountViewResult, userId: string, ctx: MeContext): Me | null {
  if (result.kind === 'missing' || result.kind === 'purged') return null;
  if (result.kind === 'deleted') {
    return { id: ctx.publicUid, status: 'deleted', deletion: { purgeAt: wireTime(result.purgeAtMs) } };
  }
  const view = result.view;
  const preferences = preferencesOf(view);
  const loc = view.location;
  const now = (ctx.now ?? new Date()).getTime();
  const homeCity = cityRef(ctx.cities, loc?.cityId, ctx.locale);
  const travelCity = loc?.travel && loc.travel.untilMs > now ? cityRef(ctx.cities, loc.travel.cityId, ctx.locale) : undefined;
  return {
    id: ctx.publicUid,
    status: accountStatus.name(view.status) as Me['status'],
    onboardingStep: view.onboardingStep,
    ...(ctx.store ? { store: ctx.store } : {}),
    billingRef: ctx.billingRef,
    ...(view.profile ? { profile: ownProfileOf(view, ctx) } : {}),
    ...(preferences ? { preferences } : {}),
    ...(loc
      ? {
          location: {
            ...(homeCity ? { city: homeCity } : {}),
            country: loc.country,
            ...(travelCity && loc.travel ? { travel: { city: travelCity, until: wireTime(loc.travel.untilMs) } } : {}),
          },
        }
      : {}),
    notifications: notificationsOf(view.notifyFlags),
    flags: featureFlagsOf(view, userId, ctx),
    moderation: view.moderation.map(moderationActionOf).filter((a): a is ModerationAction => a !== undefined),
    consentsDue: consentsDueOf(view, ctx.cfg),
  };
}

/** The ETag of `GET /v1/me`: the account version, the configuration and what the session adds. */
export function meEtag(version: number, ctx: Pick<MeContext, 'cfg' | 'store' | 'versionCode' | 'locale'>): string {
  return `"m${version}-${ctx.cfg.fingerprint}-${ctx.store ?? 'x'}-${ctx.versionCode ?? 0}-${ctx.locale}"`;
}
