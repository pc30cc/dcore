import { adminPlanSchema, adminProductSchema, auditActions, type AuditAction } from '@app/shared';
import { FakeRealtimePublisher, generateOriginsKeyPair } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { migratedDatabase, row, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, installAuditFailure, refuseAudit, seedAdmin, signIn, startAdminHarness, type AdminHarness, type AdminSession, type SignedIn } from './adminSupport.js';
import { profileVersion, seedAction, seedAppeal, seedEvidenceReport, seedMatch, seedPhone, seedPhoto, seedTexts } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * AC2, the guard: every admin route that writes (POST, PUT, PATCH, DELETE
 * under /v1/admin, the sign-in routes aside: their suite covers them) is in
 * AUDITED_WRITES with the action(s) it audits, and one parametrised test
 * runs each with its audit row refused: the answer is a 500, every table of
 * the database reads as before, and nothing reached the realtime side, the
 * job queue or the deny list. The same call without the refusal then
 * succeeds and writes its row, so the 500 was the audit row's.
 */

type Send = () => Promise<LightMyRequestResponse>;
interface AuditedWrite {
  actions: readonly AuditAction[];
  /** Sets the case up (with audit rows allowed) and gives the call to make. */
  prepare: () => Promise<Send>;
}

const SIGN_IN_PREFIX = '/v1/admin/auth/';

