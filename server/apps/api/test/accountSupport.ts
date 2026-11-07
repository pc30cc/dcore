import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations, type Pool } from '@app/db';
import { problemSchemaFor, type ErrorCode } from '@app/shared';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { ApiApp, AppDependencies } from '../src/app.js';
import type { SessionScope } from '../src/auth/tokens.js';
import { STATEMENTS_HEADER } from '../src/plugins/pgBudget.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL, testApp, testConfig } from './support.js';

/**
 * The account suites run the real migrations in a database of their own
 * (on the TEST_DATABASE_URL server, dropped afterwards) and Valkey under a
 * random key prefix. Accounts are seeded with plain SQL through a pool the
 * app does not count; requests go through `inject` with real tokens.
 */

export const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
export const REALTIME_SECRET = 'realtime-test-secret-0123456789abcdef';

export interface TestDatabase {
  url: string;
  sql: Pool;
  drop(): Promise<void>;
}

async function onServer(statement: string): Promise<void> {
  const admin = createPool({ connectionString: TEST_DATABASE_URL ?? '', applicationName: 'account-test-admin', max: 1 });
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

export async function migratedDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `t_acct_${randomBytes(5).toString('hex')}`;
  await onServer(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await runMigrations({ connectionString: url.toString(), directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
  const sql = createPool({ connectionString: url.toString(), applicationName: 'account-test', max: 3 });
  return {
    url: url.toString(),
    sql,
    async drop() {
      await sql.end();
      await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export async function rows<T>(db: TestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  return (await db.sql.query(text, values)).rows as T[];
}

export async function row<T>(db: TestDatabase, text: string, values: unknown[] = []): Promise<T> {
  const [first] = await rows<T>(db, text, values);
  if (first === undefined) throw new Error(`no row: ${text}`);
  return first;
}

export interface Harness {
  app: ApiApp;
  db: TestDatabase;
  redis: Redis;
  prefix: string;
  /** Every log line the app wrote (debug and up). */
  logs: string[];
  /** Every response body the suite saw. */
  bodies: string[];
  close(): Promise<void>;
}

/** `env` values that are undefined leave the variable unset. */
export async function startHarness(db: TestDatabase, env: Record<string, string | undefined> = {}, deps: AppDependencies = {}): Promise<Harness> {
  const merged: Record<string, string | undefined> = {
    DATABASE_URL: db.url,
    REDIS_URL: TEST_REDIS_URL ?? '',
    CENTRIFUGO_TOKEN_HMAC_SECRET: REALTIME_SECRET,
    ...env,
  };
  const config = testConfig(Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  const app = await testApp(config, { logger: pino({ level: 'debug' }, sink), ...deps });
  await app.ready();
  while (app.redis.status !== 'ready') await new Promise((resolve) => setTimeout(resolve, 10));
  // The configuration loads on ready and the id lease is taken once Valkey is up: wait for both.
  for (let i = 0; i < 200 && app.cfg.peek() === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  for (let i = 0; i < 200; i += 1) {
    try {
      app.ids.nextId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const redis = new Redis(TEST_REDIS_URL ?? '');
  const prefix = config.redis.keyPrefix;
  return {
    app,
    db,
    redis,
    prefix,
    logs,
    bodies: [],
    async close() {
      await app.close();
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    },
  };
}

export interface SeededUser {
  id: string;
  publicUid: string;
  deviceId: string;
  sessionId: string;
  token: string;
}

export interface SeedOptions {
  status?: number;
  birthDate?: string | null;
  gender?: number | null;
  /** Creates a profile with this name. */
  name?: string;
  store?: 1 | 2;
  scope?: SessionScope;
  /** Creates a preferences row (interested_in mask). */
  interestedIn?: number;
  country?: string | null;
}

let seq = 0;

/** An account with a device, a session and an access token for it. */
export async function seedUser(h: Harness, options: SeedOptions = {}): Promise<SeededUser> {
  const status = options.status ?? 3;
  const id = h.app.ids.nextId();
  const deviceId = h.app.ids.nextId();
  const sessionId = h.app.ids.nextId();
  const store = options.store ?? 2;
  const birthDate = options.birthDate === undefined ? (status === 1 || status >= 7 ? null : '1994-05-17') : options.birthDate;
  const gender = options.gender === undefined ? (birthDate ? 2 : null) : options.gender;
  await h.db.sql.query(
    `INSERT INTO users (id, status, birth_date, gender, country, deleted_at, onboarding_step)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $2::smallint IN (7, 8) THEN now() END, 0)`,
    [id, status, birthDate, gender, options.country === undefined ? (status === 8 ? null : 'IR') : options.country],
  );
  seq += 1;
  const fingerprint = Buffer.alloc(32, seq % 255);
  fingerprint.writeUInt32BE(seq, 0);
  await h.db.sql.query(
    `INSERT INTO devices (id, user_id, app_version, platform, store, fingerprint_hash, locale) VALUES ($1, $2, 100, 1, $3, $4, 'en')`,
    [deviceId, id, store, fingerprint],
  );
  await h.db.sql.query(
    `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', $4, $5)`,
    [sessionId, id, deviceId, store, randomBytes(32)],
  );
  if (options.name) {
    await h.db.sql.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [id, options.name]);
  }
  if (options.interestedIn !== undefined) {
    await h.db.sql.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, $2)`, [id, options.interestedIn]);
  }
  const publicUid = h.app.publicIds.user.encode(id);
  const { token } = await h.app.tokens.issue({ kind: 'app', subject: publicUid, sessionId, deviceId, storeCode: store, scope: options.scope ?? 'full' });
  return { id, publicUid, deviceId, sessionId, token };
}

export interface CallOptions {
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  client?: string;
}

/** One request with the app's headers; the body is kept for the suite's raw-id check. */
export async function call(h: Harness, url: string, options: CallOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { 'x-client': options.client ?? 'bazaar/120', ...options.headers };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  const response = await h.app.inject({
    method: options.method ?? 'GET',
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
  });
  h.bodies.push(response.body);
  return response;
}

export function statements(response: LightMyRequestResponse): number {
  const value = response.headers[STATEMENTS_HEADER];
  if (value === undefined) throw new Error('no statement count on the response');
  return Number(value);
}

/** Sets an app_config value and announces it, as the admin panel does. */
export async function setAppConfig(h: Harness, key: string, value: unknown): Promise<void> {
  await h.db.sql.query(`UPDATE public.app_config SET value = $2::jsonb, updated_at = now() WHERE key = $1`, [key, JSON.stringify(value)]);
  const before = h.app.cfg.peek()?.loadedAt.getTime() ?? 0;
  const version = await h.redis.incr(`${h.prefix}cfg:v`);
  await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
  for (let i = 0; i < 300; i += 1) {
    const snapshot = h.app.cfg.peek();
    if (snapshot?.version === version && snapshot.loadedAt.getTime() >= before) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`configuration version ${version} was not loaded`);
}

/** A problem body checked strictly against its code's members; the members as a record. */
export function problemExt(code: ErrorCode, body: unknown): Record<string, unknown> {
  return problemSchemaFor(code).parse(body);
}

/** A JSON body as a record (for reading members the test then checks). */
export function json(response: LightMyRequestResponse): Record<string, unknown> {
  return response.json<Record<string, unknown>>();
}
