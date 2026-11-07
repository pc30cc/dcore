import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Integration tests run against a real PostgreSQL 17 (infra/dev/native.sh or
 * infra/docker-compose.yml) named by TEST_DATABASE_URL; its role needs
 * CREATEDB, since each test file works in a database of its own. Without the
 * variable the suites are reported as skipped, unless REQUIRE_INTEGRATION=1
 * (CI) turns that into a failure.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

if (!TEST_DATABASE_URL && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL is not set');
}

export const hasDatabase = Boolean(TEST_DATABASE_URL);

/**
 * Under REQUIRE_INTEGRATION=1 a suite that cannot set up what it checks
 * (PostGIS in a fresh database, the group roles) fails instead of skipping.
 */
export function requireSetup(ok: boolean, what: string): void {
  if (!ok && process.env['REQUIRE_INTEGRATION'] === '1') {
    throw new Error(`REQUIRE_INTEGRATION=1 but ${what} (TEST_DATABASE_URL must name a superuser)`);
  }
}

export interface TempDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** Creates an empty database and returns its URL; `drop()` removes it. */
export async function createTempDatabase(): Promise<TempDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async drop() {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
