import {
  acceptConsent,
  afterProfileWrite,
  clearSignUpAnswers,
  listConsents,
  noChange,
  setBasics,
  withTransaction,
  withdrawConsent,
  writeNotifyFlags,
  writePreferences,
  writeProfile,
  writeSettings,
  type AccountView,
  type ProfileWrite,
} from '@app/db';
import {
  accountStatus,
  basicsRequestSchema,
  codesToMask,
  consentKind,
  consentListSchema,
  consentParamsSchema,
  consentUpdateSchema,
  gender,
  idTime,
  intention,
  meSchema,
  notificationPrefsPatchSchema,
  notificationPrefsSchema,
  notifyFlags,
  ownProfileSchema,
  photoStatus,
  preferenceFlags,
  preferencesPatchSchema,
  preferencesSchema,
  profilePatchSchema,
  settingsPatchSchema,
  settingsSchema,
  textState,
  uiTemplateChoice,
  wireTime,
  type FieldIssue,
  type LegalConsentKind,
  type ProfilePatch,
} from '@app/shared';
import { dropMatchState, utcDay } from '@app/shared/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { refuseUnderAge } from '../auth/underAge.js';
import { dbErrorInfo, scrubbed, withoutRowData } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { PHOTOS_MIN, type ConfigSnapshot, type FieldDefinition } from '../services/cfg.js';
import { planHasFeature } from '../services/entitlements.js';
import {
  ageOn,
  completenessOf,
  consentsDueOf,
  meEtag,
  meOf,
  notificationsOf,
  ownProfileOf,
  preferencesOf,
  settingsOf,
  type MeContext,
} from '../services/me.js';
import { requireScope, sessionOf, unauthorized, type AppSession } from '../services/session.js';

/**
 * `GET /v1/me` and the own-account edits: basics, profile,
 * preferences, settings, push switches and consents.
 *
 * `GET /v1/me` reads the cached view (`mev:<uid>` → `me:<uid>:<mev>:s<shape>`): no
 * statement when warm, one (`account_view()`) on a miss, and a 304 decided
 * from the version alone. Every edit bumps the version after its
 * transaction commits; edits that answer with the profile build the fresh
 * view inside their transaction and store it under the new version, so the
 * next read is warm again.
 */

/** A sign-up finishes with this step (`onboardingStep` 30 and above). */
export const ONBOARDING_DONE = 30;
const SENSITIVE_CONSENT = consentKind.code('sensitive_fields');
/** Radius changes are how distances are probed: at most this many a day. */
export const RADIUS_CHANGES_PER_DAY = 10;

export function meContextOf(app: FastifyInstance, request: FastifyRequest, session: AppSession): MeContext {
  return {
    publicUid: session.publicUid,
    billingRef: app.publicIds.billing.encode(session.userId),
    store: session.store,
    versionCode: request.client?.versionCode,
    locale: request.locale,
    cfg: app.cfg.get(),
    cities: app.cities,
    photoUrl: app.ownPhotoUrl,
  };
}

