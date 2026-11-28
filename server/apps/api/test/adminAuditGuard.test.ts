import { randomUUID } from 'node:crypto';
import { adminGrantResultSchema, adminPlanSchema, adminProductSchema, auditActions, type AuditAction } from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier, generateOriginsKeyPair } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { migratedDatabase, row, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import {
  admin,
  adminAs,
  installAuditFailure,
  installTableDigest,
  refuseAudit,
  seedAdmin,
  signIn,
  startAdminHarness,
  tableDigest,
  type AdminHarness,
  type AdminSession,
  type SignedIn,
} from './adminSupport.js';
import { profileVersion, seedAction, seedAppeal, seedEvidenceReport, seedMatch, seedPhone, seedPhoto, seedTexts } from './moderationSupport.js';
import { seedPurchase, type SeededPurchase } from './revenueSupport.js';
import { hasInfrastructure } from './support.js';
import { deadLetter, failJobs, failedKey } from './systemSupport.js';

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
  /**
   * What the write changes outside the tables, the realtime side, the job
   * producer and the deny list (a Valkey stream, BullMQ's sets): read before
   * and after the refused call, which must leave it as it was.
   */
  unchanged?: () => Promise<unknown>;
}

const SIGN_IN_PREFIX = '/v1/admin/auth/';

