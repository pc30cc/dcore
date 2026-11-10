import { z } from 'zod';
import { many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The own-account writes: basics, profile, preferences, settings, push
 * switches and consents. Each request path is one statement (several
 * tables at once through data-modifying CTEs) plus, where the route answers
 * with the profile, the `account_view()` read in the same transaction. The
 * card version and discovery follow through the 0006 triggers.
 *
 * Codes are passed as smallints and bitmasks; the API validates every value
 * against the catalogue in memory before it gets here.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

// ─── Basics ───────────────────────────────────────────────────────────────

export interface ConsentInput {
  kind: number;
  version: number;
}

/**
 * Birth date and gender, once, while the account is in onboarding, with the
 * consents of the texts shown. Null when the basics were already set (or
 * the account is not in onboarding).
 */
export const setBasics = defineQuery(
  { name: 'me.setBasics', statements: 1 },
  async (db, userId: string, birthDate: string, genderCode: number, consents: readonly ConsentInput[], store: number | null) => {
    const row = await one<{ id: string | null }>(
      db,
      sql`
WITH u AS (
  UPDATE users SET birth_date = ${birthDate}::date, gender = ${genderCode}::smallint
   WHERE id = ${userId}::bigint AND status = 1 AND birth_date IS NULL
  RETURNING id
), c AS (
  INSERT INTO user_consents AS uc (user_id, kind, version, store)
  SELECT u.id, k.kind, k.version, ${store}::smallint
    FROM u, unnest(${consents.map((c) => c.kind)}::smallint[], ${consents.map((c) => c.version)}::smallint[]) AS k(kind, version)
  ON CONFLICT (user_id, kind, version) DO UPDATE
     SET accepted_at = now(), withdrawn_at = NULL, store = EXCLUDED.store
   WHERE uc.withdrawn_at IS NOT NULL
)
SELECT (SELECT u.id::text FROM u) AS id`,
    );
    return row.id !== null;
  },
);

/**
 * After an under-age refusal (the account is a tombstone, status 8): the
 * answers given during sign-up are deleted too (name, texts, prompts,
 * fields, preferences, location), so nothing a minor wrote is kept.
 * Consent records stay as the proof of what was shown.
 */
export const clearSignUpAnswers = defineQuery({ name: 'me.clearSignUpAnswers', statements: 1 }, async (db, userId: string) => {
  await one(
    db,
    sql`
WITH u AS (
  SELECT id FROM users WHERE id = ${userId}::bigint AND status = 8
), fields_gone AS (
  DELETE FROM profile_field_values v USING u WHERE v.user_id = u.id
), prompts_gone AS (
  DELETE FROM profile_prompts p USING u WHERE p.user_id = u.id
), preferences_gone AS (
  DELETE FROM preferences p USING u WHERE p.user_id = u.id
), location_gone AS (
  DELETE FROM user_locations l USING u WHERE l.user_id = u.id
), profile_gone AS (
  DELETE FROM profiles p USING u WHERE p.user_id = u.id
)
SELECT EXISTS (SELECT 1 FROM u) AS tombstone`,
  );
});

// ─── Profile ──────────────────────────────────────────────────────────────

/** A value to set (`set: true`) or to leave as it is. */
export type Change<T> = { set: true; value: T } | { set: false };
const keep = { set: false } as const;

export interface ProfileWrite {
  /** Creates the profile when it does not exist yet (needs the name). */
  displayName?: string | undefined;
  about: Change<string | null>;
  jobTitle: Change<string | null>;
  intention: Change<number | null>;
  modeMatch?: boolean | undefined;
  /** When about or the job title changed: the moderation state of the texts. */
  textState?: number | undefined;
  onboardingStep?: number | undefined;
  fields?: { remove: number[]; set: { fieldId: number; num: number | null; opt: number | null; opts: number[] | null; txt: string | null }[] } | undefined;
  prompts?: { remove: number[]; set: { position: number; promptId: number; answer: string; status: number }[] } | undefined;
}

export function noChange<T>(): Change<T> {
  return keep;
}

/**
 * One statement for every part of a profile edit: the profile row (inserted
 * with the first name), field values, prompts and the onboarding step.
 * Returns whether the profile row exists afterwards.
 */
export const writeProfile = defineQuery({ name: 'me.writeProfile', statements: 1 }, async (db, userId: string, w: ProfileWrite) => {
  const parts: SqlFragment[] = [];
  const touchesProfile =
    w.displayName !== undefined || w.about.set || w.jobTitle.set || w.intention.set || w.modeMatch !== undefined || w.textState !== undefined;
  if (touchesProfile) {
    const about = w.about.set ? w.about.value : null;
    const job = w.jobTitle.set ? w.jobTitle.value : null;
    const intent = w.intention.set ? w.intention.value : null;
    parts.push(sql`profile AS (
  -- The proposed row needs a name even when it only updates (NOT NULL is checked before the conflict).
  INSERT INTO profiles AS p (user_id, display_name, about, job_title, intention, mode_match, text_state)
  SELECT ${userId}::bigint, n.name, ${about}::text, ${job}::text, ${intent}::smallint,
         coalesce(${w.modeMatch ?? null}::boolean, true), coalesce(${w.textState ?? null}::smallint, 1)
    FROM (SELECT coalesce(${w.displayName ?? null}::text,
                          (SELECT x.display_name FROM profiles x WHERE x.user_id = ${userId}::bigint)) AS name) n
   WHERE n.name IS NOT NULL
  ON CONFLICT (user_id) DO UPDATE SET
     display_name = coalesce(${w.displayName ?? null}::text, p.display_name),
     about = CASE WHEN ${w.about.set} THEN ${about}::text ELSE p.about END,
     job_title = CASE WHEN ${w.jobTitle.set} THEN ${job}::text ELSE p.job_title END,
     intention = CASE WHEN ${w.intention.set} THEN ${intent}::smallint ELSE p.intention END,
     mode_match = coalesce(${w.modeMatch ?? null}::boolean, p.mode_match),
     text_state = coalesce(${w.textState ?? null}::smallint, p.text_state)
   WHERE (p.display_name, p.about, p.job_title, p.intention, p.mode_match, p.text_state)
         IS DISTINCT FROM
         (coalesce(${w.displayName ?? null}::text, p.display_name),
          CASE WHEN ${w.about.set} THEN ${about}::text ELSE p.about END,
          CASE WHEN ${w.jobTitle.set} THEN ${job}::text ELSE p.job_title END,
          CASE WHEN ${w.intention.set} THEN ${intent}::smallint ELSE p.intention END,
          coalesce(${w.modeMatch ?? null}::boolean, p.mode_match),
          coalesce(${w.textState ?? null}::smallint, p.text_state))
  RETURNING p.user_id
)`);
  }
  if (w.onboardingStep !== undefined) {
    parts.push(sql`step AS (
  UPDATE users SET onboarding_step = ${w.onboardingStep}::smallint
   WHERE id = ${userId}::bigint AND status = 1 AND onboarding_step < ${w.onboardingStep}::smallint
)`);
  }
  if (w.fields && w.fields.remove.length > 0) {
    parts.push(sql`fields_removed AS (
  DELETE FROM profile_field_values WHERE user_id = ${userId}::bigint AND field_id = ANY(${w.fields.remove}::smallint[])
)`);
  }
  if (w.fields && w.fields.set.length > 0) {
    const rows = w.fields.set;
    parts.push(sql`fields_set AS (
  INSERT INTO profile_field_values AS v (user_id, field_id, num, opt, opts, txt)
  SELECT ${userId}::bigint, x.f, x.n, x.o, CASE WHEN x.os IS NULL THEN NULL ELSE x.os::smallint[] END, x.t
    FROM unnest(${rows.map((r) => r.fieldId)}::smallint[], ${rows.map((r) => r.num)}::integer[], ${rows.map((r) => r.opt)}::smallint[],
                ${rows.map((r) => (r.opts === null ? null : `{${r.opts.join(',')}}`))}::text[], ${rows.map((r) => r.txt)}::text[]) AS x(f, n, o, os, t)
  ON CONFLICT (user_id, field_id) DO UPDATE SET num = EXCLUDED.num, opt = EXCLUDED.opt, opts = EXCLUDED.opts, txt = EXCLUDED.txt
   WHERE (v.num, v.opt, v.opts, v.txt) IS DISTINCT FROM (EXCLUDED.num, EXCLUDED.opt, EXCLUDED.opts, EXCLUDED.txt)
)`);
  }
  if (w.prompts && (w.prompts.remove.length > 0 || w.prompts.set.length > 0)) {
    const rows = w.prompts.set;
    // The rows at the edited positions, and any row holding a prompt that moves, go first; the
    // aggregate over that delete makes the insert wait for it (a prompt is used once per person).
    parts.push(sql`prompts_removed AS (
  DELETE FROM profile_prompts
   WHERE user_id = ${userId}::bigint
     AND (position = ANY(${[...w.prompts.remove, ...rows.map((r) => r.position)]}::smallint[])
          OR prompt_id = ANY(${rows.map((r) => r.promptId)}::smallint[]))
  RETURNING position
)`);
    if (rows.length > 0) {
      parts.push(sql`prompts_set AS (
  INSERT INTO profile_prompts (user_id, position, prompt_id, status, answer)
  SELECT ${userId}::bigint, x.pos, x.pid, x.st, x.a
    FROM unnest(${rows.map((r) => r.position)}::smallint[], ${rows.map((r) => r.promptId)}::smallint[],
                ${rows.map((r) => r.status)}::smallint[], ${rows.map((r) => r.answer)}::text[]) AS x(pos, pid, st, a)
   CROSS JOIN (SELECT coalesce(max(d.position), 0) AS after_delete FROM prompts_removed d) AS ordered
)`);
    }
  }
  if (parts.length === 0) return { profile: null as boolean | null };
  const withs = parts.reduce((acc, part, index) => (index === 0 ? sql`WITH ${part}` : sql`${acc}, ${part}`), sql``);
  const row = await one<{ profile: boolean }>(
    db,
    sql`${withs}
SELECT EXISTS (SELECT 1 FROM profiles x WHERE x.user_id = ${userId}::bigint)${touchesProfile ? sql` OR EXISTS (SELECT 1 FROM profile)` : sql``} AS profile`,
  );
  return { profile: row.profile };
});

/** After an edit: the stored completeness, and the move out of onboarding when the edit finished it. */
export const afterProfileWrite = defineQuery(
  { name: 'me.afterProfileWrite', statements: 1 },
  async (db, userId: string, completeness: number | null, finish: { status: number; step: number } | null) => {
    const parts: SqlFragment[] = [];
    if (completeness !== null) {
      parts.push(sql`c AS (
  UPDATE profiles SET completeness = ${completeness}::smallint
   WHERE user_id = ${userId}::bigint AND completeness <> ${completeness}::smallint
)`);
    }
    if (finish) {
      parts.push(sql`f AS (
  UPDATE users SET status = ${finish.status}::smallint, onboarding_step = greatest(onboarding_step, ${finish.step}::smallint)
   WHERE id = ${userId}::bigint AND status = 1
  RETURNING status
)`);
    }
    if (parts.length === 0) return { finished: false };
    const withs = parts.reduce((acc, part, index) => (index === 0 ? sql`WITH ${part}` : sql`${acc}, ${part}`), sql``);
    const row = await one<{ finished: boolean }>(db, sql`${withs} SELECT ${finish ? sql`EXISTS (SELECT 1 FROM f)` : sql`false`} AS finished`);
    return row;
  },
);

// ─── Preferences ──────────────────────────────────────────────────────────

export interface PreferencesWrite {
  interestedIn?: number | undefined;
  ageMin?: number | undefined;
  ageMax?: number | undefined;
  maxDistanceKm?: number | undefined;
  intents?: number | undefined;
  /** Bits to clear, then bits to set (whole country, verified only). */
  flagsClear: number;
  flagsSet: number;
  filters?: Record<string, number[]> | undefined;
}

export const preferencesRowSchema = z.object({
  interested_in: z.number().int(),
  age_min: z.number().int(),
  age_max: z.number().int(),
  max_distance_km: z.number().int(),
  intents: z.number().int(),
  flags: z.number().int(),
  filters: z.record(z.string(), z.unknown()),
});
export type PreferencesRow = z.infer<typeof preferencesRowSchema>;

/** Upserts the preferences (the first write needs interestedIn) and returns the row as it is afterwards. */
export const writePreferences = defineQuery({ name: 'me.writePreferences', statements: 1 }, async (db, userId: string, w: PreferencesWrite) => {
  const filters = w.filters === undefined ? null : JSON.stringify(w.filters);
  const row = await maybeOne<{ row: unknown }>(
    db,
    sql`
WITH cur AS (
  SELECT * FROM preferences WHERE user_id = ${userId}::bigint
), next AS (
  SELECT coalesce(${w.interestedIn ?? null}::smallint, cur.interested_in) AS interested_in,
         coalesce(${w.ageMin ?? null}::smallint, cur.age_min, 18::smallint) AS age_min,
         coalesce(${w.ageMax ?? null}::smallint, cur.age_max, 99::smallint) AS age_max,
         coalesce(${w.maxDistanceKm ?? null}::smallint, cur.max_distance_km, 50::smallint) AS max_distance_km,
         coalesce(${w.intents ?? null}::smallint, cur.intents, 0::smallint) AS intents,
         ((coalesce(cur.flags, 0::smallint) & ~${w.flagsClear}::smallint) | ${w.flagsSet}::smallint)::smallint AS flags,
         coalesce(${filters}::jsonb, cur.filters, '{}'::jsonb) AS filters
    FROM (SELECT 1) one LEFT JOIN cur ON true
), up AS (
  INSERT INTO preferences AS p (user_id, interested_in, age_min, age_max, max_distance_km, intents, flags, filters)
  SELECT ${userId}::bigint, n.interested_in, n.age_min, n.age_max, n.max_distance_km, n.intents, n.flags, n.filters
    FROM next n WHERE n.interested_in IS NOT NULL
  ON CONFLICT (user_id) DO UPDATE SET
     interested_in = EXCLUDED.interested_in, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
     max_distance_km = EXCLUDED.max_distance_km, intents = EXCLUDED.intents, flags = EXCLUDED.flags,
     filters = EXCLUDED.filters, updated_at = now()
   WHERE (p.interested_in, p.age_min, p.age_max, p.max_distance_km, p.intents, p.flags, p.filters)
         IS DISTINCT FROM
         (EXCLUDED.interested_in, EXCLUDED.age_min, EXCLUDED.age_max, EXCLUDED.max_distance_km, EXCLUDED.intents,
          EXCLUDED.flags, EXCLUDED.filters)
  RETURNING p.user_id
)
SELECT to_jsonb(n.*) AS row, EXISTS (SELECT 1 FROM up) AS written FROM next n WHERE n.interested_in IS NOT NULL`,
  );
  return row ? preferencesRowSchema.parse(row.row) : null;
});

// ─── Settings ─────────────────────────────────────────────────────────────

export interface SettingsWrite {
  incognito?: boolean | undefined;
  hideAge?: boolean | undefined;
  hideDistance?: boolean | undefined;
  showOnline?: boolean | undefined;
  acceptCalls?: boolean | undefined;
  modeMatch?: boolean | undefined;
  /** profiles.ui_template code (uiTemplateChoice). */
  uiTemplate?: number | undefined;
  /** true: active → snoozed, false: snoozed → active. */
  snooze?: boolean | undefined;
}

export const settingsRowSchema = z.object({
  incognito: z.boolean(),
  hide_age: z.boolean(),
  hide_distance: z.boolean(),
  show_online: z.boolean(),
  accept_calls: z.boolean(),
  mode_match: z.boolean(),
  ui_template: z.number().int(),
  status: z.number().int(),
  matches: z.array(id),
  /** Whether anything was written (the profile row or the status). */
  written: z.boolean(),
  /** Whether the card's version moved (profiles_touch: a switch the card shows). */
  card: z.boolean(),
});

/**
 * The privacy switches, the template choice, the snooze (users.status 3 ↔ 4) and, when
 * accept_calls changes, the person's call bit in every active match (call
 * placement reads only the match flags). Returns the settings as they are
 * afterwards, the matches whose flags changed, whether anything was written
 * and whether the card's version moved.
 */
export const writeSettings = defineQuery({ name: 'me.writeSettings', statements: 1 }, async (db, userId: string, w: SettingsWrite) => {
  const v = (value: boolean | undefined) => value ?? null;
  const row = await maybeOne<z.input<typeof settingsRowSchema>>(
    db,
    sql`
WITH cur AS (
  SELECT p.incognito, p.hide_age, p.hide_distance, p.show_online, p.accept_calls, p.mode_match, p.ui_template, p.version
    FROM profiles p WHERE p.user_id = ${userId}::bigint
), next AS (
  SELECT coalesce(${v(w.incognito)}::boolean, c.incognito) AS incognito,
         coalesce(${v(w.hideAge)}::boolean, c.hide_age) AS hide_age,
         coalesce(${v(w.hideDistance)}::boolean, c.hide_distance) AS hide_distance,
         coalesce(${v(w.showOnline)}::boolean, c.show_online) AS show_online,
         coalesce(${v(w.acceptCalls)}::boolean, c.accept_calls) AS accept_calls,
         coalesce(${v(w.modeMatch)}::boolean, c.mode_match) AS mode_match,
         coalesce(${w.uiTemplate ?? null}::smallint, c.ui_template) AS ui_template,
         c.accept_calls AS calls_before
    FROM cur c
), p AS (
  UPDATE profiles x SET incognito = n.incognito, hide_age = n.hide_age, hide_distance = n.hide_distance,
                        show_online = n.show_online, accept_calls = n.accept_calls, mode_match = n.mode_match,
                        ui_template = n.ui_template
    FROM next n
   WHERE x.user_id = ${userId}::bigint
     AND (x.incognito, x.hide_age, x.hide_distance, x.show_online, x.accept_calls, x.mode_match, x.ui_template)
         IS DISTINCT FROM (n.incognito, n.hide_age, n.hide_distance, n.show_online, n.accept_calls, n.mode_match, n.ui_template)
  RETURNING x.version
), u AS (
  UPDATE users SET status = CASE WHEN ${v(w.snooze)}::boolean THEN 4 ELSE 3 END
   WHERE id = ${userId}::bigint AND ${v(w.snooze)}::boolean IS NOT NULL
     AND status = CASE WHEN ${v(w.snooze)}::boolean THEN 3 ELSE 4 END
  RETURNING status
), m AS (
  UPDATE matches SET flags = CASE WHEN n.accept_calls
                                  THEN flags | CASE WHEN user_lo = ${userId}::bigint THEN 1 ELSE 2 END
                                  ELSE flags & ~CASE WHEN user_lo = ${userId}::bigint THEN 1 ELSE 2 END END
    FROM next n
   WHERE n.accept_calls IS DISTINCT FROM n.calls_before
     AND matches.state = 1
     AND (matches.user_lo = ${userId}::bigint OR matches.user_hi = ${userId}::bigint)
  RETURNING matches.id
)
SELECT n.incognito, n.hide_age, n.hide_distance, n.show_online, n.accept_calls, n.mode_match, n.ui_template,
       coalesce((SELECT u.status FROM u), (SELECT s.status FROM users s WHERE s.id = ${userId}::bigint)) AS status,
       coalesce((SELECT array_agg(m.id::text) FROM m), '{}') AS matches,
       EXISTS (SELECT 1 FROM p) OR EXISTS (SELECT 1 FROM u) AS written,
       coalesce((SELECT p.version FROM p) <> (SELECT c.version FROM cur c), false) AS card
  FROM next n`,
  );
  return row ? settingsRowSchema.parse(row) : null;
});

// ─── Push switches ────────────────────────────────────────────────────────

/** Clears then sets bits of users.notify_flags; writes only when the value changes. Returns the value afterwards. */
export const writeNotifyFlags = defineQuery({ name: 'me.writeNotifyFlags', statements: 1 }, async (db, userId: string, clear: number, set: number) => {
  const row = await maybeOne<{ flags: number }>(
    db,
    sql`
WITH cur AS (
  SELECT ((notify_flags & ~${clear}::smallint) | ${set}::smallint)::smallint AS next, notify_flags AS before
    FROM users WHERE id = ${userId}::bigint
), up AS (
  UPDATE users u SET notify_flags = c.next FROM cur c WHERE u.id = ${userId}::bigint AND c.next <> c.before
)
SELECT next AS flags FROM cur`,
  );
  return row?.flags ?? null;
});

// ─── Consents ─────────────────────────────────────────────────────────────

export const consentRowSchema = z.object({
  kind: z.number().int(),
  version: z.number().int(),
  acceptedAtMs: z.number().int(),
  withdrawnAtMs: z.number().int().nullable(),
});
export type ConsentRow = z.infer<typeof consentRowSchema>;

const consentColumns = sql`kind, version, floor(extract(epoch FROM accepted_at) * 1000)::bigint AS "acceptedAtMs",
       floor(extract(epoch FROM withdrawn_at) * 1000)::bigint AS "withdrawnAtMs"`;

function parseConsents(rows: unknown[]): ConsentRow[] {
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>;
      return consentRowSchema.parse({
        kind: r['kind'],
        version: r['version'],
        acceptedAtMs: Number(r['acceptedAtMs']),
        withdrawnAtMs: r['withdrawnAtMs'] === null ? null : Number(r['withdrawnAtMs']),
      });
    })
    .sort((a, b) => a.kind - b.kind || a.version - b.version);
}

