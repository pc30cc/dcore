import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations, type Pool } from '@app/db';

/**
 * Suites that need PostgreSQL 17 + PostGIS read TEST_DATABASE_URL (a role
 * that may create databases and roles); each works in a database of its
 * own with the real migrations, dropped afterwards. REQUIRE_INTEGRATION=1
 * turns a missing variable into a failure instead of a skip.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
if (!TEST_DATABASE_URL && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL is not set');
}
export const hasDatabase = Boolean(TEST_DATABASE_URL);

export const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const quiet = { info: () => undefined, warn: () => undefined };

async function onServer(statement: string): Promise<void> {
  const admin = createPool({ connectionString: TEST_DATABASE_URL ?? '', applicationName: 'worker-test-admin', max: 1 });
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/** The group roles 0009 grants to (cluster-wide; another suite may have made them already). */
export async function ensureGroupRoles(): Promise<void> {
  for (const role of ['app_rw', 'app_ro', 'app_maint']) {
    try {
      await onServer(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    } catch (error) {
      // Two suites creating the same role at once: the loser sees a duplicate.
      if ((error as { code?: string }).code !== '42710' && (error as { code?: string }).code !== '23505') throw error;
    }
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  /** A superuser pool on the test database, for seeding (the code under test never uses it). */
  admin: Pool;
  /** The URL of the same database for another role. */
  urlFor(role: string, password: string): string;
  drop(): Promise<void>;
}

export async function migratedDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `t_wk_${randomBytes(5).toString('hex')}`;
  await onServer(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await onServer(`GRANT CONNECT ON DATABASE ${name} TO PUBLIC`);
  const admin = createPool({ connectionString: url.toString(), applicationName: 'worker-test-seed', max: 3 });
  await admin.query('CREATE EXTENSION IF NOT EXISTS postgis');
  await runMigrations({ connectionString: url.toString(), directory: MIGRATIONS, log: quiet });
  return {
    name,
    url: url.toString(),
    admin,
    urlFor(role, password) {
      const other = new URL(url.toString());
      other.username = role;
      other.password = password;
      return other.toString();
    },
    async drop() {
      await admin.end();
      await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/** A login role in the given groups; dropped by the returned function. */
export async function loginRole(groups: readonly string[]): Promise<{ name: string; password: string; drop(): Promise<void> }> {
  const name = `t_role_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await onServer(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'${groups.length ? ` IN ROLE ${groups.join(', ')}` : ''}`);
  return {
    name,
    password,
    async drop() {
      await onServer(`DROP ROLE IF EXISTS ${name}`);
    },
  };
}
