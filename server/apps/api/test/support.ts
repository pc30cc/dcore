import { generateKeyPairSync, randomBytes } from 'node:crypto';
import pino from 'pino';
import { buildApp, type AppDependencies } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';

/**
 * Tests that need PostgreSQL and Redis read TEST_DATABASE_URL and
 * TEST_REDIS_URL (infra/dev/native.sh env); without them those suites are
 * skipped, unless REQUIRE_INTEGRATION=1 makes that a failure. The other tests
 * point at addresses where nothing listens, which is how they check that the
 * API starts and degrades without its dependencies.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];
if ((!TEST_DATABASE_URL || !TEST_REDIS_URL) && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL or TEST_REDIS_URL is not set');
}
export const hasInfrastructure = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);

export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
export const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1/0';

export const ADMIN_ORIGIN = 'https://admin.test.invalid';
export const ISSUER = 'https://api.test.invalid';

export function testSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function ed25519Pem(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function testConfig(env: Record<string, string> = {}): ApiConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    DATABASE_CONNECT_TIMEOUT_MS: '500',
    REDIS_URL: UNREACHABLE_REDIS_URL,
    REDIS_KEY_PREFIX: `t${randomBytes(4).toString('hex')}:`,
    CORS_ADMIN_ORIGINS: ADMIN_ORIGIN,
    READINESS_TIMEOUT_MS: '500',
    READINESS_CACHE_MS: '0',
    AUTH_JWT_ALG: 'HS256',
    AUTH_JWT_ISSUER: ISSUER,
    AUTH_JWT_SECRET: testSecret(),
    ID_PUBLIC_KEY: testSecret(),
    ID_BILLING_KEY: testSecret(),
    HASH_PEPPERS: JSON.stringify({ 1: testSecret() }),
    DATA_KEYS: JSON.stringify({ 1: testSecret() }),
    ...env,
  });
}

export async function testApp(config: ApiConfig = testConfig(), deps: AppDependencies = {}) {
  return buildApp(config, { logger: pino({ level: 'silent' }), ...deps });
}
