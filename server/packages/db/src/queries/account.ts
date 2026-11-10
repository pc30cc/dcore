import { z } from 'zod';
import { maybeOne, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The own-account view behind `GET /v1/me` on a cache miss: one statement,
 * `account_view(uid)` (migration 0010). Codes stay codes and times are epoch
 * milliseconds; the API maps them to the wire shape.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.number().int().nonnegative();

const photo = z.object({
  id,
  position: z.number().int().min(0).max(8),
  status: z.number().int().min(1).max(4),
  rejectReason: z.number().int().optional(),
  w: z.number().int().optional(),
  h: z.number().int().optional(),
  blurhash: z.string().optional(),
  blobVer: z.number().int().positive(),
});

const prompt = z.object({
  position: z.number().int().min(0).max(2),
  promptId: z.number().int(),
  answer: z.string().optional(),
  audioMs: z.number().int().optional(),
  status: z.number().int().min(1).max(3),
});

const field = z.object({
  fieldId: z.number().int(),
  option: z.number().int().optional(),
  options: z.array(z.number().int()).optional(),
  number: z.number().optional(),
  text: z.string().optional(),
});

const action = z.object({
  id,
  kind: z.number().int(),
  reasonText: z.string(),
  startsAtMs: epochMs,
  endsAtMs: epochMs.optional(),
  appeal: z.object({ id, status: z.number().int().min(1).max(3), decisionText: z.string().optional() }).optional(),
});

/** What `account_view()` returns for an account that is not deleted. */
export const accountViewSchema = z.object({
  status: z.number().int().min(1).max(6),
  onboardingStep: z.number().int(),
  flags: z.number().int(),
  locale: z.string(),
  country: z.string().optional(),
  birthDate: z.string().optional(),
  gender: z.number().int().optional(),
  verified: z.boolean(),
  notifyFlags: z.number().int(),
  profile: z
    .object({
      v: z.number().int(),
      name: z.string(),
      about: z.string().optional(),
      job: z.string().optional(),
      intention: z.number().int().optional(),
      textState: z.number().int(),
      completeness: z.number().int(),
      modeMatch: z.boolean(),
      modeSocial: z.boolean(),
      incognito: z.boolean(),
      hideAge: z.boolean(),
      hideDistance: z.boolean(),
      showOnline: z.boolean(),
      acceptCalls: z.boolean(),
      /** profiles.ui_template (0025); absent in a view cached before it. */
      uiTemplate: z.number().int().optional(),
    })
    .optional(),
  photos: z.array(photo),
  prompts: z.array(prompt),
  fields: z.array(field),
  preferences: z
    .object({
      interestedIn: z.number().int(),
      ageMin: z.number().int(),
      ageMax: z.number().int(),
      maxDistanceKm: z.number().int(),
      intents: z.number().int(),
      flags: z.number().int(),
      filters: z.record(z.string(), z.unknown()),
    })
    .optional(),
  location: z
    .object({
      cityId: z.number().int().optional(),
      country: z.string(),
      source: z.number().int(),
      travel: z.object({ cityId: z.number().int().optional(), country: z.string(), untilMs: epochMs }).optional(),
    })
    .optional(),
  moderation: z.array(action),
  /** Consent kind code (as a string key) to the newest accepted version. */
  consents: z.record(z.string().regex(/^[0-9]+$/), z.number().int().positive()),
  /** Legal consent kind codes (1 terms, 2 privacy, 3 guidelines) due again. */
  consentsDue: z.array(z.number().int()),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export const deletedAccountViewSchema = z.object({ status: z.literal(7), deletedAtMs: epochMs, purgeAtMs: epochMs });
export const purgedAccountViewSchema = z.object({ status: z.literal(8) });

export type AccountViewResult =
  | { kind: 'account'; view: AccountView }
  | { kind: 'deleted'; deletedAtMs: number; purgeAtMs: number }
  | { kind: 'purged' }
  | { kind: 'missing' };

export const accountView = defineQuery({ name: 'account.view', statements: 1 }, async (db, userId: string): Promise<AccountViewResult> => {
  const row = await maybeOne<{ view: unknown }>(db, sql`SELECT account_view(${userId}::bigint) AS view`);
  const view = row?.view;
  if (view === null || view === undefined) return { kind: 'missing' };
  const status = (view as { status?: unknown }).status;
  if (status === 8) return { kind: 'purged' };
  if (status === 7) {
    const deleted = deletedAccountViewSchema.parse(view);
    return { kind: 'deleted', deletedAtMs: deleted.deletedAtMs, purgeAtMs: deleted.purgeAtMs };
  }
  return { kind: 'account', view: accountViewSchema.parse(view) };
});