describe.skipIf(!hasInfrastructure)('admin: every write is audited in its transaction (AC2)', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  let superadmin: AdminSession;
  let counter = 0;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    const pair = generateOriginsKeyPair();
    h = await startAdminHarness(db, { ORIGINS_SIGNING_KEY: pair.privateKey, ORIGINS_SIGNING_KID: 'o1' }, { jobs, realtime });
    superadmin = await adminAs(h, 'superadmin');
    // Every table of the schema, hashed row by row (the extensions' own tables and the test's refusal list aside).
    await db.sql.query(`CREATE OR REPLACE FUNCTION test_digest() RETURNS TABLE (name text, digest text) LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT c.oid::regclass AS t, c.relname
                   FROM pg_class c
                  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
                    AND c.relname <> 'test_audit_refused'
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
                  ORDER BY c.relname LOOP
          name := r.relname;
          EXECUTE format('SELECT md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) FROM %s x', r.t) INTO digest;
          RETURN NEXT;
        END LOOP;
      END $$`);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  function as(session: SignedIn, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Send {
    return () => admin(h, url, body ?? (method === 'DELETE' ? undefined : {}), { token: session.accessToken, method });
  }
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => as(superadmin, method, url, body);
  const unique = (word: string) => `${word}${(counter += 1)}`;

  async function digest(): Promise<Record<string, string>> {
    const result = await db.sql.query<{ name: string; digest: string }>(`SELECT name, digest FROM test_digest()`);
    return Object.fromEntries(result.rows.map((r) => [r.name, r.digest]));
  }

  async function denyKeys(): Promise<number> {
    return (await h.redis.keys(`${h.prefix}deny:*`)).length;
  }

  async function person(options: { name?: string; status?: number } = {}): Promise<SeededUser> {
    return seedUser(h, { name: options.name ?? unique('Person '), ...(options.status ? { status: options.status } : {}) });
  }

  async function staff(roles: string[] = ['support']): Promise<number> {
    return (await seedAdmin(h, { roles })).id;
  }

  async function plan(key: string): Promise<void> {
    const res = await send('POST', '/v1/admin/plans', { key, names: { en: key } })();
    if (res.statusCode !== 201) throw new Error(`plan ${res.statusCode}: ${res.body}`);
  }

  async function product(active: boolean): Promise<string> {
    const res = await send('POST', '/v1/admin/store-products', { store: 'play', kind: 'consumable', productId: unique('guard.boost.'), item: 'boost', quantity: 5, active })();
    if (res.statusCode !== 201) throw new Error(`product ${res.statusCode}: ${res.body}`);
    return adminProductSchema.parse(res.json()).id;
  }

  async function chatReport(): Promise<string> {
    const reported = await person();
    const reporter = await person();
    const matchId = await seedMatch(h, reported.id, reporter.id);
    const nowMs = Date.now();
    return seedEvidenceReport(h, {
      targetId: reported.id,
      reporterId: reporter.id,
      matchId,
      evidence: {
        v: 1,
        items: [],
        chat: [{ filingId: '1', conversationId: matchId, takenAtMs: nowMs, messages: [{ id: '1', senderId: reported.id, kind: 1, flags: 0, body: 'A message', atMs: nowMs - 1_000 }] }],
      },
    });
  }

  async function appeal(): Promise<string> {
    const user = await person();
    const ban = await seedAction(h, user.id, 3);
    return seedAppeal(h, user.id, ban);
  }

  async function bannedTerm(): Promise<string> {
    const res = await send('POST', '/v1/admin/banned-terms', { term: unique('guardterm'), match: 'substring', severity: 'ask', scope: ['name'] })();
    return res.json<{ term: { id: string } }>().term.id;
  }

  const AUDITED_WRITES: Record<string, AuditedWrite> = {
    // ─── Settings ───
    'PUT /v1/admin/providers/rtc': { actions: ['config.update'], prepare: async () => send('PUT', '/v1/admin/providers/rtc', { maxLiveCalls: 100 + (counter += 1) }) },
    'PUT /v1/admin/origins': {
      actions: ['config.update'],
      prepare: async () => send('PUT', '/v1/admin/origins', { hosts: { api: [`https://api${(counter += 1)}.example.net`], realtime: ['https://rt.example.net'], rtc: ['https://rtc.example.net'], cdn: ['https://cdn.example.net'], web: ['https://example.org'] } }),
    },
    'PUT /v1/admin/appearance': {
      actions: ['config.update'],
      prepare: async () => {
        const current = (await admin(h, '/v1/admin/appearance', undefined, { token: superadmin.accessToken })).json<{ version: string; defaultTemplate: string }>();
        return send('PUT', '/v1/admin/appearance', { baseVersion: current.version, defaultTemplate: current.defaultTemplate === 'white' ? 'neon' : 'white', offered: ['neon', 'white'] });
      },
    },
    // ─── The signed-in admin and admin accounts ───
    'DELETE /v1/admin/me/sessions/{id}': {
      actions: ['admin.session_revoke'],
      prepare: async () => {
        const account = await seedAdmin(h, { roles: ['support'] });
        const mine = await signIn(h, account);
        const other = await signIn(h, account);
        return as(mine, 'DELETE', `/v1/admin/me/sessions/${other.sessionId}`);
      },
    },
    'PUT /v1/admin/me/password': {
      actions: ['admin.password_change'],
      prepare: async () => {
        const account = await seedAdmin(h, { roles: ['support'] });
        return as(await signIn(h, account), 'PUT', '/v1/admin/me/password', { currentPassword: account.password, newPassword: 'a brand new guard password' });
      },
    },
    'POST /v1/admin/admins': { actions: ['admin.create'], prepare: async () => send('POST', '/v1/admin/admins', { email: `${unique('guard')}@example.com`, displayName: 'Guard', roles: ['support'] }) },
    'PATCH /v1/admin/admins/{id}': { actions: ['admin.update'], prepare: async () => send('PATCH', `/v1/admin/admins/${await staff()}`, { displayName: 'Renamed by guard' }) },
    'POST /v1/admin/admins/{id}/disable': { actions: ['admin.disable'], prepare: async () => send('POST', `/v1/admin/admins/${await staff()}/disable`) },
    'POST /v1/admin/admins/{id}/enable': {
      actions: ['admin.enable'],
      prepare: async () => {
        const id = await staff();
        await db.sql.query('UPDATE admin_users SET disabled_at = now() WHERE id = $1', [id]);
        return send('POST', `/v1/admin/admins/${id}/enable`);
      },
    },
    'POST /v1/admin/admins/{id}/reset-totp': { actions: ['admin.totp_reset'], prepare: async () => send('POST', `/v1/admin/admins/${await staff()}/reset-totp`) },
    'POST /v1/admin/admins/{id}/reset-password': { actions: ['admin.password_reset'], prepare: async () => send('POST', `/v1/admin/admins/${await staff()}/reset-password`) },
    // ─── Plans and store products ───
    'POST /v1/admin/plans': { actions: ['plan.create'], prepare: async () => send('POST', '/v1/admin/plans', { key: unique('guardplan'), names: { en: 'Guard' } }) },
    'PATCH /v1/admin/plans/{key}': {
      actions: ['plan.update'],
      prepare: async () => {
        const key = unique('guardedit');
        await plan(key);
        return send('PATCH', `/v1/admin/plans/${key}`, { sort: 9 });
      },
    },
    'POST /v1/admin/plans/{key}/archive': {
      actions: ['plan.archive'],
      prepare: async () => {
        const key = unique('guardarch');
        await plan(key);
        return send('POST', `/v1/admin/plans/${key}/archive`);
      },
    },
    'POST /v1/admin/plans/{key}/unarchive': {
      actions: ['plan.unarchive'],
      prepare: async () => {
        const key = unique('guardunarch');
        await plan(key);
        await send('POST', `/v1/admin/plans/${key}/archive`)();
        return send('POST', `/v1/admin/plans/${key}/unarchive`);
      },
    },
    'PUT /v1/admin/plan-ranks': {
      actions: ['plan.reorder'],
      prepare: async () => {
        const list = (await admin(h, '/v1/admin/plans', undefined, { token: superadmin.accessToken })).json<{ items: unknown[] }>();
        const paid = list.items
          .map((item) => adminPlanSchema.parse(item))
          .filter((p) => p.rank > 0)
          .sort((a, b) => a.rank - b.rank)
          .map((p) => p.key);
        return send('PUT', '/v1/admin/plan-ranks', { order: [...paid].reverse() });
      },
    },
    'POST /v1/admin/store-products': {
      actions: ['product.create'],
      prepare: async () => send('POST', '/v1/admin/store-products', { store: 'play', kind: 'consumable', productId: unique('guard.new.'), item: 'boost', quantity: 3 }),
    },
    'PATCH /v1/admin/store-products/{id}': { actions: ['product.update'], prepare: async () => send('PATCH', `/v1/admin/store-products/${await product(false)}`, { sort: 77 }) },
    'POST /v1/admin/store-products/{id}/activate': { actions: ['product.activate'], prepare: async () => send('POST', `/v1/admin/store-products/${await product(false)}/activate`) },
    'POST /v1/admin/store-products/{id}/deactivate': { actions: ['product.deactivate'], prepare: async () => send('POST', `/v1/admin/store-products/${await product(true)}/deactivate`) },
    // ─── People ───
    'POST /v1/admin/users/{id}/reveal-phone': {
      actions: ['user.view_phone'],
      prepare: async () => {
        const user = await person();
        await seedPhone(h, user.id, `+98912${String(1_000_000 + (counter += 1)).slice(-7)}`);
        return send('POST', `/v1/admin/users/${user.publicUid}/reveal-phone`);
      },
    },
    'POST /v1/admin/users/{id}/test-account': { actions: ['user.test_account'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/test-account`, { test: true }) },
    'POST /v1/admin/users/{id}/warn': { actions: ['user.warn'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/warn`, { reason: 'spam', reasonText: 'No spam.' }) },
    'POST /v1/admin/users/{id}/suspend': {
      actions: ['user.suspend'],
      prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/suspend`, { reason: 'harassment', reasonText: 'A week off.', endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
    },
    'POST /v1/admin/users/{id}/ban': { actions: ['user.ban'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/ban`, { reason: 'scam', reasonText: 'Banned.' }) },
    'POST /v1/admin/users/{id}/shadowban': { actions: ['user.shadowban'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/shadowban`, { reason: 'spam' }) },
    'POST /v1/admin/users/{id}/lift': {
      actions: ['user.lift'],
      prepare: async () => {
        const user = await person();
        const actionId = await seedAction(h, user.id, 3);
        return send('POST', `/v1/admin/users/${user.publicUid}/lift`, { actionId });
      },
    },
    'POST /v1/admin/users/{id}/revoke-sessions': { actions: ['user.revoke_sessions'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/revoke-sessions`) },
    'POST /v1/admin/users/{id}/delete': { actions: ['user.delete'], prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/delete`) },
    'PATCH /v1/admin/users/{id}/profile': {
      actions: ['user.rename'],
      prepare: async () => {
        const user = await person();
        return send('PATCH', `/v1/admin/users/${user.publicUid}/profile`, { displayName: 'Renamed Person', reason: 'offensive', version: await profileVersion(h, user.id) });
      },
    },
    // ─── Moderation ───
    'POST /v1/admin/moderation/texts/{id}/approve': {
      actions: ['text.approve'],
      prepare: async () => {
        const user = await person();
        const version = await seedTexts(h, user.id, { about: 'Waiting text', textState: 1 });
        return send('POST', `/v1/admin/moderation/texts/${user.publicUid}/approve`, { version });
      },
    },
    'POST /v1/admin/moderation/texts/{id}/reject': {
      actions: ['text.reject'],
      prepare: async () => {
        const user = await person();
        const version = await seedTexts(h, user.id, { about: 'Waiting text', textState: 1 });
        return send('POST', `/v1/admin/moderation/texts/${user.publicUid}/reject`, { version, reason: 'contact_details' });
      },
    },
    'POST /v1/admin/moderation/photos/{id}/approve': {
      actions: ['photo.approve'],
      prepare: async () => send('POST', `/v1/admin/moderation/photos/${await seedPhoto(h, (await person()).id, { status: 2 })}/approve`),
    },
    'POST /v1/admin/moderation/photos/{id}/reject': {
      actions: ['photo.reject'],
      prepare: async () => send('POST', `/v1/admin/moderation/photos/${await seedPhoto(h, (await person()).id, { status: 2 })}/reject`, { reason: 'nudity' }),
    },
    'POST /v1/admin/reports/{id}/evidence': { actions: ['report.view_chat'], prepare: async () => send('POST', `/v1/admin/reports/${await chatReport()}/evidence`) },
    'POST /v1/admin/reports/{id}/assign': { actions: ['report.assign'], prepare: async () => send('POST', `/v1/admin/reports/${await chatReport()}/assign`, { to: String(superadmin.account.id), from: null }) },
    'POST /v1/admin/reports/{id}/resolve': { actions: ['report.resolve'], prepare: async () => send('POST', `/v1/admin/reports/${await chatReport()}/resolve`, { resolution: 'content_removed' }) },
    'POST /v1/admin/reports/{id}/dismiss': { actions: ['report.dismiss'], prepare: async () => send('POST', `/v1/admin/reports/${await chatReport()}/dismiss`, { resolution: 'no_violation' }) },
    'POST /v1/admin/reports/{id}/hold-and-file': {
      actions: ['report.file', 'hold.create'],
      prepare: async () => send('POST', `/v1/admin/reports/${await chatReport()}/hold-and-file`, { authority: 'police', externalRef: unique('CASE-') }),
    },
    'POST /v1/admin/holds': { actions: ['hold.create'], prepare: async () => send('POST', '/v1/admin/holds', { user: (await person()).publicUid, kind: 'threat' }) },
    'POST /v1/admin/holds/{id}/release': {
      actions: ['hold.release'],
      prepare: async () => {
        const created = await send('POST', '/v1/admin/holds', { user: (await person()).publicUid, kind: 'authority' })();
        return send('POST', `/v1/admin/holds/${created.json<{ id: string }>().id}/release`, { reason: 'Case closed.' });
      },
    },
    'POST /v1/admin/appeals/{id}/uphold': { actions: ['appeal.uphold'], prepare: async () => send('POST', `/v1/admin/appeals/${await appeal()}/uphold`, { text: 'The ban stays.' }) },
    'POST /v1/admin/appeals/{id}/overturn': { actions: ['appeal.overturn'], prepare: async () => send('POST', `/v1/admin/appeals/${await appeal()}/overturn`, { text: 'We lifted it.' }) },
    // ─── Rules and records ───
    'POST /v1/admin/banned-terms': {
      actions: ['banned_term.create'],
      prepare: async () => send('POST', '/v1/admin/banned-terms', { term: unique('guardnew'), match: 'word', severity: 'flag', scope: ['about'] }),
    },
    'PATCH /v1/admin/banned-terms/{id}': { actions: ['banned_term.update'], prepare: async () => send('PATCH', `/v1/admin/banned-terms/${await bannedTerm()}`, { severity: 'refuse' }) },
    'DELETE /v1/admin/banned-terms/{id}': { actions: ['banned_term.delete'], prepare: async () => send('DELETE', `/v1/admin/banned-terms/${await bannedTerm()}`) },
    'POST /v1/admin/device-bans': {
      actions: ['device_ban.create'],
      prepare: async () => send('POST', '/v1/admin/device-bans', { from: 'user', user: (await person()).publicUid, kinds: ['device'], reason: 'Guard' }),
    },
    'DELETE /v1/admin/device-bans/{id}': {
      actions: ['device_ban.delete'],
      prepare: async () => {
        const created = await send('POST', '/v1/admin/device-bans', { from: 'user', user: (await person()).publicUid, kinds: ['device'], reason: 'Guard' })();
        return send('DELETE', `/v1/admin/device-bans/${created.json<{ items: { id: string }[] }>().items[0]!.id}`, { reason: 'Entered by mistake.' });
      },
    },
    'POST /v1/admin/audit/export': { actions: ['audit.export'], prepare: async () => send('POST', '/v1/admin/audit/export', { action: 'user.ban' }) },
    // A lookup by phone is audited: with its row refused, no hit is answered.
    'POST /v1/admin/users/search': {
      actions: ['user.search'],
      prepare: async () => {
        const u = await person();
        await seedPhone(h, u.id, '+989121110099');
        return send('POST', '/v1/admin/users/search', { q: '+989121110099' });
      },
    },
  };

  it('covers every admin write route, and names only actions the API writes', async () => {
    const doc = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, Record<string, unknown>> }>();
    const writes = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith('/v1/admin/') && !path.startsWith(SIGN_IN_PREFIX))
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
      .filter((route) => /^(POST|PUT|PATCH|DELETE) /.test(route))
      // A read that takes its search text in a body (no row is written).
      .filter((route) => route !== 'POST /v1/admin/device-bans/search')
      .sort();
    expect(Object.keys(AUDITED_WRITES).sort()).toEqual(writes);
    for (const entry of Object.values(AUDITED_WRITES)) for (const action of entry.actions) expect(auditActions).toContain(action);
  });

  it.each(Object.keys(AUDITED_WRITES))('%s: a refused audit row leaves everything as it was', async (route) => {
    const entry = AUDITED_WRITES[route]!;
    const call = await entry.prepare();
    await refuseAudit(db, ...entry.actions);
    const before = await digest();
    const published = realtime.published.length;
    const disconnected = realtime.disconnected.length;
    const queued = jobs.jobs.length;
    const denied = await denyKeys();
    const refused = await call();
    expect(refused.statusCode, refused.body).toBe(500);
    expect(await digest()).toEqual(before);
    expect(realtime.published.length).toBe(published);
    expect(realtime.disconnected.length).toBe(disconnected);
    expect(jobs.jobs.length).toBe(queued);
    expect(await denyKeys()).toBe(denied);

    await refuseAudit(db);
    const since = (await row<{ id: string | null }>(db, 'SELECT max(id)::text AS id FROM audit_log')).id ?? '0';
    const done = await call();
    expect(done.statusCode, done.body).toBeLessThan(300);
    const written = await row<{ actions: string[] | null }>(db, `SELECT array_agg(DISTINCT action ORDER BY action) AS actions FROM audit_log WHERE id > $1::bigint`, [since]);
    expect(written.actions ?? []).toEqual(expect.arrayContaining([entry.actions[0]]));
  });
});
