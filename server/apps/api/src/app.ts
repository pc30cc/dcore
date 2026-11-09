import { randomUUID } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import {
  CentrifugoPublisher,
  ClientIpResolver,
  DenyList,
  IdGenerator,
  createKeys,
  createPublicIds,
  createMediaStore,
  createServerSecrets,
  parseEdgeTrust,
  photoVariantUrl,
  type KeyBuilder,
  type MediaStore,
  type PublicIds,
  type RealtimePublisher,
  type ServerSecrets,
} from '@app/shared/server';
import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import { authServicesPlugin, type AuthServicesOptions } from './auth/services.js';
import { createAccessTokens, type AccessTokens } from './auth/tokens.js';
import type { ApiConfig } from './config.js';
import { createReadinessProbe, type ReadinessProbe } from './lib/readiness.js';
import { closeRedis, createRedis } from './lib/redis.js';
import { accountServicesPlugin, type AccountServicesOptions } from './plugins/accountServices.js';
import { callsPlugin, type CallsOptions } from './plugins/calls.js';
import { authPlugin } from './plugins/auth.js';
import { ClientPolicyHolder, clientPlugin } from './plugins/client.js';
import { clientIpPlugin } from './plugins/clientIp.js';
import { denyListPlugin } from './plugins/denyList.js';
import { errorsPlugin } from './plugins/errors.js';
import { openapiPlugin } from './plugins/openapi.js';
import { originsPlugin, type OriginsOptions } from './plugins/origins.js';
import { pgBudgetPlugin } from './plugins/pgBudget.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { securityPlugin } from './plugins/security.js';
import { storePlugin, type StoreOptions } from './plugins/store.js';
import { accountRoutes } from './routes/account.js';
import { adminOriginsRoutes } from './routes/adminOrigins.js';
import { adminRtcRoutes } from './routes/adminRtc.js';
import { callRoutes } from './routes/calls.js';
import { livekitWebhookRoutes } from './routes/livekitWebhook.js';
import { originsRoutes } from './routes/origins.js';
import { authRoutes } from './routes/auth.js';
import { dataExportRoutes } from './routes/dataExport.js';
import { deckRoutes } from './routes/deck.js';
import { deletionRoutes } from './routes/deletion.js';
import { healthRoutes } from './routes/health.js';
import { photoRoutes } from './routes/photos.js';
import { publicDeletionRoutes } from './routes/publicDeletion.js';
import { safetyRoutes } from './routes/safety.js';
import { conversationRoutes } from './routes/conversations.js';
import { likeRoutes } from './routes/likes.js';
import { swipeRoutes } from './routes/swipes.js';
import { BullJobProducer, type JobProducer } from './services/jobs.js';
import { chatPlugin, type ChatOptions } from './plugins/chat.js';
import { chatRoutes } from './routes/chat.js';
import { requestRoutes } from './routes/requests.js';
import { storeRoutes } from './routes/store.js';
import { storePurchaseRoutes } from './routes/storePurchases.js';
import { playRtdnRoutes, type PlayRtdnOptions } from './routes/webhooks/playRtdn.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
    pg: Pool;
    /** kv-core (noeviction). */
    redis: Redis;
    /** kv-cache (evicting): views, cards, deck queues; the kv-core client when REDIS_CACHE_URL is unset. */
    cache: Redis;
    readiness: ReadinessProbe;
    /** Valkey key names under the deployment prefix. */
    keys: KeyBuilder;
    /** `publicUid` and `billingRef` codecs. */
    publicIds: PublicIds;
    /** Keyed hashes and sealed values. */
    secrets: ServerSecrets;
    /** Access-token revocation (`deny:sid`, `deny:uid`). */
    denyList: DenyList;
    /** Application ids under this process's Valkey lease. */
    ids: IdGenerator;
    /** Minimum versions and maintenance, in memory; the config loader keeps it current. */
    clientPolicy: ClientPolicyHolder;
    /** Photo storage (private and media buckets, CDN links); null while S3 is not configured. */
    media: MediaStore | null;
    /** Jobs for the worker's queues. */
    jobs: JobProducer;
    /** Centrifugo's server API for the events the API publishes; null when not configured (nothing is published). */
    realtime: RealtimePublisher | null;
  }
}