describe.skipIf(!hasInfrastructure)('admin: every write is audited in its transaction (AC2)', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  // Stores for the purchase actions (every admin action offered).
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
  let superadmin: AdminSession;
  let counter = 0;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    const pair = generateOriginsKeyPair();
    h = await startAdminHarness(db, { ORIGINS_SIGNING_KEY: pair.privateKey, ORIGINS_SIGNING_KID: 'o1' }, { jobs, realtime, store: { verifiers: { play, bazaar } } });
    superadmin = await adminAs(h, 'superadmin');
    await installTableDigest(db);
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
    return tableDigest(db);
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

  async function purchase(kind: 'subscription' | 'consumable' = 'subscription'): Promise<SeededPurchase> {
    return seedPurchase(h, { user: await person(), kind, fakes: { play, bazaar } });
  }

  async function grant(): Promise<string> {
    const res = await send('POST', '/v1/admin/grants', { requestId: randomUUID(), user: (await person()).publicUid, plan: 'plus', days: 3, reason: 'Guard' })();
    if (res.statusCode !== 201) throw new Error(`grant ${res.statusCode}: ${res.body}`);
    return adminGrantResultSchema.parse(res.json()).grant.id;
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

    // dashboard

    // content

    // revenue
    // A hit by order id links a purchase to a person: audited, and with its row refused nothing is answered.
    'POST /v1/admin/purchases/search': { actions: ['purchase.search'], prepare: async () => send('POST', '/v1/admin/purchases/search', { q: (await purchase()).orderId }) },
    'POST /v1/admin/purchases/{id}/recheck': { actions: ['purchase.recheck'], prepare: async () => send('POST', `/v1/admin/purchases/${(await purchase()).id}/recheck`, { note: 'Guard' }) },
    'POST /v1/admin/purchases/{id}/cancel': { actions: ['purchase.cancel'], prepare: async () => send('POST', `/v1/admin/purchases/${(await purchase()).id}/cancel`, { from: 'active', note: 'Guard' }) },
    'POST /v1/admin/purchases/{id}/refund': { actions: ['purchase.refund'], prepare: async () => send('POST', `/v1/admin/purchases/${(await purchase('consumable')).id}/refund`, { from: 'purchased', note: 'Guard' }) },
    'POST /v1/admin/purchases/{id}/revoke': { actions: ['purchase.revoke'], prepare: async () => send('POST', `/v1/admin/purchases/${(await purchase()).id}/revoke`, { from: 'active', note: 'Guard' }) },
    'POST /v1/admin/grants': {
      actions: ['grant.create'],
      prepare: async () => send('POST', '/v1/admin/grants', { requestId: randomUUID(), user: (await person()).publicUid, plan: 'plus', days: 2, reason: 'Guard' }),
    },
    'DELETE /v1/admin/grants/{id}': { actions: ['grant.revoke'], prepare: async () => send('DELETE', `/v1/admin/grants/${await grant()}`, { reason: 'Guard' }) },
    'POST /v1/admin/users/{id}/wallet-adjust': {
      actions: ['wallet.gift'],
      prepare: async () => send('POST', `/v1/admin/users/${(await person()).publicUid}/wallet-adjust`, { kind: 'gift', requestId: randomUUID(), item: 'boost', quantity: 2, note: 'Guard' }),
    },

    // growth

    // app
    'PUT /v1/admin/config/{key}': {
      actions: ['config.update'],
      prepare: async () => {
        const read = (await admin(h, '/v1/admin/config?keys=calls.enabled', undefined, { token: superadmin.accessToken })).json<{ items: { value: { audio: boolean; video: boolean }; version: string }[] }>();
        const item = read.items[0]!;
        return send('PUT', '/v1/admin/config/calls.enabled', { value: { ...item.value, audio: !item.value.audio }, baseVersion: item.version });
      },
    },
    'PUT /v1/admin/brand': {
      actions: ['config.update'],
      prepare: async () => {
        const read = (await admin(h, '/v1/admin/brand', undefined, { token: superadmin.accessToken })).json<{ version: string }>();
        const name = unique('Guard ');
        return send('PUT', '/v1/admin/brand', {
          baseVersion: read.version,
          appName: name,
          supportEmail: null,
          privacyUrl: null,
          termsUrl: null,
          guidelinesUrl: null,
          childSafetyUrl: null,
          deleteAccountUrl: null,
          welcomeImages: [],
        });
      },
    },
    'PUT /v1/admin/providers/{kind}': {
      actions: ['config.update'],
      prepare: async () => {
        const read = (await admin(h, '/v1/admin/providers', undefined, { token: superadmin.accessToken })).json<{ items: { kind: string; version: string }[] }>();
        const version = read.items.find((item) => item.kind === 'kavenegar')!.version;
        return send('PUT', '/v1/admin/providers/kavenegar', { kind: 'kavenegar', baseVersion: version, enabled: true, settings: { template: 'guard' }, secrets: { apiKey: unique('guard-key-') } });
      },
    },
    'DELETE /v1/admin/providers/{kind}': {
      actions: ['config.update'],
      prepare: async () => {
        const read = () => admin(h, '/v1/admin/providers', undefined, { token: superadmin.accessToken }).then((r) => r.json<{ items: { kind: string; version: string }[] }>().items.find((item) => item.kind === 'telnyx')!.version);
        const put = await send('PUT', '/v1/admin/providers/telnyx', { kind: 'telnyx', baseVersion: await read(), enabled: true, settings: { verifyProfileId: 'guard-profile-1' }, secrets: { apiKey: unique('guard-telnyx-') } })();
        if (put.statusCode !== 200) throw new Error(`telnyx ${put.statusCode}: ${put.body}`);
        return send('DELETE', '/v1/admin/providers/telnyx', { baseVersion: await read() });
      },
    },
    'POST /v1/admin/users/{id}/approve': {
      actions: ['profile.approve'],
      prepare: async () => send('POST', `/v1/admin/users/${(await person({ status: 2 })).publicUid}/approve`, { from: 'waiting' }),
    },
    'POST /v1/admin/users/{id}/needs-changes': {
      actions: ['profile.needs_changes'],
      prepare: async () => send('POST', `/v1/admin/users/${(await person({ status: 2 })).publicUid}/needs-changes`, { from: 'waiting', reasonText: 'Add a photo of your face.' }),
    },
    'POST /v1/admin/users/{id}/reject': {
      actions: ['profile.reject'],
      prepare: async () => send('POST', `/v1/admin/users/${(await person({ status: 2 })).publicUid}/reject`, { from: 'waiting', reasonText: 'Not a real person.' }),
    },

    // support

    // system
    'PUT /v1/admin/roles/{key}/permissions': {
      actions: ['role.update'],
      prepare: async () => {
        // A role of the guard's own with a signed-in holder: taking a permission away signs the holder out.
        await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (46, 'guard_role', '{"en": "Guard"}') ON CONFLICT (key) DO NOTHING`);
        await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (46, 'users.read'), (46, 'reports.read') ON CONFLICT DO NOTHING`);
        await h.app.adminAuth.roles.reload();
        await signIn(h, await seedAdmin(h, { roles: ['guard_role'] }));
        return send('PUT', '/v1/admin/roles/guard_role/permissions', { grants: ['users.read'], base: ['reports.read', 'users.read'] });
      },
    },
    'POST /v1/admin/system/dead-letters/delete': {
      actions: ['system.dead_letters_delete'],
      prepare: async () => {
        const id = await deadLetter(h, 'like', { id: `${Date.now()}-0`, fields: { id: '1', a: '2', t: '3', k: '1' } });
        return send('POST', '/v1/admin/system/dead-letters/delete', { stream: 'like', ids: [id] });
      },
      unchanged: () => h.redis.xlen(`${h.prefix}wb:like:dead`),
    },
    'POST /v1/admin/system/jobs/retry': {
      actions: ['system.jobs_retry'],
      prepare: async () => {
        await failJobs(h, 'photo', 'process', [unique('process.9')]);
        return send('POST', '/v1/admin/system/jobs/retry', { queue: 'photo', name: 'process' });
      },
      unchanged: async () => ({ failed: await h.redis.zrange(failedKey(h, 'photo'), '0', '-1'), waiting: await h.redis.lrange(`${h.prefix}bull:photo:wait`, '0', '-1') }),
    },
    'POST /v1/admin/system/jobs/remove': {
      actions: ['system.jobs_remove'],
      prepare: async () => {
        await failJobs(h, 'push', 'send', [unique('send.guard.')]);
        return send('POST', '/v1/admin/system/jobs/remove', { queue: 'push', name: 'send' });
      },
      unchanged: () => h.redis.zrange(failedKey(h, 'push'), '0', '-1'),
    },
    'POST /v1/admin/system/tasks/run': {
      actions: ['system.task_run'],
      prepare: async () => send('POST', '/v1/admin/system/tasks/run', { queue: 'maint', name: 'partitions' }),
    },
  };

  /**
   * Reads that write no audit row and no other record (decided 2026-11-27):
   * a person's conversations and message requests on the user page. They are GET routes, which
   * this guard does not cover; the list keeps them from becoming writes,
   * and from quietly gaining an audit row, without this file changing.
   */
  const UNAUDITED_READS = ['GET /v1/admin/users/{id}/chats', 'GET /v1/admin/users/{id}/chats/{conversationId}', 'GET /v1/admin/users/{id}/chat-requests'] as const;

  it('keeps the unaudited reads to GET, and reading them writes no row anywhere', async () => {
    const doc = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, Record<string, unknown>> }>();
    for (const route of UNAUDITED_READS) {
      const [method, path] = route.split(' ') as [string, string];
      expect(Object.keys(doc.paths[path] ?? {}), route).toEqual([method.toLowerCase()]);
    }
    const subject = await person();
    const other = await person();
    const matchId = await seedMatch(h, subject.id, other.id);
    await db.sql.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, 'A message')`, [matchId, h.app.ids.nextId(), other.id]);
    await db.sql.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES ($1, $2, $3, 'A request')`, [h.app.ids.nextId(), other.id, subject.id]);
    const before = await digest();
    const queued = jobs.jobs.length;
    const published = realtime.published.length;
    for (const url of [`/v1/admin/users/${subject.publicUid}/chats`, `/v1/admin/users/${subject.publicUid}/chats/${matchId}`, `/v1/admin/users/${subject.publicUid}/chat-requests`]) {
      const res = await admin(h, url, undefined, { token: superadmin.accessToken });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await digest()).toEqual(before);
    expect(jobs.jobs.length).toBe(queued);
    expect(realtime.published.length).toBe(published);
  });

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
    const outside = await entry.unchanged?.();
    const refused = await call();
    expect(refused.statusCode, refused.body).toBe(500);
    expect(await digest()).toEqual(before);
    expect(realtime.published.length).toBe(published);
    expect(realtime.disconnected.length).toBe(disconnected);
    expect(jobs.jobs.length).toBe(queued);
    expect(await denyKeys()).toBe(denied);
    if (entry.unchanged) expect(await entry.unchanged()).toEqual(outside);

    await refuseAudit(db);
    const since = (await row<{ id: string | null }>(db, 'SELECT max(id)::text AS id FROM audit_log')).id ?? '0';
    const done = await call();
    expect(done.statusCode, done.body).toBeLessThan(300);
    const written = await row<{ actions: string[] | null }>(db, `SELECT array_agg(DISTINCT action ORDER BY action) AS actions FROM audit_log WHERE id > $1::bigint`, [since]);
    expect(written.actions ?? []).toEqual(expect.arrayContaining([entry.actions[0]]));
  });
});
