import { deflateRawSync } from 'node:zlib';
import { accountView } from '@app/db';
import { adminAppearanceSchema, configSchema, effectiveTemplate, settingsSchema, uiTemplates, type AdminAppearance } from '@app/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, installAuditFailure, refuseAudit, seedAdmin, signIn, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The visual templates, end to end on PostgreSQL and Valkey: `ui` in
 * `GET /v1/config` (0 statements, an ETag that moves with an admin change),
 * a person's choice in settings (validated, stored with the other switches
 * at no extra statement, kept when the panel stops offering it), and the
 * admin routes (permissions, the default always offered, the audit row in
 * the same transaction, no row for a no-op, a second API process that
 * follows through `cfg:changed`).
 */

const CONFIG_TARGET = 6;

describe.skipIf(!hasInfrastructure)('visual templates', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let second: Harness | null = null;
  const tokens = new Map<string, string>();
  const adminIds = new Map<string, number>();

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db);
    for (const role of ['superadmin', 'admin', 'moderator', 'support', 'finance', 'marketing', 'analyst']) {
      const seeded = await seedAdmin(h, { roles: [role] });
      adminIds.set(role, seeded.id);
      tokens.set(role, (await signIn(h, seeded)).accessToken);
    }
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await h?.close();
    await db?.drop();
  });

  function token(role = 'superadmin'): string {
    const t = tokens.get(role);
    if (!t) throw new Error(`no admin with ${role}`);
    return t;
  }

  /** A read, or a save built on the current version (unless the body names one), as the panel sends it. */
  async function send(method: 'GET' | 'PUT', body?: unknown, role = 'superadmin'): Promise<LightMyRequestResponse> {
    if (method === 'PUT' && typeof body === 'object' && body !== null && !('baseVersion' in body)) {
      body = { baseVersion: await currentVersion(), ...body };
    }
    return admin(h, '/v1/admin/appearance', body, { token: token(role), method });
  }

  async function currentVersion(): Promise<string> {
    const res = await admin(h, '/v1/admin/appearance', undefined, { token: token('superadmin'), method: 'GET' });
    return adminAppearanceSchema.parse(res.json()).version;
  }

  /** The view without its version (which is a hash of the stored value). */
  const shown = (res: LightMyRequestResponse) => {
    const { version: _version, ...rest } = appearance(res);
    return rest;
  };
  const DESIGN_NEON = { start: '#7B2BFF', mid: '#C21FD0', end: '#E0157A' };

  /** Every process of this harness has loaded the configuration the last write announced. */
  async function settled(target: Harness = h): Promise<void> {
    const version = Number((await h.redis.get(`${h.prefix}cfg:v`)) ?? 0);
    for (let i = 0; i < 500; i += 1) {
      if ((target.app.cfg.peek()?.version ?? -1) >= version) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`configuration version ${version} was not loaded`);
  }

  async function auditRows(): Promise<{ target_type: number; target_id: string | null; admin_id: number | null; detail: Record<string, unknown> }[]> {
    const { rows } = await db.sql.query(`SELECT target_type, target_id::text, admin_id, detail FROM audit_log WHERE action = 'config.update' AND detail ->> 'key' = 'ui.templates' ORDER BY id`);
    return rows as never;
  }

  const stored = async () => (await row<{ value: unknown }>(db, `SELECT value FROM app_config WHERE key = 'ui.templates'`)).value;
  const version = async () => Number((await h.redis.get(`${h.prefix}cfg:v`)) ?? 0);
  const appearance = (res: LightMyRequestResponse): AdminAppearance => adminAppearanceSchema.parse(res.json());
  const config = async (target: Harness = h, headers: Record<string, string> = {}) => call(target, '/v1/config?store=bazaar&locale=fa', { headers });

  async function seedPerson(name: string): Promise<SeededUser> {
    return seedUser(h, { name });
  }

  it('serves the seeded templates in GET /v1/config, from memory', async () => {
    const res = await config();
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    const doc = configSchema.strict().parse(res.json());
    expect(doc.ui).toEqual({ defaultTemplate: 'neon', templates: ['neon', 'white'] });
  });

  it('lets the owner and admins read and save; every other role is refused, and nobody without a token', async () => {
    for (const role of ['superadmin', 'admin']) {
      const res = await send('GET', undefined, role);
      expect(res.statusCode, role).toBe(200);
      expect(statements(res)).toBe(1);
      expect(shown(res)).toEqual({
        defaultTemplate: 'neon',
        templates: [{ id: 'neon', offered: true }, { id: 'white', offered: true }],
        neonGradient: DESIGN_NEON,
      });
    }
    for (const role of ['moderator', 'support', 'finance', 'marketing', 'analyst']) {
      expect((await send('GET', undefined, role)).statusCode, `${role} read`).toBe(403);
      const put = await send('PUT', { defaultTemplate: 'white', offered: ['neon', 'white'] }, role);
      expect(put.statusCode, `${role} save`).toBe(403);
      expect(put.json()).toMatchObject({ code: 'forbidden' });
    }
    expect((await admin(h, '/v1/admin/appearance')).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/appearance', { baseVersion: await currentVersion(), defaultTemplate: 'white', offered: ['white'] }, { method: 'PUT' })).statusCode).toBe(401);
    expect(await stored()).toEqual({ default: 'neon', offered: ['neon', 'white'] });
    expect(await auditRows()).toEqual([]);
  });

  it('refuses unknown ids, a default that is not offered, repeats and unknown members', async () => {
    const cases: [unknown, number, string][] = [
      [{ defaultTemplate: 'sand', offered: ['neon'] }, 400, 'validation_failed'],
      [{ defaultTemplate: 'neon', offered: ['neon', 'sand'] }, 400, 'validation_failed'],
      [{ defaultTemplate: 'neon', offered: ['neon', 'neon'] }, 400, 'validation_failed'],
      [{ defaultTemplate: 'neon', offered: [] }, 400, 'validation_failed'],
      [{ defaultTemplate: 'neon', offered: ['neon'], hidden: ['white'] }, 400, 'validation_failed'],
      [{ offered: ['neon'] }, 400, 'validation_failed'],
      [{ baseVersion: '', defaultTemplate: 'neon', offered: ['neon'] }, 400, 'validation_failed'],
      [{ baseVersion: 'not a version!', defaultTemplate: 'neon', offered: ['neon'] }, 400, 'validation_failed'],
      [{ defaultTemplate: 'white', offered: ['neon'] }, 422, 'field_invalid'],
      [{ baseVersion: 'AAAAAAAAAAAAAAAAAAAAAA', defaultTemplate: 'white', offered: ['white'] }, 409, 'conflict'],
    ];
    for (const [body, status, code] of cases) {
      const res = await send('PUT', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
      expect(res.json()).toMatchObject({ code });
    }
    expect((await send('PUT', { defaultTemplate: 'white', offered: ['neon'] })).json()).toMatchObject({
      errors: [{ pointer: '/offered', code: 'default_not_offered' }],
    });
    expect(await stored()).toEqual({ default: 'neon', offered: ['neon', 'white'] });
    expect(await auditRows()).toEqual([]);
  });

  it('saves a change with its audit row, announces it, and GET /v1/config follows with a new ETag at 0 statements', async () => {
    const before = await config();
    const etag = String(before.headers.etag);
    const v = await version();

    const res = await send('PUT', { defaultTemplate: 'white', offered: ['white', 'neon'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(3);
    expect(shown(res)).toEqual({
      defaultTemplate: 'white',
      templates: [{ id: 'neon', offered: true }, { id: 'white', offered: true }],
      neonGradient: DESIGN_NEON,
    });
    // The answer names the new version, which a read now gives too.
    expect(appearance(res).version).toBe(await currentVersion());
    // Stored in display order, whatever order was sent.
    expect(await stored()).toEqual({ default: 'white', offered: ['neon', 'white'] });
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      target_type: CONFIG_TARGET,
      target_id: null,
      admin_id: adminIds.get('superadmin'),
      detail: { key: 'ui.templates', before: { default: 'neon', offered: ['neon', 'white'] }, after: { default: 'white', offered: ['neon', 'white'] } },
    });
    expect(await version()).toBe(v + 1);
    expect((await row<{ updated_by: number }>(db, `SELECT updated_by FROM app_config WHERE key = 'ui.templates'`)).updated_by).toBe(adminIds.get('superadmin'));

    await settled();
    const after = await config(h, { 'if-none-match': etag });
    expect(after.statusCode).toBe(200);
    expect(statements(after)).toBe(0);
    expect(after.headers.etag).not.toBe(etag);
    expect(configSchema.parse(after.json()).ui).toEqual({ defaultTemplate: 'white', templates: ['neon', 'white'] });
    const again = await config(h, { 'if-none-match': String(after.headers.etag) });
    expect(again.statusCode).toBe(304);
    expect(statements(again)).toBe(0);
    // The panel reads its own save.
    expect(appearance(await send('GET', undefined, 'admin')).defaultTemplate).toBe('white');
  });

  it('writes no row and announces nothing when the save changes nothing', async () => {
    const v = await version();
    const count = (await auditRows()).length;
    const res = await send('PUT', { defaultTemplate: 'white', offered: ['neon', 'white'] }, 'admin');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect((await auditRows()).length).toBe(count);
    expect(await version()).toBe(v);
  });

  it('rolls the change back when its audit row cannot be written', async () => {
    const v = await version();
    await refuseAudit(db, 'config.update');
    try {
      const res = await send('PUT', { defaultTemplate: 'neon', offered: ['neon'] });
      expect(res.statusCode).toBe(500);
    } finally {
      await refuseAudit(db);
    }
    expect(await stored()).toEqual({ default: 'white', offered: ['neon', 'white'] });
    expect(await version()).toBe(v);
  });

  it('draws neon with the stops of the brand the deployment is built with, the design’s for a stop it leaves out', async () => {
    const { loadBrand } = await import('@app/config');
    const built = loadBrand();
    const recoloured = await startAdminHarness(db, { REDIS_KEY_PREFIX: h.prefix }, {
      accountServices: { brand: { ...built, colors: { ...built.colors, gradientStart: { light: '#008877', dark: '#11ccaa' }, gradientEnd: { light: '#123456', dark: '#2255FF' } } } },
    });
    try {
      const viewer = await signIn(recoloured, await seedAdmin(recoloured, { roles: ['admin'] }));
      const res = await admin(recoloured, '/v1/admin/appearance', undefined, { token: viewer.accessToken, method: 'GET' });
      expect(res.statusCode, res.body).toBe(200);
      expect(appearance(res).neonGradient).toEqual({ start: '#11CCAA', mid: DESIGN_NEON.mid, end: '#2255FF' });
    } finally {
      await recoloured.close();
    }
  });

  it('refuses a save built on a value another admin changed meanwhile, so it never silently reverts that change', async () => {
    const base = await currentVersion();
    const rows = (await auditRows()).length;
    // Admin A and admin B open the page at the same version; A saves first.
    const first = await send('PUT', { baseVersion: base, defaultTemplate: 'neon', offered: ['neon', 'white'] });
    expect(first.statusCode, first.body).toBe(200);
    const v = await version();
    // B's form still shows the old value: refused, nothing written or announced.
    const stale = await send('PUT', { baseVersion: base, defaultTemplate: 'white', offered: ['white'] }, 'admin');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict' });
    expect(statements(stale)).toBeLessThanOrEqual(1);
    expect(await stored()).toEqual({ default: 'neon', offered: ['neon', 'white'] });
    expect((await auditRows()).length).toBe(rows + 1);
    expect(await version()).toBe(v);
    // B loads the newer value and saves from there.
    const fresh = await send('GET', undefined, 'admin');
    expect(appearance(fresh)).toMatchObject({ version: appearance(first).version, defaultTemplate: 'neon' });
    const again = await send('PUT', { baseVersion: appearance(fresh).version, defaultTemplate: 'white', offered: ['neon', 'white'] }, 'admin');
    expect(again.statusCode, again.body).toBe(200);
    expect(await stored()).toEqual({ default: 'white', offered: ['neon', 'white'] });
    // The same value always has the same version: a save that changes nothing keeps it.
    expect(appearance(again).version).toBe(base);
    const noop = await send('PUT', { baseVersion: base, defaultTemplate: 'white', offered: ['neon', 'white'] }, 'admin');
    expect(noop.statusCode).toBe(200);
    expect(appearance(noop).version).toBe(base);
    await settled();
  });

  it('stores a person’s choice with the other switches, at no extra statement, and validates it', async () => {
    const person = await seedPerson('Tara');
    const first = await call(h, '/v1/me/settings', { token: person.token });
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBeLessThanOrEqual(1);
    expect(settingsSchema.strict().parse(first.json()).template).toBe('default');
    const warm = await call(h, '/v1/me/settings', { token: person.token });
    expect(statements(warm)).toBe(0);

    // A switch alone and the template alone cost the same (each after a warm read of the view): the view, the write.
    const hide = await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { hideAge: true } });
    expect(hide.statusCode).toBe(200);
    expect(statements(await call(h, '/v1/me/settings', { token: person.token }))).toBe(1);
    const pick = await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'neon' } });
    expect(pick.statusCode, pick.body).toBe(200);
    expect(statements(pick)).toBe(statements(hide));
    expect(statements(pick)).toBe(1);
    // Cold (the view changed with the write): one more statement, still within the route's budget of 3.
    const both = await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'white', hideDistance: true } });
    expect(statements(both)).toBe(2);
    expect(settingsSchema.parse(both.json())).toMatchObject({ hideDistance: true, template: 'white' });
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'neon', hideDistance: false } })).statusCode).toBe(200);
    expect(settingsSchema.strict().parse(pick.json())).toMatchObject({ hideAge: true, template: 'neon' });
    expect((await row<{ ui_template: number }>(db, 'SELECT ui_template FROM profiles WHERE user_id = $1', [person.id])).ui_template).toBe(1);

    // Everywhere the settings are read: GET /v1/me/settings and the own profile of GET /v1/me.
    expect(settingsSchema.parse((await call(h, '/v1/me/settings', { token: person.token })).json()).template).toBe('neon');
    const me = (await call(h, '/v1/me', { token: person.token })).json<{ profile: { settings: { template: string } } }>();
    expect(me.profile.settings.template).toBe('neon');

    // Unknown ids are refused by the usual body validation; nothing changes.
    for (const template of ['sand', 'NEON', '', 3]) {
      const bad = await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template } });
      expect(bad.statusCode, String(template)).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'validation_failed' });
    }
    expect((await row<{ ui_template: number }>(db, 'SELECT ui_template FROM profiles WHERE user_id = $1', [person.id])).ui_template).toBe(1);

    // The same value again writes nothing (the row keeps its time); "default" goes back to the panel's.
    const stamp = (await row<{ at: string }>(db, 'SELECT updated_at::text AS at FROM profiles WHERE user_id = $1', [person.id])).at;
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'neon' } })).statusCode).toBe(200);
    expect((await row<{ at: string }>(db, 'SELECT updated_at::text AS at FROM profiles WHERE user_id = $1', [person.id])).at).toBe(stamp);
    const reset = await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'default' } });
    expect(settingsSchema.parse(reset.json()).template).toBe('default');
    expect((await row<{ ui_template: number }>(db, 'SELECT ui_template FROM profiles WHERE user_id = $1', [person.id])).ui_template).toBe(0);

    // An account without a profile yet reads the default choice.
    const fresh = await seedUser(h, { status: 1 });
    expect(settingsSchema.parse((await call(h, '/v1/me/settings', { token: fresh.token })).json()).template).toBe('default');
  });

  it('never reads a view that an older build cached under the same version (a rolling deploy)', async () => {
    const person = await seedPerson('Shirin');
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'white' } })).statusCode).toBe(200);
    const mev = Number(await h.redis.get(h.app.keys.meVersion(person.id)));
    // An older process missed, built the view with the new account_view() and cached it without the key it does not know.
    const built = (await accountView(db.sql, person.id)) as unknown as { kind: string; view: { profile: Record<string, unknown> } };
    delete built.view.profile['uiTemplate'];
    await h.app.cache.set(h.app.keys.raw('me', person.id, mev), deflateRawSync(Buffer.from(JSON.stringify(built))), 'EX', 3_600);

    const read = await call(h, '/v1/me/settings', { token: person.token });
    expect(read.statusCode).toBe(200);
    expect(settingsSchema.parse(read.json()).template).toBe('white');
    expect(statements(read)).toBe(1);
    // Cached under this build's own key: warm from now on.
    const again = await call(h, '/v1/me/settings', { token: person.token });
    expect(statements(again)).toBe(0);
    expect(settingsSchema.parse(again.json()).template).toBe('white');
  });

  it('keeps a stored choice when the panel stops offering it; the app then shows the default, and the choice again once offered', async () => {
    const person = await seedPerson('Nima');
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: person.token, body: { template: 'neon' } })).statusCode).toBe(200);
    expect((await send('PUT', { defaultTemplate: 'white', offered: ['white'] })).statusCode).toBe(200);
    await settled();
    const ui = configSchema.parse((await config()).json()).ui;
    expect(ui).toEqual({ defaultTemplate: 'white', templates: ['white'] });
    const choice = settingsSchema.parse((await call(h, '/v1/me/settings', { token: person.token })).json()).template;
    expect(choice).toBe('neon');
    expect(effectiveTemplate(choice, ui, uiTemplates)).toBe('white');
    // A later change of the default reaches everyone on "default" (and this choice, while not offered).
    const other = await seedPerson('Lale');
    const theirs = settingsSchema.parse((await call(h, '/v1/me/settings', { token: other.token })).json()).template;
    expect(effectiveTemplate(theirs, ui, uiTemplates)).toBe('white');

    expect((await send('PUT', { defaultTemplate: 'white', offered: ['neon', 'white'] })).statusCode).toBe(200);
    await settled();
    const back = configSchema.parse((await config()).json()).ui;
    expect(effectiveTemplate(choice, back, uiTemplates)).toBe('neon');
    expect(effectiveTemplate(theirs, back, uiTemplates)).toBe('white');
  });

  it('reaches a second API process through cfg:changed, without a restart, at 0 statements', async () => {
    second = await startHarness(db, { REDIS_KEY_PREFIX: h.prefix });
    await settled(second);
    expect(configSchema.parse((await config(second)).json()).ui.defaultTemplate).toBe('white');
    const etag = String((await config(second)).headers.etag);

    expect((await send('PUT', { defaultTemplate: 'neon', offered: ['neon', 'white'] })).statusCode).toBe(200);
    await settled(second);
    const res = await config(second, { 'if-none-match': etag });
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    expect(configSchema.parse(res.json()).ui).toEqual({ defaultTemplate: 'neon', templates: ['neon', 'white'] });
    expect(res.headers.etag).not.toBe(etag);
  });

  it('serves a save whose announcement failed at once in this process, and announces it once Valkey answers again', async () => {
    if (!second) throw new Error('the second process starts in the test before');
    const other = second;
    await settled(other);
    const v = await version();
    const etag = String((await config()).headers.etag);
    const cfgKey = `${h.prefix}cfg:v`;
    const redis = h.app.redis as unknown as { incr: (key: string) => Promise<number> };
    const incr = redis.incr.bind(redis);
    redis.incr = (key: string) => (key === cfgKey ? Promise.reject(new Error('Valkey unavailable')) : incr(key));
    try {
      const res = await send('PUT', { defaultTemplate: 'white', offered: ['neon', 'white'] });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(3);
      // This process loads the saved value itself: its documents change although cfg:v could not move.
      await expect.poll(() => h.app.cfg.peek()?.ui.defaultTemplate, { timeout: 5_000 }).toBe('white');
      const served = await config();
      expect(configSchema.parse(served.json()).ui).toEqual({ defaultTemplate: 'white', templates: ['neon', 'white'] });
      expect(String(served.headers.etag)).not.toBe(etag);
      expect(statements(served)).toBe(0);
      expect(await version()).toBe(v);
    } finally {
      redis.incr = incr;
    }
    // Retried in the background: cfg:v moves, and the other process follows.
    await expect.poll(version, { timeout: 10_000 }).toBeGreaterThan(v);
    await settled(other);
    expect(configSchema.parse((await config(other)).json()).ui.defaultTemplate).toBe('white');
    expect(await stored()).toEqual({ default: 'white', offered: ['neon', 'white'] });
  });
});
