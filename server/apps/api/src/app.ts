import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@app/db';
import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import { createAccessTokens, type AccessTokens } from './auth/tokens.js';
import type { ApiConfig } from './config.js';
import { createReadinessProbe, type ReadinessProbe } from './lib/readiness.js';
import { closeRedis, createRedis } from './lib/redis.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';
import { openapiPlugin } from './plugins/openapi.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { securityPlugin } from './plugins/security.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
    pg: Pool;
    redis: Redis;
    readiness: ReadinessProbe;
  }
}

export interface AppDependencies {
  /** A pool owned by the caller (tests); otherwise one is created and closed with the app. */
  pool?: Pool | undefined;
  /** A Redis client owned by the caller; otherwise one is created and closed with the app. */
  redis?: Redis | undefined;
  logger?: Logger | undefined;
  tokens?: AccessTokens | undefined;
}

/** Inbound ids are kept only when they look like ids: they end up in every log line. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function createLogger(config: ApiConfig): Logger {
  return pino({
    level: config.log.level,
    base: { service: 'api' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    ...(config.log.pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

/**
 * Builds the API without listening. Opening connections waits for the first
 * use (PostgreSQL) or for `ready()` (Redis), so building needs no running
 * infrastructure, and a dependency that is down shows up on /readyz instead of
 * stopping the process.
 */
export async function buildApp(config: ApiConfig, deps: AppDependencies = {}) {
  const logger = deps.logger ?? createLogger(config);

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
    // In-flight requests finish on close; new ones get 503 meanwhile.
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const pool =
    deps.pool ??
    createPool({
      connectionString: config.database.url,
      applicationName: config.database.applicationName,
      target: config.database.target,
      max: config.database.poolMax,
      statementTimeoutMs: config.database.statementTimeoutMs,
      idleInTransactionTimeoutMs: config.database.idleInTransactionTimeoutMs,
      connectTimeoutMs: config.database.connectTimeoutMs,
      onError: (error) => app.log.error({ err: error }, 'postgres: idle connection failed'),
    });
  const redis = deps.redis ?? createRedis({ url: config.redis.url, connectionName: 'api' });
  if (!deps.redis) redis.on('error', (error: Error) => app.log.warn({ err: error }, 'redis connection error'));
  const readiness = createReadinessProbe({
    pool,
    redis,
    timeoutMs: config.readiness.timeoutMs,
    cacheMs: config.readiness.cacheMs,
    log: app.log,
  });
  const tokens = deps.tokens ?? (await createAccessTokens(config.auth));

  app.decorate('config', config);
  app.decorate('pg', pool);
  app.decorate('redis', redis);
  app.decorate('readiness', readiness);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onReady', async () => {
    if (redis.status === 'wait') {
      // Not awaited: Redis being down must not keep the API from starting.
      redis.connect().catch((error: unknown) => app.log.warn({ err: error }, 'redis: first connection failed; retrying'));
    }
  });
  app.addHook('onClose', async () => {
    if (!deps.redis) await closeRedis(redis);
    if (!deps.pool) await pool.end();
  });

  await app.register(errorsPlugin);
  await app.register(securityPlugin, { adminOrigins: config.corsAdminOrigins });
  await app.register(authPlugin, { tokens });
  await app.register(rateLimitPlugin, {
    redis,
    keyPrefix: config.redis.keyPrefix,
    max: config.rateLimit.max,
    windowMs: config.rateLimit.windowMs,
  });
  if (config.openapi.enabled) await app.register(openapiPlugin);

  await app.register(healthRoutes, { readiness });

  if (config.openapi.enabled) {
    app.get('/openapi.json', { schema: { hide: true }, config: { rateLimit: false } }, async () => app.swagger());
  }

  return app;
}

export type ApiApp = Awaited<ReturnType<typeof buildApp>>;
