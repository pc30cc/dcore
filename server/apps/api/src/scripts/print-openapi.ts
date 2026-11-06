/**
 * Prints the OpenAPI document without any infrastructure:
 *
 *   pnpm --filter @app/api openapi > openapi.json
 *
 * The app is built with throwaway settings (an unreachable database and
 * Redis, an ephemeral signing secret); nothing connects, nothing listens.
 */
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const config = loadConfig({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUTH_JWT_ALG: 'HS256',
  AUTH_JWT_ISSUER: 'openapi',
  AUTH_JWT_SECRET: randomBytes(32).toString('base64url'),
});
const app = await buildApp(config, { logger: pino({ level: 'silent' }) });
await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
