import { adminBrandSchema, type AdminBrand } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpIssuer } from '../src/admin/session.js';
import { call, migratedDatabase, row, statements, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The run-time brand (`/v1/admin/brand`): the first save makes the active
 * row with brand.json's id, a later one updates it and keeps what the panel
 * does not edit; null means brand.json's value; `/v1/config` and the
 * welcome follow at once.
 */

describe.skipIf(!hasInfrastructure)('admin: the run-time brand', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let superadmin: AdminSession;
  let adminRole: AdminSession;
  let reader: AdminSession;
  let media: string;
  let legalHost: string;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db);
    superadmin = await adminAs(h, 'superadmin');
    adminRole = await adminAs(h, 'admin');
    reader = await adminAs(h, 'analyst');
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) SELECT id, 'config.read' FROM admin_roles WHERE key = 'analyst' ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    const view = await get();
    media = view.mediaOrigin!;
    legalHost = h.app.brand.domains.legal;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const get = async (session: AdminSession = superadmin): Promise<AdminBrand> => adminBrandSchema.parse((await admin(h, '/v1/admin/brand', undefined, { token: session.accessToken })).json());
  const empty = { appName: null, supportEmail: null, privacyUrl: null, termsUrl: null, guidelinesUrl: null, childSafetyUrl: null, deleteAccountUrl: null, welcomeImages: [] as string[] };
  const put = (body: Record<string, unknown>, session: AdminSession = superadmin) => admin(h, '/v1/admin/brand', body, { token: session.accessToken, method: 'PUT' });
  const config = async () => {
    for (let i = 0; i < 300; i += 1) {
      const res = await call(h, '/v1/config?store=bazaar&locale=en');
      const body = res.json<{ appName: string; legal: { supportEmail: string }; welcome?: { images: string[] } }>();
      if (body) return body;
    }
    throw new Error('no config');
  };
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('not applied');
  };

  it('makes the active row on the first save, keeps other keys on the next, and the app reads the values', async () => {
    const first = await get();
    expect(first.saved).toEqual({});
    expect(first.build.appName.length).toBeGreaterThan(0);
    const res = await put({ ...empty, baseVersion: first.version, appName: 'Panel Name', supportEmail: 'help@example.org', welcomeImages: [`${media}/w1.jpg`] });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(3);
    const saved = adminBrandSchema.parse(res.json());
    expect(saved.saved).toEqual({ appName: 'Panel Name', supportEmail: 'help@example.org' });
    expect(saved.welcomeImages).toEqual([`${media}/w1.jpg`]);
    expect(saved.updatedBy?.id).toBe(String(superadmin.account.id));
    const active = await row<{ id: number; key: string; is_active: boolean }>(db, 'SELECT id, key, is_active FROM brands WHERE is_active');
    expect(active.key).toBe(h.app.brand.id);
    await waitFor(async () => (await config()).appName === 'Panel Name');
    expect((await config()).welcome?.images).toEqual([`${media}/w1.jpg`]);
    // A key the page does not edit survives the next save; null goes back to brand.json's.
    await db.sql.query(`UPDATE brands SET config = config || '{"planNames": {"plus": {"en": "Plus"}}}'::jsonb WHERE is_active`);
    const next = await get();
    const back = await put({ ...empty, baseVersion: next.version });
    expect(back.statusCode, back.body).toBe(200);
    expect((await row<{ config: Record<string, unknown> }>(db, 'SELECT config FROM brands WHERE is_active')).config).toEqual({ planNames: { plus: { en: 'Plus' } } });
    await waitFor(async () => (await config()).appName === h.app.brand.appName);
    const audit = await lastAudit(db, { action: 'config.update', targetType: 6 });
    expect(audit?.detail).toMatchObject({ key: 'brand', before: { appName: 'Panel Name' }, after: { welcomeImages: [] } });
  });

  it('refuses a stale form, a name with braces, a picture twice, another brand\'s row and a reader', async () => {
    const current = await get();
    expect((await put({ ...empty, baseVersion: 'A'.repeat(22) })).json()).toMatchObject({ reason: 'settings_changed' });
    expect((await put({ ...empty, baseVersion: current.version, appName: 'Hi {name}' })).statusCode).toBe(422);
    const twice = await put({ ...empty, baseVersion: current.version, welcomeImages: [`${media}/a.jpg`, `${media}/a.jpg`] });
    expect(twice.json()).toMatchObject({ errors: [{ pointer: '/welcomeImages/1', code: 'duplicate' }] });
    expect((await put({ ...empty, baseVersion: current.version, privacyUrl: 'http://example.org/p' })).statusCode).toBe(400);
    expect((await put({ ...empty, baseVersion: current.version }, reader)).statusCode).toBe(403);
    expect((await get(reader)).version).toBe(current.version);
    // Links on another host, pictures off the media origin.
    const offHost = await put({ ...empty, baseVersion: current.version, deleteAccountUrl: 'https://look-alike.example.net/delete' });
    expect(offHost.statusCode).toBe(422);
    expect(offHost.json()).toMatchObject({ errors: [{ pointer: '/deleteAccountUrl', code: 'host_not_allowed' }] });
    const tracker = await put({ ...empty, baseVersion: current.version, welcomeImages: [`${media}/ok.jpg`, 'https://tracker.example.net/p.jpg'] });
    expect(tracker.statusCode).toBe(422);
    expect(tracker.json()).toMatchObject({ errors: [{ pointer: '/welcomeImages/1', code: 'host_not_allowed' }] });
    // Another brand holds the active row: nothing is written.
    await db.sql.query(`UPDATE brands SET is_active = false WHERE is_active`);
    await db.sql.query(`INSERT INTO brands (id, key, config, is_active) VALUES (50, 'otherbrand', '{}', true)`);
    const other = await get();
    const mismatch = await put({ ...empty, baseVersion: other.version, appName: 'Mine' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ reason: 'brand_mismatch' });
    await db.sql.query(`DELETE FROM brands WHERE id = 50`);
    await db.sql.query(`UPDATE brands SET is_active = true WHERE key = $1`, [h.app.brand.id]);
  });

  it('takes a Persian name with a half-space, refuses invisible controls, and the TOTP issuer follows the name', async () => {
    const name = 'هم\u200cدم';
    const res = await put({ ...empty, baseVersion: (await get()).version, appName: name });
    expect(res.statusCode, res.body).toBe(200);
    expect(adminBrandSchema.parse(res.json()).saved.appName).toBe(name);
    await waitFor(async () => (await config()).appName === name);
    expect(totpIssuer(h.app)).toBe(name);
    for (const refused of ['App\u202e', 'A\u200eB', 'Ap\ufeffp', 'Ap\u2066p']) {
      const bad = await put({ ...empty, baseVersion: (await get()).version, appName: refused });
      expect(bad.statusCode, JSON.stringify(refused)).toBe(422);
      expect(bad.json()).toMatchObject({ errors: [{ pointer: '/appName', code: 'invalid' }] });
    }
    expect((await put({ ...empty, baseVersion: (await get()).version })).statusCode).toBe(200);
  });

  it('lets the admin role change the name and pictures but not the legal links or the support e-mail', async () => {
    const start = await get();
    const named = await put({ ...empty, baseVersion: start.version, appName: 'Admin Name', welcomeImages: [`${media}/a1.jpg`] }, adminRole);
    expect(named.statusCode, named.body).toBe(200);
    const after = adminBrandSchema.parse(named.json());
    const keep = { ...empty, appName: 'Admin Name', welcomeImages: [`${media}/a1.jpg`] };
    for (const [key, value] of [
      ['deleteAccountUrl', `https://${legalHost}/delete-elsewhere`],
      ['privacyUrl', `https://${legalHost}/privacy-2`],
      ['supportEmail', 'other@example.org'],
    ] as const) {
      const refused = await put({ ...keep, baseVersion: after.version, [key]: value }, adminRole);
      expect(refused.statusCode, key).toBe(403);
      expect(refused.json()).toMatchObject({ reason: 'role' });
    }
    expect((await get()).version).toBe(after.version);
    // The superadmin (config.legal, with the second factor) may.
    const legal = await put({ ...keep, baseVersion: after.version, deleteAccountUrl: `https://${legalHost}/delete-elsewhere` });
    expect(legal.statusCode, legal.body).toBe(200);
    expect(adminBrandSchema.parse(legal.json()).saved.deleteAccountUrl).toBe(`https://${legalHost}/delete-elsewhere`);
    // Saving the same legal values again needs no more than config.write.
    const unchangedLegal = await put({ ...keep, appName: 'Admin Name 2', deleteAccountUrl: `https://${legalHost}/delete-elsewhere`, baseVersion: adminBrandSchema.parse(legal.json()).version }, adminRole);
    expect(unchangedLegal.statusCode, unchangedLegal.body).toBe(200);
    expect((await put({ ...empty, baseVersion: (await get()).version })).statusCode).toBe(200);
  });

  it('keeps the other keys of the brand\'s own row when it was deactivated by hand', async () => {
    await db.sql.query(`UPDATE brands SET config = config || '{"colors": {"brand": {"light": "#123456"}}, "planNames": {"gold": {"en": "Gold"}}}'::jsonb WHERE key = $1`, [h.app.brand.id]);
    await db.sql.query(`UPDATE brands SET is_active = false WHERE key = $1`, [h.app.brand.id]);
    const view = await get();
    const res = await put({ ...empty, baseVersion: view.version, appName: 'Back Again' });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await row<{ config: Record<string, unknown>; is_active: boolean }>(db, 'SELECT config, is_active FROM brands WHERE key = $1', [h.app.brand.id]);
    expect(stored.is_active).toBe(true);
    expect(stored.config).toMatchObject({ appName: 'Back Again', colors: { brand: { light: '#123456' } }, planNames: { gold: { en: 'Gold' } } });
    // The inactive row is part of the version: a form built before it changed is stale.
    await db.sql.query(`UPDATE brands SET is_active = false WHERE key = $1`, [h.app.brand.id]);
    const before = await get();
    await db.sql.query(`UPDATE brands SET config = config || '{"planNames": {"gold": {"en": "Gold 2"}}}'::jsonb WHERE key = $1`, [h.app.brand.id]);
    expect((await put({ ...empty, baseVersion: before.version })).json()).toMatchObject({ reason: 'settings_changed' });
    await db.sql.query(`UPDATE brands SET is_active = true WHERE key = $1`, [h.app.brand.id]);
  });
});
