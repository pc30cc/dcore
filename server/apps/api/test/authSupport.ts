import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations, type Pool } from '@app/db';
import { FakeGoogleIdTokenVerifier, FakeSmsSender } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { ApiApp } from '../src/app.js';
import { AuthSettingsHolder, DEFAULT_AUTH_SETTINGS, type AuthSettings } from '../src/auth/settings.js';
import { STATEMENTS_HEADER } from '../src/plugins/pgBudget.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL, testApp, testConfig } from './support.js';

/**
 * The sign-in suites run the real migrations in a database of their own
 * (created on the TEST_DATABASE_URL server, dropped at the end) and use
 * Valkey under a random key prefix. SMS providers and Google are fakes
 * behind their interfaces: no test reaches a provider.
 */

export const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
export const GOOGLE_CLIENT = 'test-web-client.apps.example';

export interface TempDatabase {
  url: string;
  sql: Pool;
  drop(): Promise<void>;
}

/** The rows of a test query, typed by the caller. */
export async function rows<T>(db: TempDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  return (await db.sql.query(text, values)).rows as T[];
}

/** The first row of a test query; throws when there is none. */
export async function row<T>(db: TempDatabase, text: string, values: unknown[] = []): Promise<T> {
  const [first] = await rows<T>(db, text, values);
  if (first === undefined) throw new Error(`no row: ${text}`);
  return first;
}

async function onServer(statement: string): Promise<void> {
  const admin = createPool({ connectionString: TEST_DATABASE_URL ?? '', applicationName: 'auth-test-admin', max: 1 });
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/** An empty database with every migration applied. */
export async function migratedDatabase(): Promise<TempDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `t_auth_${randomBytes(5).toString('hex')}`;
  await onServer(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await runMigrations({ connectionString: url.toString(), directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
  const sql = createPool({ connectionString: url.toString(), applicationName: 'auth-test', max: 3 });
  return {
    url: url.toString(),
    sql,
    async drop() {
      await sql.end();
      await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export interface AuthHarness {
  app: ApiApp;
  prefix: string;
  /** SMS fakes by provider (`kavenegar` serves +98 and `telnyx` the rest, as the seeded routing says). */
  sms: { kavenegar: FakeSmsSender; smsir: FakeSmsSender; telnyx: FakeSmsSender };
  google: FakeGoogleIdTokenVerifier;
  settings: AuthSettingsHolder;
  /** Every log line the app wrote (level debug and up). */
  logs: string[];
  close(): Promise<void>;
}

export function settingsWith(patch: Omit<Partial<AuthSettings>, 'caps'> & { caps?: Partial<AuthSettings['caps']> } = {}): AuthSettings {
  return { ...DEFAULT_AUTH_SETTINGS, ...patch, caps: { ...DEFAULT_AUTH_SETTINGS.caps, ...patch.caps } };
}

export async function authApp(
  db: TempDatabase,
  options: { env?: Record<string, string>; settings?: AuthSettings; refreshGraceMs?: number; redisUrl?: string; waitForValkey?: boolean; routes?: (app: ApiApp) => void } = {},
): Promise<AuthHarness> {
  const config = testConfig({
    DATABASE_URL: db.url,
    REDIS_URL: options.redisUrl ?? TEST_REDIS_URL ?? '',
    GOOGLE_WEB_CLIENT_ID: GOOGLE_CLIENT,
    LOG_LEVEL: 'debug',
    ...options.env,
  });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  const sms = { kavenegar: new FakeSmsSender('kavenegar'), smsir: new FakeSmsSender('smsir'), telnyx: new FakeSmsSender('telnyx') };
  const google = new FakeGoogleIdTokenVerifier();
  const settings = new AuthSettingsHolder(options.settings ?? settingsWith());
  const app = await testApp(config, {
    logger: pino({ level: 'debug' }, stream),
    authServices: { smsSenders: Object.values(sms), google, authSettings: settings, refreshGraceMs: options.refreshGraceMs },
  });
  options.routes?.(app);
  await app.ready();
  // The config loader has set the seeded settings by now; a test's own win.
  if (options.settings) settings.set(options.settings);
  if (!options.redisUrl || options.waitForValkey) {
    const deadline = Date.now() + 10_000;
    while (app.redis.status !== 'ready' || app.ids.generator === null) {
      if (Date.now() > deadline) throw new Error('Valkey or the id lease did not come up');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return {
    app,
    prefix: config.redis.keyPrefix,
    sms,
    google,
    settings,
    logs,
    async close() {
      await app.close();
      const url = options.redisUrl ?? TEST_REDIS_URL;
      if (url && (!options.redisUrl || options.waitForValkey)) {
        const redis = new Redis(url);
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${config.redis.keyPrefix}*`, 'COUNT', 1000);
          cursor = next;
          if (keys.length > 0) await redis.del(...keys);
        } while (cursor !== '0');
        await redis.quit();
      }
    },
  };
}

export const PLAY = 'play/120';
export const BAZAAR = 'bazaar/121';

export function device(locale = 'fa') {
  return { installId: randomUUID(), deviceKey: randomBytes(32).toString('hex'), device: { model: 'Pixel 8', osVersion: '15', appVersion: '1.2.0', locale } };
}

export function statements(response: LightMyRequestResponse): number {
  return Number(response.headers[STATEMENTS_HEADER]);
}

/** A fresh number of the kind asked for (+98 mobile or US). */
let counter = 0;
export function phone(kind: 'ir' | 'us' = 'ir'): string {
  counter += 1;
  const tail = String((Date.now() + counter * 7919) % 10_000_000).padStart(7, '0');
  return kind === 'ir' ? `+98912${tail.slice(0, 7)}` : `+1415${tail}`;
}

export async function post(h: AuthHarness, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return h.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'x-client': PLAY, 'accept-language': 'fa', ...headers } });
}

/** Starts a code and signs in with it; returns the sign-in answer. */
export async function signInWithPhone(h: AuthHarness, number: string, dev = device(), headers: Record<string, string> = {}) {
  const start = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' }, headers);
  if (start.statusCode !== 200) throw new Error(`otp start ${start.statusCode}: ${start.body}`);
  const { challengeId } = start.json<{ challengeId: string }>();
  const code = h.sms.kavenegar.codeFor(number) ?? h.sms.telnyx.codeFor(number);
  if (!code) throw new Error('no code was sent');
  return post(h, '/v1/auth/otp/verify', { challengeId, code, ...dev }, headers);
}
