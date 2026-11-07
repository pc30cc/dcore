import { createHmac, randomBytes } from 'node:crypto';
import {
  consentListSchema,
  meSchema,
  moderationHistorySchema,
  notificationPrefsSchema,
  ownProfileSchema,
  preferencesSchema,
  settingsSchema,
} from '@app/shared';
import { IdGeneratorUnavailableError, bumpVersion } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasInfrastructure } from './support.js';
import { call, migratedDatabase, problemExt, row, rows, seedUser, setAppConfig, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';

/** GET /v1/me and the own-account edits against PostgreSQL and Valkey: shapes, statement budgets, rules. */
describe.skipIf(!hasInfrastructure)('the own account', () => {
  let db: TestDatabase;
  let h: Harness;
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db);
  }, 60_000);
  afterAll(async () => {
    // No response of this suite named a person by their raw id, and no log line carries a phone number.
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    expect((h?.logs ?? []).join('\n')).not.toMatch(/\+\d{8,}/);
    await h?.close();
    await db?.drop();
  });

  const seed = async (options: Parameters<typeof seedUser>[1] = {}) => {
    const user = await seedUser(h, options);
    rawIds.push(user.id);
    return user;
  };
  const strict = <T>(schema: { strict(): { parse(v: unknown): T } }, value: unknown): T => schema.strict().parse(value);

  describe('GET /v1/me', () => {
    it('costs one statement on a miss, none warm, and answers 304 from the version alone', async () => {
      const user = await seed({ name: 'Sam', interestedIn: 4 });
      const miss = await call(h, '/v1/me', { token: user.token });
      expect(miss.statusCode).toBe(200);
      expect(statements(miss)).toBe(1);
      const me = meSchema.parse(miss.json());
      expect(me).toMatchObject({ id: user.publicUid, status: 'active', store: 'bazaar', billingRef: h.app.publicIds.billing.encode(user.id) });
      expect(me.profile).toMatchObject({ id: user.publicUid, name: 'Sam', gender: 'man', birthDate: '1994-05-17', textState: 'checking' });
      expect(me.preferences?.interestedIn).toEqual(['man']);
      expect(me.notifications).toEqual({ messages: true, matches: true, likes: true, calls: true, offers: false, previews: false });
      expect(me.consentsDue).toEqual(['terms', 'privacy', 'guidelines']);
      expect(miss.headers['cache-control']).toBe('private, no-cache');

      const warm = await call(h, '/v1/me', { token: user.token });
      expect(statements(warm)).toBe(0);
      expect(warm.json()).toEqual(miss.json());

      const etag = String(warm.headers.etag);
      const same = await call(h, '/v1/me', { token: user.token, headers: { 'if-none-match': etag } });
      expect(same.statusCode).toBe(304);
      expect(statements(same)).toBe(0);
      // The language and the build are part of the answer, and of the ETag.
      expect((await call(h, '/v1/me', { token: user.token, headers: { 'if-none-match': etag, 'accept-language': 'fa' } })).statusCode).toBe(200);

      // An edit moves the version: the old ETag no longer matches, and the fresh view was stored warm.
      await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { likes: false } });
      const changed = await call(h, '/v1/me', { token: user.token, headers: { 'if-none-match': etag } });
      expect(changed.statusCode).toBe(200);
      expect(meSchema.parse(changed.json()).notifications?.likes).toBe(false);
    });

    it('rebuilds the view once when Valkey lost it, and never repeats a version', async () => {
      const user = await seed({ name: 'Lou' });
      const first = await call(h, '/v1/me', { token: user.token });
      const etag = String(first.headers.etag);
      const keys = await h.redis.keys(`${h.prefix}me*:${user.id}*`);
      expect(keys.length).toBeGreaterThan(0);
      await h.redis.del(...keys);
      const after = await call(h, '/v1/me', { token: user.token, headers: { 'if-none-match': etag } });
      expect(after.statusCode).toBe(200);
      expect(statements(after)).toBe(1);
      expect(after.headers.etag).not.toBe(etag);
    });

    it('serves the minimal form to a deleted account in its grace period', async () => {
      const user = await seed({ status: 7, scope: 'restore' });
      const res = await call(h, '/v1/me', { token: user.token });
      expect(res.statusCode).toBe(200);
      const me = strict(meSchema, res.json());
      expect(Object.keys(me).sort()).toEqual(['deletion', 'id', 'status']);
      expect(me.status).toBe('deleted');
      const purgeAt = new Date(me.deletion?.purgeAt ?? 0).getTime();
      expect(purgeAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
      // Anything else answers with the date until which the account can be restored.
      const edit = await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { likes: false } });
      expect(edit.statusCode).toBe(403);
      expect(problemExt('account_deleted', edit.json())['restorableUntil']).toBe(me.deletion?.purgeAt);
    });

    it("does not store an edit's view when another change was announced while the edit ran", async () => {
      const user = await seed({ name: 'Ira' });
      const photoId = h.app.ids.nextId();
      await db.sql.query(`INSERT INTO photos (id, user_id, position) VALUES ($1, $2, 0)`, [photoId, user.id]);
      const photoStatus = async () => meSchema.parse((await call(h, '/v1/me', { token: user.token })).json()).profile?.photos.find((p) => p.id === photoId)?.status;
      expect(await photoStatus()).toBe('processing');

      // The photo worker finishes the photo after the edit's transaction built its view, and before the edit announces it.
      const account = h.app.account;
      const original = account.changed.bind(account);
      account.changed = async (userId, fresh) => {
        if (userId === user.id && fresh) {
          await db.sql.query(`UPDATE photos SET status = 3 WHERE id = $1`, [photoId]);
          await bumpVersion(h.redis, h.app.keys.meVersion(userId));
        }
        return original(userId, fresh);
      };
      try {
        const edit = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'Rivers' } });
        expect(edit.statusCode).toBe(200);
      } finally {
        account.changed = original;
      }
      const after = await call(h, '/v1/me', { token: user.token });
      expect(statements(after)).toBe(1);
      expect(meSchema.parse(after.json()).profile?.photos.find((p) => p.id === photoId)?.status).toBe('approved');

      // Nothing in between: the edit's own view is stored, and the next read is warm.
      expect((await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'Lakes' } })).statusCode).toBe(200);
      const warm = await call(h, '/v1/me', { token: user.token });
      expect(statements(warm)).toBe(0);
      expect(meSchema.parse(warm.json()).profile?.about).toBe('Lakes');
    });

    it('refuses a request without a session, and one whose account is gone', async () => {
      expect((await call(h, '/v1/me')).statusCode).toBe(401);
      const gone = await seed({ status: 8 });
      expect((await call(h, '/v1/me', { token: gone.token })).statusCode).toBe(401);
    });
  });

  describe('sign-up', () => {
    it('walks from the first name to an active account, writing the consents with the basics', async () => {
      const user = await seed({ status: 1 });
      const name = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { displayName: 'Mina', onboardingStep: 2 } });
      expect(name.statusCode).toBe(200);
      expect(statements(name)).toBeLessThanOrEqual(4);
      expect(strict(ownProfileSchema, name.json())).toMatchObject({ name: 'Mina', completeness: expect.any(Number) as number });

      const basics = await call(h, '/v1/me/basics', {
        method: 'PUT',
        token: user.token,
        body: { birthDate: '1996-09-14', gender: 'woman', consents: { terms: 1, privacy: 1 } },
      });
      expect(basics.statusCode).toBe(200);
      expect(statements(basics)).toBe(2);
      expect(strict(ownProfileSchema, basics.json())).toMatchObject({ gender: 'woman', birthDate: '1996-09-14', age: expect.any(Number) as number });
      const consents = await rows<{ kind: number; version: number; store: number }>(db, 'SELECT kind, version, store FROM user_consents WHERE user_id = $1 ORDER BY kind', [user.id]);
      expect(consents).toEqual([
        { kind: 1, version: 1, store: 2 },
        { kind: 2, version: 1, store: 2 },
      ]);
      // Once only.
      const twice = await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '1990-01-01', gender: 'man', consents: { terms: 1, privacy: 1 } } });
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ code: 'already_set' });

      // Not finished yet: the server says what is missing and changes nothing.
      const early = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { onboardingStep: 30 } });
      expect(early.statusCode).toBe(403);
      expect(problemExt('consent_required', early.json())['kinds']).toEqual(['guidelines']);
      const guidelines = await call(h, '/v1/me/consents/guidelines', { method: 'PUT', token: user.token, body: { version: 1, accepted: true } });
      expect(guidelines.statusCode).toBe(200);
      expect(statements(guidelines)).toBe(1);
      const missing = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { onboardingStep: 30 } });
      expect(missing.statusCode).toBe(422);
      expect(problemExt('field_invalid', missing.json())['errors']).toMatchObject([{ code: 'interested_in' }, { code: 'photos' }, { code: 'location' }]);
      expect((await row<{ status: number; onboarding_step: number }>(db, 'SELECT status, onboarding_step FROM users WHERE id = $1', [user.id])).status).toBe(1);

      expect((await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { interestedIn: ['man'] } })).statusCode).toBe(200);
      expect((await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: { source: 'city', cityId: 112931 } })).statusCode).toBe(200);
      for (const position of [0, 1]) {
        await db.sql.query('INSERT INTO photos (id, user_id, position, status, width, height, blurhash) VALUES ($1, $2, $3, 3, 1080, 1350, $4)', [
          h.app.ids.nextId(),
          user.id,
          position,
          'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        ]);
      }
      await h.app.account.changed(user.id);
      const done = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { onboardingStep: 30 } });
      expect(done.statusCode).toBe(200);
      expect(statements(done)).toBeLessThanOrEqual(4);
      const me = meSchema.parse((await call(h, '/v1/me', { token: user.token })).json());
      expect(me.status).toBe('active');
      expect(me.onboardingStep).toBe(30);
      expect(me.consentsDue).toEqual([]);
      expect(me.location).toEqual({ city: { id: 112931, name: 'Tehran' }, country: 'IR' });
      expect(me.profile?.photos.map((p) => p.status)).toEqual(['approved', 'approved']);
      // Now in the deck pool (two approved photos, a location, preferences, an active account).
      expect(await rows(db, 'SELECT 1 FROM discovery WHERE user_id = $1', [user.id])).toHaveLength(1);
    });

    it('asks again for a text whose version was raised, and refuses an older one at the basics', async () => {
      const user = await seed({ status: 1, name: 'Eli' });
      await setAppConfig(h, 'legal.versions', { terms: 2, privacy: 1, guidelines: 1 });
      try {
        const old = await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '1990-02-03', gender: 'man', consents: { terms: 1, privacy: 1 } } });
        expect(old.statusCode).toBe(403);
        expect(problemExt('consent_required', old.json())['kinds']).toEqual(['terms']);
        const future = await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '1990-02-03', gender: 'man', consents: { terms: 3, privacy: 1 } } });
        expect(future.json()).toMatchObject({ code: 'field_invalid' });
        const active = await seed({ name: 'Ann' });
        await call(h, '/v1/me/consents/terms', { method: 'PUT', token: active.token, body: { version: 1, accepted: true } });
        // The cached view does not hold the due list: it follows the version in memory.
        expect(meSchema.parse((await call(h, '/v1/me', { token: active.token })).json()).consentsDue).toEqual(['terms', 'privacy', 'guidelines']);
        await call(h, '/v1/me/consents/terms', { method: 'PUT', token: active.token, body: { version: 2, accepted: true } });
        expect(meSchema.parse((await call(h, '/v1/me', { token: active.token })).json()).consentsDue).toEqual(['privacy', 'guidelines']);
      } finally {
        await setAppConfig(h, 'legal.versions', { terms: 1, privacy: 1, guidelines: 1 });
      }
    });

    it('closes an under-age sign-up for good: tombstone, a year of bans, nothing it wrote kept', async () => {
      const user = await seed({ status: 1, name: 'Kid' });
      const phoneHash = createHmac('sha256', randomBytes(32)).update('1:+989121234567').digest();
      await db.sql.query('INSERT INTO auth_identities (id, user_id, provider, subject_hash) VALUES ($1, $2, 1, $3)', [h.app.ids.nextId(), user.id, phoneHash]);
      const young = new Date();
      young.setUTCFullYear(young.getUTCFullYear() - 17);
      const res = await call(h, '/v1/me/basics', {
        method: 'PUT',
        token: user.token,
        body: { birthDate: young.toISOString().slice(0, 10), gender: 'woman', consents: { terms: 1, privacy: 1 } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'under_age' });
      expect(statements(res)).toBeLessThanOrEqual(5);
      const account = await row<{ status: number; birth_date: string | null; gender: number | null; deleted_via: number }>(
        db,
        'SELECT status, birth_date, gender, deleted_via FROM users WHERE id = $1',
        [user.id],
      );
      expect(account).toEqual({ status: 8, birth_date: null, gender: null, deleted_via: 4 });
      const bans = await rows<{ kind: number; days: number }>(
        db,
        `SELECT kind, round(extract(epoch FROM expires_at - now()) / 86400)::int AS days FROM device_bans WHERE value_hash = $1 OR kind = 1 ORDER BY kind`,
        [phoneHash],
      );
      expect(bans.map((b) => b.kind)).toEqual([1, 2]);
      for (const ban of bans) expect(ban.days).toBeGreaterThanOrEqual(364);
      for (const table of ['profiles', 'preferences', 'user_locations', 'profile_prompts', 'profile_field_values', 'auth_identities', 'sessions', 'devices']) {
        expect(await rows(db, `SELECT 1 FROM ${table} WHERE user_id = $1`, [user.id]), table).toHaveLength(0);
      }
      // Its tokens stop at once.
      expect((await call(h, '/v1/me', { token: user.token })).statusCode).toBe(401);
    });

    it('answers already_set to a second basics with an under-age date, and closes nothing', async () => {
      const user = await seed({ status: 1, name: 'Ada' });
      const bansBefore = await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM device_bans WHERE reason = 'under_age'`);
      const first = await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '1990-01-01', gender: 'woman', consents: { terms: 1, privacy: 1 } } });
      expect(first.statusCode).toBe(200);
      // Another phone of the same account, still on the birth-date step, sends a typo.
      const again = await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '2015-01-01', gender: 'woman', consents: { terms: 1, privacy: 1 } } });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'already_set' });
      expect(await row(db, `SELECT status, birth_date::text AS birth, deleted_via FROM users WHERE id = $1`, [user.id])).toEqual({ status: 1, birth: '1990-01-01', deleted_via: null });
      expect(await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM device_bans WHERE reason = 'under_age'`)).toEqual(bansBefore);
      expect(await rows(db, `SELECT 1 FROM sessions WHERE user_id = $1`, [user.id])).toHaveLength(1);
      expect((await call(h, '/v1/me', { token: user.token })).statusCode).toBe(200);
    });

    it('is refused by the database too: no birth date under 18 at sign-up time', async () => {
      const user = await seed({ status: 1 });
      const young = new Date();
      young.setUTCFullYear(young.getUTCFullYear() - 17);
      await expect(
        db.sql.query('UPDATE users SET birth_date = $2, gender = 1 WHERE id = $1', [user.id, young.toISOString().slice(0, 10)]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'users_adult' });
    });
  });

  describe('profile edits', () => {
    it('validates fields and prompts against the catalogue, refuses banned terms, and keeps one statement for the edit', async () => {
      const { id: smoking } = await row<{ id: number }>(
        db,
        `INSERT INTO profile_field_defs (type, key, i18n, options, max_choices) VALUES (2, 'languages', '{"en": "Languages"}', '[{"id": 1}, {"id": 2}, {"id": 3}]', 2) RETURNING id`,
      );
      const { id: religion } = await row<{ id: number }>(db, `INSERT INTO profile_field_defs (type, key, i18n, is_sensitive, is_public) VALUES (3, 'religion', '{}', true, false) RETURNING id`);
      const { id: p1 } = await row<{ id: number }>(db, `INSERT INTO prompt_defs (i18n) VALUES ('{"en": "One"}') RETURNING id`);
      const { id: p2 } = await row<{ id: number }>(db, `INSERT INTO prompt_defs (i18n) VALUES ('{"en": "Two"}') RETURNING id`);
      await db.sql.query(`INSERT INTO banned_terms (match_kind, severity, scope, term) VALUES (2, 3, 31, 'forbiddenword'), (1, 2, 31, 'reviewme')`);
      await setAppConfig(h, 'deck.pass_return_days', 30);
      const user = await seed({ name: 'Rae' });
      await call(h, '/v1/me', { token: user.token });

      const ok = await call(h, '/v1/me/profile', {
        method: 'PATCH',
        token: user.token,
        body: {
          about: 'Maps and coffee',
          jobTitle: 'Designer',
          intention: 'marriage',
          fields: [{ fieldId: smoking, options: [3, 1] }],
          prompts: [
            { position: 0, promptId: p1, answer: 'Night trains' },
            { position: 1, promptId: p2, answer: 'Pancakes' },
          ],
        },
      });
      expect(ok.statusCode).toBe(200);
      // Warm view, the edit, the fresh view and the stored completeness.
      expect(statements(ok)).toBe(3);
      const profile = strict(ownProfileSchema, ok.json());
      expect(profile).toMatchObject({ about: 'Maps and coffee', job: 'Designer', intention: 'marriage', textState: 'approved' });
      expect(profile.fields).toEqual([{ fieldId: smoking, options: [1, 3] }]);
      expect(profile.prompts.map((p) => [p.position, p.promptId, p.status])).toEqual([
        [0, p1, 'approved'],
        [1, p2, 'approved'],
      ]);
      const stored = await row<{ completeness: number; version: number }>(db, 'SELECT completeness, version FROM profiles WHERE user_id = $1', [user.id]);
      expect(stored.completeness).toBe(profile.completeness);

      // A prompt moves: its old position is freed in the same edit.
      const moved = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { prompts: [{ position: 2, promptId: p1, answer: 'Night trains' }] } });
      expect(strict(ownProfileSchema, moved.json()).prompts.map((p) => [p.position, p.promptId])).toEqual([
        [1, p2],
        [2, p1],
      ]);
      const removed = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { prompts: [{ position: 1, promptId: p2, answer: null }], fields: [{ fieldId: smoking }] } });
      const after = strict(ownProfileSchema, removed.json());
      expect(after.prompts.map((p) => p.position)).toEqual([2]);
      expect(after.fields).toEqual([]);

      const refused = [
        { body: { about: 'a forbiddenword here' }, code: 'text_refused' },
        { body: { displayName: 'reviewme' }, code: 'text_refused' },
        { body: { fields: [{ fieldId: smoking, options: [1, 2, 3] }] }, code: 'field_invalid' },
        { body: { fields: [{ fieldId: smoking, options: [9] }] }, code: 'field_invalid' },
        { body: { fields: [{ fieldId: smoking, option: 1, options: [1] }] }, code: 'field_invalid' },
        { body: { fields: [{ fieldId: religion, text: 'Private' }] }, code: 'field_invalid' },
        { body: { fields: [{ fieldId: 32000, number: 3 }] }, code: 'field_invalid' },
        { body: { prompts: [{ position: 0, promptId: 32000, answer: 'x' }] }, code: 'field_invalid' },
      ];
      for (const { body, code } of refused) {
        const res = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body });
        expect(res.json(), JSON.stringify(body)).toMatchObject({ code });
      }
      // A flagged text waits for a human.
      const flagged = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'please reviewme' } });
      expect(strict(ownProfileSchema, flagged.json()).textState).toBe('checking');

      // The sensitive field takes a value with its consent; withdrawing the consent deletes the value.
      await call(h, '/v1/me/consents/sensitive_fields', { method: 'PUT', token: user.token, body: { version: 1, accepted: true } });
      const sensitive = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { fields: [{ fieldId: religion, text: 'Private' }] } });
      expect(strict(ownProfileSchema, sensitive.json()).fields).toEqual([{ fieldId: religion, text: 'Private' }]);
      const withdrawn = await call(h, '/v1/me/consents/sensitive_fields', { method: 'PUT', token: user.token, body: { version: 1, accepted: false } });
      expect(statements(withdrawn)).toBe(1);
      const list = strict(consentListSchema, withdrawn.json());
      expect(list.consents.find((c) => c.kind === 'sensitive_fields')?.withdrawnAt).toBeDefined();
      expect(await rows(db, 'SELECT 1 FROM profile_field_values WHERE user_id = $1 AND field_id = $2', [user.id, religion])).toHaveLength(0);
      expect(meSchema.parse((await call(h, '/v1/me', { token: user.token })).json()).profile?.fields).toEqual([]);
    });

    it('needs the name before anything else of the profile', async () => {
      const user = await seed({ status: 1 });
      const res = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'Hello' } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'field_invalid' });
      const step = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { onboardingStep: 4 } });
      expect(step.statusCode).toBe(200);
      expect((await row<{ onboarding_step: number }>(db, 'SELECT onboarding_step FROM users WHERE id = $1', [user.id])).onboarding_step).toBe(4);
    });
  });

  describe('preferences, settings and push switches', () => {
    it('keeps filters for the advanced-filters plan and limits radius changes', async () => {
      await db.sql.query(`INSERT INTO profile_field_defs (type, key, i18n, is_filterable) VALUES (4, 'height', '{"en": "Height"}', true)`);
      await setAppConfig(h, 'deck.pass_return_days', 31);
      const user = await seed({ name: 'Ida', interestedIn: 2 });
      await h.redis.rpush(`${h.prefix}deck:${user.id}`, '1', '2');
      const plain = await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { ageMin: 25, ageMax: 40, intents: ['serious'], verifiedOnly: true } });
      expect(plain.statusCode).toBe(200);
      expect(statements(plain)).toBeLessThanOrEqual(2);
      expect(strict(preferencesSchema, plain.json())).toMatchObject({ interestedIn: ['woman'], ageMin: 25, ageMax: 40, intents: ['serious'], verifiedOnly: true, wholeCountry: false });
      // The prepared deck no longer matches the preferences.
      expect(await h.redis.exists(`${h.prefix}deck:${user.id}`)).toBe(0);

      const filters = await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { filters: { height: [160, 185] } } });
      expect(filters.statusCode).toBe(403);
      expect(problemExt('entitlement_required', filters.json())['feature']).toBe('advanced_filters');
      await db.sql.query(`INSERT INTO subscriptions (user_id, started_at, expires_at, plan_id, store, status) VALUES ($1, now(), now() + interval '7 days', 2, 0, 4)`, [user.id]);
      const paid = await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { filters: { height: [160, 185] } } });
      expect(paid.statusCode).toBe(200);
      expect(statements(paid)).toBeLessThanOrEqual(3);
      expect(preferencesSchema.parse(paid.json()).filters).toEqual({ height: [160, 185] });
      expect((await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { filters: { nosuch: [1] } } })).json()).toMatchObject({ code: 'field_invalid' });
      expect((await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { ageMin: 50 } })).json()).toMatchObject({ code: 'field_invalid' });

      const statuses: number[] = [];
      for (let km = 11; km <= 21; km += 1) statuses.push((await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { maxDistanceKm: km } })).statusCode);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('turns the switches, the snooze and the call bits of every active match', async () => {
      const user = await seed({ name: 'Ola' });
      const lower = await seed({ name: 'Peer' });
      const [lo, hi] = BigInt(user.id) < BigInt(lower.id) ? [user.id, lower.id] : [lower.id, user.id];
      const matchId = h.app.ids.nextId();
      await db.sql.query('INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, 3)', [matchId, lo, hi]);
      await h.redis.hset(`${h.prefix}mt:${matchId}`, { lo, hi, st: 1, fl: 3 });

      const off = await call(h, '/v1/me/settings', { method: 'PATCH', token: user.token, body: { acceptCalls: false, hideAge: true, modeRomance: false } });
      expect(off.statusCode).toBe(200);
      expect(statements(off)).toBeLessThanOrEqual(2);
      expect(strict(settingsSchema, off.json())).toEqual({ incognito: false, hideAge: true, hideDistance: false, showOnline: true, acceptCalls: false, modeRomance: false, snoozed: false });
      const bit = user.id === lo ? 1 : 2;
      expect((await row<{ flags: number }>(db, 'SELECT flags FROM matches WHERE id = $1', [matchId])).flags).toBe(3 & ~bit);
      expect(await h.redis.exists(`${h.prefix}mt:${matchId}`)).toBe(0);

      const incognito = await call(h, '/v1/me/settings', { method: 'PATCH', token: user.token, body: { incognito: true } });
      expect(problemExt('entitlement_required', incognito.json())['feature']).toBe('incognito');

      const snoozed = await call(h, '/v1/me/settings', { method: 'PATCH', token: user.token, body: { snoozed: true } });
      expect(settingsSchema.parse(snoozed.json()).snoozed).toBe(true);
      expect((await row<{ status: number }>(db, 'SELECT status FROM users WHERE id = $1', [user.id])).status).toBe(4);
      expect(await h.redis.zscore(`${h.prefix}vis:out`, user.id)).not.toBeNull();
      expect(meSchema.parse((await call(h, '/v1/me', { token: user.token })).json()).status).toBe('snoozed');
      const back = await call(h, '/v1/me/settings', { method: 'PATCH', token: user.token, body: { snoozed: false, acceptCalls: true } });
      expect(back.json()).toMatchObject({ snoozed: false, acceptCalls: true });
      expect((await row<{ flags: number }>(db, 'SELECT flags FROM matches WHERE id = $1', [matchId])).flags).toBe(3);

      const onboarding = await seed({ status: 1, name: 'New' });
      expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: onboarding.token, body: { snoozed: true } })).json()).toMatchObject({ code: 'field_invalid' });
    });

    it('stores the push switches as bits, writing only on a change', async () => {
      const user = await seed({ name: 'Bo' });
      const res = await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { previews: true, likes: false } });
      expect(statements(res)).toBe(1);
      expect(strict(notificationPrefsSchema, res.json())).toEqual({ messages: true, matches: true, likes: false, calls: true, offers: false, previews: true });
      expect((await row<{ notify_flags: number }>(db, 'SELECT notify_flags FROM users WHERE id = $1', [user.id])).notify_flags).toBe(1 | 2 | 8 | 32);
    });
  });

  describe('consents', () => {
    it('lists, accepts again after a withdrawal and refuses a version that does not exist', async () => {
      const user = await seed({ name: 'Cy' });
      const marketing = await call(h, '/v1/me/consents/marketing_push', { method: 'PUT', token: user.token, body: { version: 1, accepted: true } });
      expect(strict(consentListSchema, marketing.json()).consents.map((c) => c.kind)).toEqual(['marketing_push']);
      const withdrawn = await call(h, '/v1/me/consents/marketing_push', { method: 'PUT', token: user.token, body: { version: 1, accepted: false } });
      expect(consentListSchema.parse(withdrawn.json()).consents[0]?.withdrawnAt).toEqual(expect.any(String));
      const again = await call(h, '/v1/me/consents/marketing_push', { method: 'PUT', token: user.token, body: { version: 1, accepted: true } });
      expect(consentListSchema.parse(again.json()).consents[0]?.withdrawnAt).toBeUndefined();
      const list = await call(h, '/v1/me/consents', { token: user.token });
      expect(statements(list)).toBe(1);
      expect(list.json()).toEqual(again.json());
      expect((await call(h, '/v1/me/consents/terms', { method: 'PUT', token: user.token, body: { version: 9, accepted: true } })).json()).toMatchObject({ code: 'field_invalid' });
      expect((await call(h, '/v1/me/consents/nonsense', { method: 'PUT', token: user.token, body: { version: 1, accepted: true } })).statusCode).toBe(400);
    });
  });

  describe('suspended and banned accounts', () => {
    async function penalised(status: 5 | 6) {
      const user = await seed({ name: 'Max', status, scope: 'restricted' });
      const actionId = h.app.ids.nextId();
      await db.sql.query(
        `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, ends_at) VALUES ($1, $2, $3, 1, 'Repeated reports of harassment.', $4)`,
        [actionId, user.id, status === 5 ? 2 : 3, status === 5 ? new Date(Date.now() + 7 * 86_400_000) : null],
      );
      return { user, actionId };
    }

    it('reads the account and the reason, appeals once, and gets the reason on every other route', async () => {
      const { user, actionId } = await penalised(5);
      const warning = h.app.ids.nextId();
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 1, 2, 'Please keep messages respectful.')`, [warning, user.id]);
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 4, 3, 'internal')`, [h.app.ids.nextId(), user.id]);

      const me = meSchema.parse((await call(h, '/v1/me', { token: user.token })).json());
      expect(me.status).toBe('suspended');
      expect(me.moderation?.map((a) => [a.id, a.kind])).toEqual([[actionId, 'suspension']]);

      const history = await call(h, '/v1/me/moderation', { token: user.token });
      expect(history.statusCode).toBe(200);
      expect(statements(history)).toBe(1);
      const body = moderationHistorySchema.parse(history.json());
      expect(body.active.map((a) => a.id)).toEqual([actionId]);
      expect(body.history.map((a) => a.kind)).toEqual(['warning']);
      expect(JSON.stringify(body)).not.toContain('internal');

      const edit = await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { likes: false } });
      expect(edit.statusCode).toBe(403);
      const problem = problemExt('account_suspended', edit.json());
      expect(problem).toMatchObject({ reasonText: 'Repeated reports of harassment.', actionId, appealable: true });
      expect(problem['until']).toEqual(expect.any(String));
      expect((await call(h, '/v1/realtime/token', { method: 'POST', token: user.token })).statusCode).toBe(403);

      const filed = await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId, body: 'It was a misunderstanding.' } });
      expect(filed.statusCode).toBe(201);
      expect(statements(filed)).toBe(1);
      expect(filed.json()).toEqual({ appeal: { id: expect.any(String) as string, status: 'open' } });
      const twice = await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId, body: 'Again.' } });
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ code: 'appeal_open' });
      expect(meSchema.parse((await call(h, '/v1/me', { token: user.token })).json()).moderation?.[0]?.appeal?.status).toBe('open');
      const after = await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { likes: false } });
      expect(problemExt('account_suspended', after.json())['appealable']).toBe(false);

      await db.sql.query(`UPDATE public.appeals SET status = 2, decided_at = now(), decision_text = 'The suspension stays.' WHERE action_id = $1`, [actionId]);
      const decided = await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId, body: 'Please.' } });
      expect(decided.statusCode).toBe(422);
      expect(decided.json()).toMatchObject({ code: 'not_appealable' });
      expect(moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: user.token })).json()).active[0]?.appeal).toEqual({
        id: expect.any(String) as string,
        status: 'upheld',
        decisionText: 'The suspension stays.',
      });
      // Someone else's action, or none: not found.
      const other = await penalised(6);
      expect((await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId: other.actionId, body: 'x' } })).statusCode).toBe(404);
    });

    it('refuses a restricted session with its reason on the routes that cost no statement, also on a cold cache', async () => {
      for (const [method, url] of [
        ['POST', '/v1/realtime/token'],
        ['GET', '/v1/cities?q=Teh'],
      ] as const) {
        // A new account each time: nothing of it is in Valkey yet, so the refusal reads account_view().
        const { user, actionId } = await penalised(5);
        const res = await call(h, url, { method, token: user.token });
        expect(res.statusCode, url).toBe(403);
        expect(problemExt('account_suspended', res.json())).toMatchObject({ reasonText: 'Repeated reports of harassment.', actionId, appealable: true });
        expect(statements(res), url).toBe(1);
      }
    });

    it('answers an appeal 503 with Retry-After while the process holds no id lease', async () => {
      const { user, actionId } = await penalised(6);
      const ids = h.app.ids;
      const original = ids.nextId.bind(ids);
      ids.nextId = () => {
        throw new IdGeneratorUnavailableError('lease_stale');
      };
      let res;
      try {
        res = await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId, body: 'Please look again.' } });
      } finally {
        ids.nextId = original;
      }
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'service_unavailable' });
      expect(res.headers['retry-after']).toBeDefined();
      expect(statements(res)).toBe(0);
      expect(h.logs.some((line) => line.includes('"level":50') && line.includes('/v1/appeals'))).toBe(false);
      // Once the lease is back the appeal goes in.
      expect((await call(h, '/v1/appeals', { method: 'POST', token: user.token, body: { actionId, body: 'Please look again.' } })).statusCode).toBe(201);
    });

    it('answers a banned account with the ban', async () => {
      const { user, actionId } = await penalised(6);
      const res = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'x' } });
      expect(res.statusCode).toBe(403);
      const problem = problemExt('account_banned', res.json());
      expect(problem).toMatchObject({ actionId, appealable: true });
      expect(problem['until']).toBeUndefined();
      expect((await call(h, '/v1/me/consents', { token: user.token })).statusCode).toBe(200);
    });

    it('asks for a refresh when the scope is older than the account (a lifted ban)', async () => {
      const user = await seed({ name: 'Tom', scope: 'restricted' });
      const res = await call(h, '/v1/me/notifications', { method: 'PATCH', token: user.token, body: { likes: false } });
      expect(res.statusCode).toBe(401);
    });
  });
});