export interface AppDependencies {
  /** A pool owned by the caller (tests); otherwise one is created and closed with the app. */
  pool?: Pool | undefined;
  /** A Redis client owned by the caller; otherwise one is created and closed with the app. */
  redis?: Redis | undefined;
  /** The kv-cache client owned by the caller; otherwise one for REDIS_CACHE_URL, or the kv-core client. */
  cache?: Redis | undefined;
  logger?: Logger | undefined;
  tokens?: AccessTokens | undefined;
  /** An id generator owned by the caller; otherwise one is created, started on ready and stopped on close. */
  ids?: IdGenerator | undefined;
  clientPolicy?: ClientPolicyHolder | undefined;
  /** Brand, city table and media links of the account routes (tests). */
  accountServices?: AccountServicesOptions | undefined;
  /** SMS senders, the Google verifier and the auth settings of the sign-in routes (tests). */
  authServices?: AuthServicesOptions | undefined;
  /** Photo storage (tests pass a fake; null: none); otherwise made from S3_* when set. */
  media?: MediaStore | null | undefined;
  /** A job producer owned by the caller (tests); otherwise BullMQ on the app's Valkey connection. */
  jobs?: JobProducer | undefined;
  /** A realtime publisher (tests pass a fake; null: none); otherwise Centrifugo when CENTRIFUGO_API_URL is set. */
  realtime?: RealtimePublisher | null | undefined;
  /** The LiveKit client, clock and dice of the call routes (tests); otherwise from LIVEKIT_*. */
  calls?: CallsOptions | undefined;
  /** Chat (tests pass a fake presence reader). */
  chat?: ChatOptions | undefined;
  /** The origins document's clock (tests). */
  origins?: OriginsOptions | undefined;
  /** Store integrations and the clock of the store services (tests). */
  store?: StoreOptions | undefined;
  /** The Pub/Sub push authenticator of Google Play's notifications (tests); otherwise from PLAY_RTDN_*. */
  playRtdn?: PlayRtdnOptions | undefined;
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
  const ownCache = !deps.cache && config.redis.cacheUrl !== undefined;
  const cache = deps.cache ?? (config.redis.cacheUrl ? createRedis({ url: config.redis.cacheUrl, connectionName: 'api-cache' }) : redis);
  if (ownCache) cache.on('error', (error: Error) => app.log.warn({ err: error }, 'redis cache connection error'));
  const readiness = createReadinessProbe({
    pool,
    redis,
    timeoutMs: config.readiness.timeoutMs,
    cacheMs: config.readiness.cacheMs,
    log: app.log,
  });
  const tokens = deps.tokens ?? (await createAccessTokens(config.auth));
  if (config.pgBudget !== 'off') instrumentPool(pool, statementCounter);
  const keys = createKeys(config.redis.keyPrefix);
  const publicIds = createPublicIds(config.ids.publicKey, config.ids.billingKey);
  const secrets = createServerSecrets(config.secrets);
  const denyList = new DenyList({
    redis,
    keys,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    clockSkewSeconds: config.auth.clockSkewSeconds,
  });
  const ids =
    deps.ids ??
    new IdGenerator({
      redis,
      keyPrefix: config.redis.keyPrefix,
      onEvent: (event) => {
        if (event.type === 'refresh_failed') app.log.warn({ err: event.error }, 'id lease: refresh failed');
        else if (event.type === 'lost' || event.type === 'exhausted' || event.type === 'clock_jump') app.log.error({ event }, 'id lease');
        else app.log.info({ event }, 'id lease');
      },
    });
  const clientPolicy = deps.clientPolicy ?? new ClientPolicyHolder();
  const media = deps.media !== undefined ? deps.media : config.storage ? createMediaStore(config.storage, { timeoutMs: config.storage.timeoutMs }) : null;
  const jobs = deps.jobs ?? new BullJobProducer({ redis, keyPrefix: config.redis.keyPrefix });
  const realtime = deps.realtime !== undefined ? deps.realtime : config.realtime.api ? new CentrifugoPublisher(config.realtime.api) : null;
  const edges = new ClientIpResolver(parseEdgeTrust(config.edgeTrust));
  if (edges.ignoredEntries.length > 0) app.log.warn({ entries: edges.ignoredEntries }, 'CF_EDGE_TRUST: entries ignored');