export const listConsents = defineQuery({ name: 'me.listConsents', statements: 1 }, async (db, userId: string) =>
  parseConsents(await many(db, sql`SELECT ${consentColumns} FROM user_consents WHERE user_id = ${userId}::bigint ORDER BY kind, version`)),
);

/** Accepts a version (again, after a withdrawal); returns every consent row afterwards. */
export const acceptConsent = defineQuery(
  { name: 'me.acceptConsent', statements: 1 },
  async (db, userId: string, kind: number, version: number, store: number | null) =>
    parseConsents(
      await many(
        db,
        sql`
WITH w AS (
  INSERT INTO user_consents AS c (user_id, kind, version, store)
  VALUES (${userId}::bigint, ${kind}::smallint, ${version}::smallint, ${store}::smallint)
  ON CONFLICT (user_id, kind, version) DO UPDATE SET accepted_at = now(), withdrawn_at = NULL, store = EXCLUDED.store
   WHERE c.withdrawn_at IS NOT NULL
  RETURNING c.kind, c.version, c.accepted_at, c.withdrawn_at
)
SELECT ${consentColumns} FROM user_consents
 WHERE user_id = ${userId}::bigint AND NOT (kind = ${kind}::smallint AND version = ${version}::smallint)
UNION ALL
SELECT ${consentColumns} FROM w
UNION ALL
SELECT ${consentColumns} FROM user_consents
 WHERE user_id = ${userId}::bigint AND kind = ${kind}::smallint AND version = ${version}::smallint AND NOT EXISTS (SELECT 1 FROM w)`,
      ),
    ),
);