function ifNoneMatch(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  return typeof header === 'string' && header.split(',').some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`);
}

/** A 304, outside the route's typed response schemas. */
export function notModified(reply: unknown): FastifyReply {
  return (reply as FastifyReply).code(304).send();
}

function fieldInvalid(detail: string, pointer: string, code = 'invalid'): HttpProblem {
  const errors: FieldIssue[] = [{ in: 'body', pointer, code, message: detail }];
  return new HttpProblem('field_invalid', { detail, errors });
}

/** The account as the route needs it; 401 when it is gone (purged or unknown). */
function accountOf(result: { kind: string; view?: AccountView }): AccountView {
  if (result.kind !== 'account' || !result.view) throw unauthorized();
  return result.view;
}

/** Turns constraint failures of a write into 422s; anything else is a server error (without row data). */
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const info = dbErrorInfo(error);
    if (info?.code === '23514' || info?.code === '23502') {
      throw new HttpProblem('field_invalid', { detail: `The values break a rule${info.constraint ? ` (${info.constraint})` : ''}.` });
    }
    throw withoutRowData(error);
  }
}

// ─── Validation of profile edits against the catalogue in memory ─────────

type FieldEdit = NonNullable<ProfilePatch['fields']>[number];

function fieldValue(def: FieldDefinition, edit: FieldEdit, index: number, consented: boolean) {
  const pointer = `/fields/${index}`;
  const given = [edit.option !== undefined, edit.options !== undefined, edit.number !== undefined, edit.text !== undefined && edit.text !== null].filter(Boolean).length;
  if (given === 0) return null;
  if (given > 1) throw fieldInvalid('A field takes one value.', pointer);
  if (def.sensitive && !consented) throw fieldInvalid('This field needs the sensitive_fields consent first.', pointer, 'consent');
  const active = new Set(def.options.filter((o) => o.active).map((o) => o.id));
  switch (def.kind) {
    case 'single':
      if (edit.option === undefined || !active.has(edit.option)) throw fieldInvalid('Not an option of this field.', `${pointer}/option`);
      return { fieldId: def.id, num: null, opt: edit.option, opts: null, txt: null };
    case 'multi': {
      const options = edit.options;
      if (!options || options.length === 0) throw fieldInvalid('Choose at least one option.', `${pointer}/options`);
      if (new Set(options).size !== options.length || !options.every((o) => active.has(o))) throw fieldInvalid('Not options of this field.', `${pointer}/options`);
      if (def.maxChoices !== null && options.length > def.maxChoices) throw fieldInvalid(`At most ${def.maxChoices} options.`, `${pointer}/options`);
      return { fieldId: def.id, num: null, opt: null, opts: [...options].sort((a, b) => a - b), txt: null };
    }
    case 'number':
      if (edit.number === undefined) throw fieldInvalid('This field takes a number.', `${pointer}/number`);
      return { fieldId: def.id, num: edit.number, opt: null, opts: null, txt: null };
    case 'country': {
      const code = edit.text?.trim().toUpperCase();
      if (!code || !/^[A-Z]{2}$/.test(code)) throw fieldInvalid('This field takes a country code.', `${pointer}/text`);
      return { fieldId: def.id, num: null, opt: null, opts: null, txt: code };
    }
    case 'text': {
      const text = edit.text?.trim();
      if (!text) throw fieldInvalid('This field takes a text.', `${pointer}/text`);
      return { fieldId: def.id, num: null, opt: null, opts: null, txt: text };
    }
  }
}

/** What still keeps a sign-up from finishing (empty: it may finish). */
function missingForSignUp(view: AccountView, cfg: ConfigSnapshot): FieldIssue[] {
  const missing: FieldIssue[] = [];
  const add = (code: string, message: string) => missing.push({ in: 'body', pointer: '/onboardingStep', code, message });
  if (!view.profile?.name) add('name', 'A name is needed.');
  if (!view.birthDate || view.gender === undefined) add('basics', 'Birth date and gender are needed.');
  if (!view.preferences) add('interested_in', 'Who to meet is needed.');
  const photos = view.photos.filter((p) => p.status !== photoStatus.code('rejected')).length;
  if (photos < PHOTOS_MIN) add('photos', `At least ${PHOTOS_MIN} photos are needed.`);
  if (!view.location) add('location', 'A location is needed.');
  const answered = new Set(view.fields.map((f) => f.fieldId));
  for (const field of cfg.fields) if (field.active && field.required && !answered.has(field.id)) add('fields', `The field ${field.key} must be answered.`);
  return missing;
}

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  const anyScope = requireScope(app, app.account, ['full', 'restricted', 'restore']);
  const restrictedOk = requireScope(app, app.account, ['full', 'restricted']);
  const fullOnly = requireScope(app, app.account, ['full']);

  // ─── GET /v1/me ─────────────────────────────────────────────────────────
  app.get(
    '/v1/me',
    {
      preHandler: anyScope,
      config: { pgBudget: 1 },
      schema: { tags: ['me'], summary: 'The signed-in account', response: { 200: meSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const ctx = meContextOf(app, request, session);
      const version = await app.account.version(session.userId);
      reply.header('cache-control', 'private, no-cache');
      if (version !== null) {
        const etag = meEtag(version, ctx);
        reply.header('etag', etag);
        if (ifNoneMatch(request, etag)) return notModified(reply);
      }
      const loaded = await scrubbed(() => app.account.view(session.userId, version));
      const me = meOf(loaded.result, session.userId, ctx);
      if (me === null) throw unauthorized();
      return me;
    },
  );

  // ─── PUT /v1/me/basics ──────────────────────────────────────────────────
  app.put(
    '/v1/me/basics',
    {
      preHandler: fullOnly,
      // Adult: the write and the fresh view (2). Under age: the refusal (4) and the sign-up answers (1).
      config: { pgBudget: 5 },
      schema: { tags: ['me'], summary: 'Birth date, gender and the accepted texts, once', body: basicsRequestSchema, response: { 200: ownProfileSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const ctx = meContextOf(app, request, session);
      const body = request.body;
      const versions = ctx.cfg.app['legal.versions'];
      const shown: Partial<Record<LegalConsentKind, number>> = { terms: body.consents.terms, privacy: body.consents.privacy };
      if (body.consents.guidelines !== undefined) shown.guidelines = body.consents.guidelines;
      for (const [kind, version] of Object.entries(shown) as [LegalConsentKind, number][]) {
        if (version > versions[kind]) throw fieldInvalid(`There is no version ${version} of the ${kind}.`, `/consents/${kind}`);
      }
      const old = (Object.entries(shown) as [LegalConsentKind, number][]).filter(([kind, version]) => version < versions[kind]).map(([kind]) => kind);
      if (old.length > 0) throw new HttpProblem('consent_required', { extensions: { kinds: old } });

      const birth = new Date(`${body.birthDate}T00:00:00Z`);
      if (Number.isNaN(birth.getTime()) || wireTime(birth).slice(0, 10) !== body.birthDate || body.birthDate < '1900-01-01') {
        throw fieldInvalid('Not a date.', '/birthDate');
      }
      if (birth.getTime() > Date.now()) throw fieldInvalid('A birth date is in the past.', '/birthDate');
      // The age at sign-up (the time the id carries), as the users_adult constraint checks it.
      if (ageOn(body.birthDate, idTime(session.userId)) < 18) {
        const closed = await scrubbed(() => refuseUnderAge(app, request));
        if (!closed) throw new HttpProblem('already_set', { detail: 'The birth date is already set.' });
        await scrubbed(() => clearSignUpAnswers(app.pg, session.userId)).catch((error: unknown) =>
          request.log.error({ err: error }, 'under-age refusal: sign-up answers not cleared'),
        );
        await app.account.changed(session.userId);
        throw new HttpProblem('under_age', { detail: 'Only adults can use this app.' });
      }

      const consents = (Object.entries(shown) as [LegalConsentKind, number][]).map(([kind, version]) => ({ kind: consentKind.code(kind), version }));
      // The version before the write: its view is stored only if no other change comes in between.
      const since = await app.account.version(session.userId);
      const fresh = await writing(() =>
        withTransaction(app.pg, async (tx) => {
          const set = await setBasics(tx, session.userId, body.birthDate, gender.code(body.gender), consents, session.storeCode ?? null);
          if (!set) throw new HttpProblem('already_set', { detail: 'The birth date and gender are already set.' });
          return app.account.build(tx, session.userId);
        }),
      );
      await app.account.changed(session.userId, { since, result: fresh });
      return ownProfileOf(accountOf(fresh), ctx);
    },
  );

  // ─── PATCH /v1/me/profile ───────────────────────────────────────────────
  app.patch(
    '/v1/me/profile',
    {
      preHandler: fullOnly,
      // A cold view (1), the edit (1), the fresh view (1), completeness and the end of sign-up (1).
      config: { pgBudget: 4 },
      schema: { tags: ['me'], summary: 'Edit the own profile', body: profilePatchSchema, response: { 200: ownProfileSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const ctx = meContextOf(app, request, session);
      const cfg = ctx.cfg;
      const body = request.body;
      const view = accountOf((await scrubbed(() => app.account.load(session.userId))).result);
      const current = view.profile;
      const terms = cfg.bannedTerms;

      if (body.displayName !== undefined && terms.severity(body.displayName, 'name') >= 2) {
        throw new HttpProblem('text_refused', { detail: 'This name cannot be used.' });
      }
      const about = body.about === undefined ? noChange<string | null>() : { set: true as const, value: body.about?.trim() || null };
      const job = body.jobTitle === undefined ? noChange<string | null>() : { set: true as const, value: body.jobTitle?.trim() || null };
      if (about.set && about.value !== null && terms.severity(about.value, 'about') >= 3) throw new HttpProblem('text_refused', { detail: 'This text cannot be used.' });
      if (job.set && job.value !== null && terms.severity(job.value, 'job') >= 3) throw new HttpProblem('text_refused', { detail: 'This job title cannot be used.' });
      const aboutChanged = about.set && about.value !== (current?.about ?? null);
      const jobChanged = job.set && job.value !== (current?.job ?? null);
      let textStateCode: number | undefined;
      if (aboutChanged || jobChanged) {
        const finalAbout = about.set ? about.value : (current?.about ?? null);
        const finalJob = job.set ? job.value : (current?.job ?? null);
        const flagged = Math.max(finalAbout ? terms.severity(finalAbout, 'about') : 0, finalJob ? terms.severity(finalJob, 'job') : 0) >= 2;
        // Flagged texts wait for a human; the others pass the automatic check.
        textStateCode = textState.code(flagged ? 'checking' : 'approved');
      }

      const write: ProfileWrite = {
        displayName: body.displayName,
        about,
        jobTitle: job,
        intention: body.intention === undefined ? noChange() : { set: true, value: body.intention === null ? null : intention.code(body.intention) },
        modeMatch: body.modeRomance,
        textState: textStateCode,
      };
      const needsProfile = write.about.set || write.jobTitle.set || write.intention.set || write.modeMatch !== undefined;
      if (!current && body.displayName === undefined && needsProfile) throw fieldInvalid('Set the name first.', '/displayName');

      const finishing = body.onboardingStep !== undefined && body.onboardingStep >= ONBOARDING_DONE;
      if (body.onboardingStep !== undefined && !finishing) write.onboardingStep = body.onboardingStep;

      if (body.fields) {
        const consented = (view.consents[String(SENSITIVE_CONSENT)] ?? 0) > 0;
        const seen = new Set<number>();
        const remove: number[] = [];
        const set: NonNullable<ProfileWrite['fields']>['set'] = [];
        body.fields.forEach((edit, index) => {
          const def = cfg.fieldsById.get(edit.fieldId);
          if (!def?.active) throw fieldInvalid('Unknown field.', `/fields/${index}/fieldId`);
          if (seen.has(def.id)) throw fieldInvalid('A field is edited once per request.', `/fields/${index}/fieldId`);
          seen.add(def.id);
          const value = fieldValue(def, edit, index, consented);
          if (value === null) remove.push(def.id);
          else set.push(value);
        });
        write.fields = { remove, set };
      }

      if (body.prompts) {
        const positions = new Set<number>();
        const prompts = new Set<number>();
        const remove: number[] = [];
        const set: NonNullable<ProfileWrite['prompts']>['set'] = [];
        body.prompts.forEach((edit, index) => {
          if (positions.has(edit.position)) throw fieldInvalid('A position is edited once per request.', `/prompts/${index}/position`);
          positions.add(edit.position);
          const existing = view.prompts.find((p) => p.position === edit.position);
          if (edit.answer === null) {
            if (existing) remove.push(edit.position);
            return;
          }
          const def = cfg.promptsById.get(edit.promptId);
          if (!def?.active) throw fieldInvalid('Unknown prompt.', `/prompts/${index}/promptId`);
          if (def.voice) throw fieldInvalid('This prompt is answered with a recording.', `/prompts/${index}/promptId`);
          if (prompts.has(edit.promptId)) throw fieldInvalid('A prompt is used once.', `/prompts/${index}/promptId`);
          prompts.add(edit.promptId);
          const answer = edit.answer.trim();
          if (!answer) throw fieldInvalid('An answer is needed.', `/prompts/${index}/answer`);
          const severity = terms.severity(answer, 'prompts');
          if (severity >= 3) throw new HttpProblem('text_refused', { detail: 'This answer cannot be used.' });
          if (existing?.promptId === edit.promptId && existing.answer === answer) return;
          set.push({ position: edit.position, promptId: edit.promptId, answer, status: textState.code(severity >= 2 ? 'checking' : 'approved') });
        });
        write.prompts = { remove, set };
      }

      // The version before the write: its view is stored only if no other change comes in between.
      const since = await app.account.version(session.userId);
      const fresh = await writing(() =>
        withTransaction(app.pg, async (tx) => {
          await writeProfile(tx, session.userId, write);
          const built = await app.account.build(tx, session.userId);
          const after = accountOf(built);
          const completeness = after.profile ? completenessOf(after, cfg) : null;
          const storeCompleteness = completeness !== null && completeness !== after.profile?.completeness ? completeness : null;
          let finish: { status: number; step: number } | null = null;
          if (finishing && after.status === accountStatus.code('onboarding')) {
            const due = consentsDueOf(after, cfg);
            if (due.length > 0) throw new HttpProblem('consent_required', { extensions: { kinds: due } });
            const missing = missingForSignUp(after, cfg);
            if (missing.length > 0) {
              throw new HttpProblem('field_invalid', { detail: `Sign-up is not complete: ${missing.map((m) => m.code).join(', ')}.`, errors: missing });
            }
            finish = { status: accountStatus.code(cfg.app['onboarding.waitlist'].enabled ? 'pending_review' : 'active'), step: body.onboardingStep ?? ONBOARDING_DONE };
          }
          const done = await afterProfileWrite(tx, session.userId, storeCompleteness, finish);
          // What the last statement changed, applied to the view it could not see.
          if (storeCompleteness !== null && after.profile) after.profile.completeness = storeCompleteness;
          if (finish && done.finished) {
            after.status = finish.status;
            after.onboardingStep = Math.max(after.onboardingStep, finish.step);
          }
          return built;
        }),
      );
      await app.account.changed(session.userId, { since, result: fresh });
      return ownProfileOf(accountOf(fresh), ctx);
    },
  );

  // ─── PATCH /v1/me/preferences ───────────────────────────────────────────
  app.patch(
    '/v1/me/preferences',
    {
      preHandler: fullOnly,
      // A cold view (1), the plan when filters are set (1), the upsert (1).
      config: { pgBudget: 3 },
      schema: { tags: ['me'], summary: 'Who the deck shows', body: preferencesPatchSchema, response: { 200: preferencesSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const cfg = app.cfg.get();
      const body = request.body;
      const view = accountOf((await scrubbed(() => app.account.load(session.userId))).result);
      const before = preferencesOf(view);
      if (!before && body.interestedIn === undefined) throw fieldInvalid('Choose who to meet first.', '/interestedIn');
      const ageMin = body.ageMin ?? before?.ageMin ?? 18;
      const ageMax = body.ageMax ?? before?.ageMax ?? 99;
      if (ageMin > ageMax) throw fieldInvalid('ageMin must not be above ageMax.', body.ageMin !== undefined ? '/ageMin' : '/ageMax');

      let filters: Record<string, number[]> | undefined;
      if (body.filters !== undefined) {
        filters = {};
        for (const [key, values] of Object.entries(body.filters)) {
          const def = cfg.fieldsByKey.get(key);
          const pointer = `/filters/${key}`;
          if (!def?.active || !def.filterable) throw fieldInvalid('Not a filter.', pointer);
          if (def.kind === 'number') {
            const [min, max] = values;
            if (values.length !== 2 || min === undefined || max === undefined || min > max) throw fieldInvalid('A range is [min, max].', pointer);
          } else if (def.kind === 'single' || def.kind === 'multi') {
            const active = new Set(def.options.filter((o) => o.active).map((o) => o.id));
            if (!values.every((v) => active.has(v)) || new Set(values).size !== values.length) throw fieldInvalid('Not options of this field.', pointer);
          } else {
            throw fieldInvalid('Not a filter.', pointer);
          }
          filters[key] = values;
        }
        if (Object.keys(filters).length > 0 && !(await planHasFeature(request, cfg, session.userId, session.storeCode, 'advanced_filters'))) {
          throw new HttpProblem('entitlement_required', { extensions: { feature: 'advanced_filters' } });
        }
      }

      if (body.maxDistanceKm !== undefined && body.maxDistanceKm !== before?.maxDistanceKm && before !== undefined) {
        const key = app.keys.raw('rl', 'radius', session.userId, utcDay(Date.now()));
        try {
          const [[, count]] = (await app.redis.multi().incr(key).expire(key, 2 * 86_400).exec()) as [[Error | null, number]];
          if (count > RADIUS_CHANGES_PER_DAY) {
            throw new HttpProblem('rate_limited', { detail: 'The distance can be changed a few times a day.', retryAfterSeconds: 3_600 });
          }
        } catch (error) {
          if (error instanceof HttpProblem) throw error;
          request.log.warn({ err: error }, 'radius change counter unavailable');
        }
      }

      const clear = preferenceFlags.code('whole_country') * (body.wholeCountry === undefined ? 0 : 1) + preferenceFlags.code('verified_only') * (body.verifiedOnly === undefined ? 0 : 1);
      const set = (body.wholeCountry ? preferenceFlags.code('whole_country') : 0) + (body.verifiedOnly ? preferenceFlags.code('verified_only') : 0);
      const row = await writing(() =>
        writePreferences(app.pg, session.userId, {
          interestedIn: body.interestedIn === undefined ? undefined : codesToMask(body.interestedIn.map((g) => gender.code(g))),
          ageMin: body.ageMin,
          ageMax: body.ageMax,
          maxDistanceKm: body.maxDistanceKm,
          intents: body.intents === undefined ? undefined : codesToMask(body.intents.map((i) => intention.code(i))),
          flagsClear: clear,
          flagsSet: set,
          filters,
        }),
      );
      if (!row) throw fieldInvalid('Choose who to meet first.', '/interestedIn');
      await app.account.changed(session.userId);
      // The prepared deck no longer matches; the next refill builds it with the new preferences.
      await app.cache.del(app.keys.raw('deck', session.userId), app.keys.raw('deckm', session.userId)).catch((error: unknown) => request.log.warn({ err: error }, 'deck queue not cleared'));
      const out = preferencesOf({
        ...view,
        preferences: {
          interestedIn: row.interested_in,
          ageMin: row.age_min,
          ageMax: row.age_max,
          maxDistanceKm: row.max_distance_km,
          intents: row.intents,
          flags: row.flags,
          filters: row.filters,
        },
      });
      if (!out) throw new Error('preferences missing after the write');
      return out;
    },
  );

  // ─── GET /v1/me/settings ────────────────────────────────────────────────
  app.get(
    '/v1/me/settings',
    {
      preHandler: restrictedOk,
      // The cached view: none when warm, account_view() on a miss.
      config: { pgBudget: 1 },
      schema: { tags: ['me'], summary: 'Privacy and visibility switches and the template chosen', response: { 200: settingsSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const view = accountOf((await scrubbed(() => app.account.load(session.userId))).result);
      reply.header('cache-control', 'private, no-cache');
      return settingsOf(view);
    },
  );

  // ─── PATCH /v1/me/settings ──────────────────────────────────────────────
  app.patch(
    '/v1/me/settings',
    {
      preHandler: fullOnly,
      // A cold view (1), the plan when incognito is turned on (1), the write (1).
      config: { pgBudget: 3 },
      schema: { tags: ['me'], summary: 'Privacy and visibility switches', body: settingsPatchSchema, response: { 200: settingsSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const cfg = app.cfg.get();
      const body = request.body;
      const view = accountOf((await scrubbed(() => app.account.load(session.userId))).result);
      if (!view.profile) throw fieldInvalid('Set the name first.', '');
      const status = accountStatus.name(view.status);
      let snooze: boolean | undefined;
      if (body.snoozed !== undefined && body.snoozed !== (status === 'snoozed')) {
        if (status !== 'active' && status !== 'snoozed') throw fieldInvalid('Only an active account can be paused.', '/snoozed');
        snooze = body.snoozed;
      }
      if (body.incognito === true && !view.profile.incognito && !(await planHasFeature(request, cfg, session.userId, session.storeCode, 'incognito'))) {
        throw new HttpProblem('entitlement_required', { extensions: { feature: 'incognito' } });
      }
      const row = await writing(() =>
        writeSettings(app.pg, session.userId, {
          incognito: body.incognito,
          hideAge: body.hideAge,
          hideDistance: body.hideDistance,
          showOnline: body.showOnline,
          acceptCalls: body.acceptCalls,
          modeMatch: body.modeRomance,
          uiTemplate: body.template === undefined ? undefined : uiTemplateChoice.code(body.template),
          snooze,
        }),
      );
      if (!row) throw fieldInvalid('Set the name first.', '');
      // Nothing written: the cached view and every prepared deck still hold. Written: a new view, and the
      // decks build the card again only when its version moved (the template and the other switches it
      // does not show leave it as it is).
      if (row.written) await app.account.changed(session.userId, undefined, { card: row.card });
      const pipeline = app.redis.pipeline();
      // Call placement reads the match flags from their cache: drop the copies that changed (and, for a moment,
      // keep a request that read them before this change from caching them again).
      for (const matchId of row.matches) dropMatchState(pipeline, app.keys, matchId);
      // Incognito turned on: out of every deck prepared before (the next refill of the people this account liked brings it back).
      const hide = snooze === true || (row.incognito && !view.profile.incognito);
      if (hide) {
        const now = Date.now();
        pipeline.zadd(app.keys.accountsHidden(), now, session.userId);
        pipeline.zremrangebyscore(app.keys.accountsHidden(), '-inf', now - 3 * 3_600_000);
      }
      if (row.matches.length > 0 || hide) {
        await pipeline.exec().catch((error: unknown) => request.log.warn({ err: error }, 'settings: Valkey follow-up failed'));
      }
      return {
        incognito: row.incognito,
        hideAge: row.hide_age,
        hideDistance: row.hide_distance,
        showOnline: row.show_online,
        acceptCalls: row.accept_calls,
        modeRomance: row.mode_match,
        snoozed: row.status === accountStatus.code('snoozed'),
        template: uiTemplateChoice.nameOrUndefined(row.ui_template) ?? 'default',
      };
    },
  );

  // ─── PATCH /v1/me/notifications ─────────────────────────────────────────
  app.patch(
    '/v1/me/notifications',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['me'], summary: 'Which pushes this account gets', body: notificationPrefsPatchSchema, response: { 200: notificationPrefsSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      let clear = 0;
      let set = 0;
      for (const name of notifyFlags.names) {
        const value = request.body[name];
        if (value === undefined) continue;
        clear |= notifyFlags.code(name);
        if (value) set |= notifyFlags.code(name);
      }
      const flags = await writing(() => writeNotifyFlags(app.pg, session.userId, clear, set));
      if (flags === null) throw unauthorized();
      // The push switches are not on the card: prepared decks keep it.
      if (clear !== 0) await app.account.changed(session.userId, undefined, { card: false });
      return notificationsOf(flags);
    },
  );

  // ─── Consents ───────────────────────────────────────────────────────────
  const consentList = (rows: Awaited<ReturnType<typeof listConsents>>) => ({
    consents: rows.map((row) => ({
      kind: consentKind.name(row.kind),
      version: row.version,
      acceptedAt: wireTime(row.acceptedAtMs),
      ...(row.withdrawnAtMs !== null ? { withdrawnAt: wireTime(row.withdrawnAtMs) } : {}),
    })),
  });

  app.get(
    '/v1/me/consents',
    {
      preHandler: restrictedOk,
      config: { pgBudget: 1 },
      schema: { tags: ['me'], summary: 'Accepted texts and consents', response: { 200: consentListSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      return consentList(await scrubbed(() => listConsents(app.pg, session.userId)));
    },
  );

  app.put(
    '/v1/me/consents/:kind',
    {
      preHandler: restrictedOk,
      config: { pgBudget: 1 },
      schema: {
        tags: ['me'],
        summary: 'Accept or withdraw a text or a consent',
        params: consentParamsSchema,
        body: consentUpdateSchema,
        response: { 200: consentListSchema },
      },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const cfg = app.cfg.get();
      const { kind } = request.params;
      const { version, accepted } = request.body;
      const legal = cfg.app['legal.versions'];
      if ((kind === 'terms' || kind === 'privacy' || kind === 'guidelines') && version > legal[kind]) {
        throw fieldInvalid(`There is no version ${version} of the ${kind}.`, '/version');
      }
      if (version > 32_767) throw fieldInvalid('Not a version.', '/version');
      const code = consentKind.code(kind);
      const rows = await writing(() =>
        accepted
          ? acceptConsent(app.pg, session.userId, code, version, session.storeCode ?? null)
          : withdrawConsent(app.pg, session.userId, code, SENSITIVE_CONSENT),
      );
      await app.account.changed(session.userId);
      return consentList(rows);
    },
  );
};

export type { AccountView };