  app.decorate('config', config);
  app.decorate('pg', pool);
  app.decorate('redis', redis);
  app.decorate('cache', cache);
  app.decorate('readiness', readiness);
  app.decorate('keys', keys);
  app.decorate('publicIds', publicIds);
  app.decorate('secrets', secrets);
  app.decorate('denyList', denyList);
  app.decorate('ids', ids);
  app.decorate('clientPolicy', clientPolicy);
  app.decorate('media', media);
  app.decorate('jobs', jobs);
  app.decorate('realtime', realtime);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onReady', async () => {
    if (redis.status === 'wait') {
      // Not awaited: Redis being down must not keep the API from starting.
      redis.connect().catch((error: unknown) => app.log.warn({ err: error }, 'redis: first connection failed; retrying'));
    }
    if (ownCache && cache.status === 'wait') {
      cache.connect().catch((error: unknown) => app.log.warn({ err: error }, 'redis cache: first connection failed; retrying'));
    }
    if (!deps.ids) {
      // Not awaited either: until a lease is held, minting refuses and the refresh timer keeps trying.
      const startIds = () => {
        ids.start().catch((error: unknown) => app.log.warn({ err: error }, 'id lease: none yet; retrying'));
      };
      if (redis.status === 'ready') startIds();
      else redis.once('ready', startIds);
    }
  });
  app.addHook('onClose', async () => {
    if (!deps.jobs) await jobs.close();
    if (!deps.ids) await ids.stop();
    if (ownCache) await closeRedis(cache);
    if (!deps.redis) await closeRedis(redis);
    if (!deps.pool) await pool.end();
  });

  await app.register(errorsPlugin);
  // First of the hooks, so that every later hook and handler runs inside the request's tally.
  await app.register(pgBudgetPlugin, { mode: config.pgBudget, counter: statementCounter });
  await app.register(securityPlugin, { adminOrigins: config.corsAdminOrigins });
  await app.register(clientIpPlugin, { resolver: edges });
  await app.register(clientPlugin, { policy: () => clientPolicy.get(), defaultLocale: 'en' });
  await app.register(authPlugin, { tokens });
  await app.register(denyListPlugin, { denyList, userIdOf: (subject) => publicIds.user.decodeId(subject) });
  await app.register(rateLimitPlugin, {
    redis,
    keyPrefix: config.redis.keyPrefix,
    max: config.rateLimit.max,
    windowMs: config.rateLimit.windowMs,
  });
  if (config.openapi.enabled) await app.register(openapiPlugin);

  await app.register(accountServicesPlugin, {
    // Own photos are shown at the 640 variant; without a CDN they carry no link.
    ...(media?.urls ? { ownPhotoUrl: (photo: { id: string; blobVer: number }) => photoVariantUrl(media, photo.id, photo.blobVer, 640) } : {}),
    ...deps.accountServices,
  });
  await app.register(originsPlugin, deps.origins ?? {});
  await app.register(authServicesPlugin, deps.authServices ?? {});
  await app.register(callsPlugin, deps.calls ?? {});
  await app.register(storePlugin, deps.store ?? {});

  await app.register(healthRoutes, { readiness });
  await app.register(accountRoutes);
  await app.register(deckRoutes);
  await app.register(swipeRoutes);
  await app.register(likeRoutes);
  await app.register(chatPlugin, deps.chat ?? {});
  await app.register(conversationRoutes);
  await app.register(chatRoutes);
  await app.register(requestRoutes);
  await app.register(safetyRoutes);
  await app.register(authRoutes);
  await app.register(photoRoutes);
  await app.register(deletionRoutes);
  await app.register(dataExportRoutes);
  await app.register(publicDeletionRoutes);
  await app.register(callRoutes);
  await app.register(livekitWebhookRoutes);
  await app.register(adminRtcRoutes);
  await app.register(originsRoutes);
  await app.register(adminOriginsRoutes);
  await app.register(storeRoutes);
  await app.register(storePurchaseRoutes);
  await app.register(playRtdnRoutes, deps.playRtdn ?? {});

  if (config.openapi.enabled) {
    app.get('/openapi.json', { schema: { hide: true }, config: { rateLimit: false, pgBudget: 0 } }, async () => app.swagger());
  }

  return app;
}

export type ApiApp = Awaited<ReturnType<typeof buildApp>>;