/**
 * Withdraws every accepted version of a kind (the rows stay, with
 * withdrawn_at); withdrawing the sensitive-fields consent (kind 4) deletes
 * the person's values of sensitive fields in the same statement.
 */
export const withdrawConsent = defineQuery(
  { name: 'me.withdrawConsent', statements: 1 },
  async (db, userId: string, kind: number, sensitiveKind: number) =>
    parseConsents(
      await many(
        db,
        sql`
WITH w AS (
  UPDATE user_consents SET withdrawn_at = now()
   WHERE user_id = ${userId}::bigint AND kind = ${kind}::smallint AND withdrawn_at IS NULL
  RETURNING kind, version, accepted_at, withdrawn_at
), sensitive_gone AS (
  DELETE FROM profile_field_values v USING profile_field_defs f
   WHERE ${kind}::smallint = ${sensitiveKind}::smallint AND v.user_id = ${userId}::bigint AND f.id = v.field_id AND f.is_sensitive
)
SELECT ${consentColumns} FROM user_consents u
 WHERE u.user_id = ${userId}::bigint AND NOT EXISTS (SELECT 1 FROM w WHERE w.kind = u.kind AND w.version = u.version)
UNION ALL
SELECT ${consentColumns} FROM w`,
      ),
    ),
);

// ─── Plan of a session (until entitlements are cached) ───────────────────

/**
 * The plans an account holds now, for a session of `store` (its own
 * store's row and the admin grants, store 0; every row when cross-store
 * entitlements are on). The caller picks the best by rank.
 */
export const currentPlans = defineQuery(
  { name: 'me.currentPlans', statements: 1 },
  async (db, userId: string, store: number | null, crossStore: boolean) =>
    (
      await many<{ plan_id: number }>(
        db,
        sql`SELECT plan_id FROM subscriptions
             WHERE user_id = ${userId}::bigint AND expires_at > now()
               AND (${crossStore}::boolean OR store = 0 OR store = ${store}::smallint)`,
      )
    ).map((r) => r.plan_id),
);
