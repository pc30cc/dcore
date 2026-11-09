import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapError, bootstrapOwner } from '../src/admin/bootstrap.js';
import { base32Decode, totpAt } from '../src/admin/totp.js';
import { migratedDatabase, row, rows, type TestDatabase } from './accountSupport.js';
import { CHEAP_ARGON2, admin, setCookie, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The first owner from the command line (`admin:create`): it creates the
 * owner once, prints the TOTP enrolment URI once, refuses while an enabled
 * owner exists, and `--force-reset` is the way back in. The printed
 * password and secret then sign in through the panel's routes.
 */

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

describe.skipIf(!hasInfrastructure)('the first owner (admin:create)', () => {
  let db: TestDatabase;
  let h: AdminHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('creates the owner once, and the printed password and secret sign in through the panel', async () => {
    const result = await bootstrapOwner({ pool: db.sql, sealer: h.app.secrets.sealer, email: 'Owner@Example.com', displayName: 'Owner', forceReset: false, issuer: h.app.brand.appName, argon2: CHEAP_ARGON2 });
    expect(result).toMatchObject({ created: true, email: 'owner@example.com', revokedSessions: [] });
    expect(result.generatedPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(result.otpauthUri).toBe(
      `otpauth://totp/${encodeURIComponent(h.app.brand.appName)}:owner%40example.com?secret=${result.secret}&issuer=${encodeURIComponent(h.app.brand.appName)}&algorithm=SHA1&digits=6&period=30`,
    );
    const stored = await row<{ roles: string[]; totp_enabled_at: Date | null; created_by: number | null }>(
      db,
      `SELECT array(SELECT r.key FROM admin_user_roles ur JOIN admin_roles r ON r.id = ur.role_id WHERE ur.admin_id = u.id) AS roles, totp_enabled_at, created_by FROM admin_users u WHERE id = $1`,
      [result.adminId],
    );
    expect(stored).toEqual({ roles: ['superadmin'], totp_enabled_at: null, created_by: null });
    const audit = await rows<{ admin_id: number | null; action: string }>(db, `SELECT admin_id, action FROM audit_log WHERE target_type = 7 AND target_id = $1`, [result.adminId]);
    expect(audit).toEqual([{ admin_id: null, action: 'admin.bootstrap' }]);

    // A second owner is refused while this one is enabled.
    await expect(bootstrapOwner({ pool: db.sql, sealer: h.app.secrets.sealer, email: 'second@example.com', displayName: 'Second', forceReset: false, issuer: 'x', argon2: CHEAP_ARGON2 })).rejects.toMatchObject({
      name: 'BootstrapError',
      exitCode: 65,
    });

    // The panel: the password, then the first code of the printed secret enrols it.
    const login = await admin(h, '/v1/admin/auth/login', { email: 'owner@example.com', password: result.generatedPassword });
    expect(login.json()).toMatchObject({ enrollRequired: true });
    h.tick();
    const confirm = await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken: login.json<{ mfaToken: string }>().mfaToken, code: totpAt(base32Decode(result.secret), h.clock.now) });
    expect(confirm.statusCode).toBe(200);
    const token = confirm.json<{ accessToken: string }>().accessToken;
    expect((await admin(h, '/v1/admin/admins', undefined, { token })).statusCode).toBe(200);

    // --force-reset: a new password and secret, TOTP again, every session signed out (its access token too, when Valkey is reachable).
    const sid = setCookie(confirm)!.value.split('.')[1]!;
    await db.sql.query(`UPDATE admin_users SET locked_until = now() + interval '1 hour', disabled_at = now() WHERE id = $1`, [result.adminId]);
    const reset = await bootstrapOwner({ pool: db.sql, sealer: h.app.secrets.sealer, email: 'owner@example.com', displayName: 'Owner', password: 'a chosen password here', forceReset: true, issuer: 'x', argon2: CHEAP_ARGON2 });
    expect(reset).toMatchObject({ created: false, adminId: result.adminId, generatedPassword: null, revokedSessions: [sid] });
    expect(reset.secret).not.toBe(result.secret);
    const after = await row<{ disabled_at: Date | null; locked_until: Date | null; totp_enabled_at: Date | null }>(db, `SELECT disabled_at, locked_until, totp_enabled_at FROM admin_users WHERE id = $1`, [result.adminId]);
    expect(after).toEqual({ disabled_at: null, locked_until: null, totp_enabled_at: null });
    expect((await admin(h, '/v1/admin/auth/login', { email: 'owner@example.com', password: result.generatedPassword })).statusCode).toBe(401);
    const again = await admin(h, '/v1/admin/auth/login', { email: 'owner@example.com', password: 'a chosen password here' });
    expect(again.json()).toMatchObject({ enrollRequired: true });
    expect((await rows<{ action: string }>(db, `SELECT action FROM audit_log WHERE target_type = 7 AND target_id = $1 AND action LIKE 'admin.%' ORDER BY id`, [result.adminId])).map((r) => r.action)).toContain('admin.force_reset');

    // Usage problems are refused before anything is written.
    await expect(bootstrapOwner({ pool: db.sql, sealer: h.app.secrets.sealer, email: 'not-an-email', displayName: 'X', forceReset: true, issuer: 'x' })).rejects.toBeInstanceOf(BootstrapError);
    await expect(bootstrapOwner({ pool: db.sql, sealer: h.app.secrets.sealer, email: 'weak@example.com', displayName: 'X', password: 'short', forceReset: true, issuer: 'x' })).rejects.toMatchObject({ exitCode: 64 });
  });

  it('runs as a command: usage, creation with the URI printed once, refusal', () => {
    const name = `t_cli_${randomBytes(4).toString('hex')}`;
    const url = new URL(db.url);
    const env = {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: url.toString(),
      DATA_KEYS: JSON.stringify({ 1: randomBytes(32).toString('base64url') }),
      DATA_KEY_ID: '1',
    };
    const run = (args: string[]) => spawnSync(TSX, ['--conditions=@app/source', 'src/scripts/admin-create.ts', ...args], { cwd: API_DIR, env, encoding: 'utf8', timeout: 60_000 });

    const usage = run([]);
    expect(usage.status).toBe(64);
    expect(usage.stderr).toContain('usage: admin-create');

    // This database has an enabled owner (the test above): refused, nothing printed on stdout.
    const refused = run(['--email', `${name}@example.com`, '--name', 'Cli']);
    expect(refused.status).toBe(65);
    expect(refused.stdout).toBe('');

    const forced = run(['--email', `${name}@example.com`, '--name', 'Cli', '--force-reset']);
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.stdout).toContain(`Owner created: ${name}@example.com`);
    expect(forced.stdout).toMatch(/Password \(shown once; change it in the panel\): [A-Za-z0-9_-]{24}\n/);
    expect(forced.stdout).toMatch(new RegExp(`otpauth://totp/[^\\n]+:${name}%40example\\.com\\?secret=[A-Z2-7]{32}&issuer=`));
  });
});
