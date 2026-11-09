import { loadBrand } from '@app/config';
import { createPool, type Pool } from '@app/db';
import type { Brand } from '@app/shared';
import {
  CentrifugoPublisher,
  FcmSender,
  IdGenerator,
  createKeys,
  createMediaStore,
  createPublicIds,
  type KeyBuilder,
  type MediaStore,
  type PublicIds,
  type PushSender,
  type RealtimePublisher,
} from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.js';
import { iapServicesFrom, type IapServices } from './iap/verifiers.js';
import { FakePhotoModerator, type PhotoModerator } from './photos/moderation.js';
import { createWorkerRedis } from './redis.js';

/**
 * The clients a job may use, made once per process: the PostgreSQL pool,
 * the id generator under this process's Valkey lease, the kv-cache
 * connection, the key names, public ids, Centrifugo, object storage and the
 * photo moderation provider.
 */
export interface WorkerServices {
  pg: Pool;
  /** kv-cache (evicting: cards, deck queues, entitlements, presence); the job context's kv-core connection when REDIS_CACHE_URL is unset. */
  cache: Redis;
  /** Application ids (event ids, rows) under this process's own lease. */
  ids: IdGenerator;
  keys: KeyBuilder;
  publicIds: PublicIds;
  /** Null without Centrifugo (development): nothing is published. */
  realtime: RealtimePublisher | null;
  /** Null without S3: photo jobs wait and retry. */
  media: MediaStore | null;
  photoModerator: PhotoModerator;
  /** FCM; null or absent without FCM_SERVICE_ACCOUNT_JSON (push jobs then finish without sending). */
  push?: PushSender | null | undefined;
  /** The store integrations (absent: iap jobs wait for one). */
  iap?: IapServices | undefined;
  /** The brand served (BRAND), loaded at start; absent (tests): loaded from `config.brand` when first needed. */
  brand?: Brand | undefined;
}

export interface OwnedServices {
  services: WorkerServices;
  /** Stops the id lease and closes what this process opened. */
  close(): Promise<void>;
}

export function createWorkerServices(config: WorkerConfig, redis: Redis, logger: Logger): OwnedServices {
  // Read before anything is opened: a brand that cannot be read stops the process with its path.
  const brand = loadBrand({ brandId: config.brand.id, brandsDir: config.brand.dir });
  const pg = createPool({
    connectionString: config.database.url,
    applicationName: config.database.applicationName,
    target: config.database.target,
    max: config.database.poolMax,
    statementTimeoutMs: config.database.statementTimeoutMs,
    idleInTransactionTimeoutMs: config.database.idleInTransactionTimeoutMs,
    connectTimeoutMs: config.database.connectTimeoutMs,
    onError: (error) => logger.error({ err: error }, 'postgres: idle connection failed'),
  });
  const ids = new IdGenerator({
    redis,
    keyPrefix: config.redis.keyPrefix,
    onEvent: (event) => {
      if (event.type === 'refresh_failed') logger.warn({ err: event.error }, 'id lease: refresh failed');
      else if (event.type === 'lost' || event.type === 'exhausted' || event.type === 'clock_jump') logger.error({ event }, 'id lease');
      else logger.info({ event }, 'id lease');
    },
  });
  // Not awaited: until a lease is held, minting refuses and the refresh timer keeps trying.
  ids.start().catch((error: unknown) => logger.warn({ err: error }, 'id lease: none yet; retrying'));
  const cache = config.redis.cacheUrl ? createWorkerRedis(config.redis.cacheUrl, `worker-cache:${config.workerId}`) : redis;
  if (cache !== redis) cache.on('error', (error: Error) => logger.warn({ err: error }, 'redis cache connection error'));
  if (!config.realtime) logger.warn('CENTRIFUGO_API_URL is not set: realtime events are not published');
  if (!config.storage) logger.warn('S3_* is not set: photo jobs wait until storage is configured');
  if (!config.push) logger.warn('FCM_SERVICE_ACCOUNT_JSON is not set: pushes are not sent');
  const services: WorkerServices = {
    pg,
    cache,
    ids,
    keys: createKeys(config.redis.keyPrefix),
    publicIds: createPublicIds(config.ids.publicKey, config.ids.billingKey),
    realtime: config.realtime ? new CentrifugoPublisher(config.realtime) : null,
    media: config.storage ? createMediaStore(config.storage, { timeoutMs: config.storage.timeoutMs }) : null,
    photoModerator: new FakePhotoModerator({ autoApprove: config.photos.autoApprove }),
    push: config.push ? new FcmSender({ account: config.push.account }) : null,
    iap: iapServicesFrom(config, logger, { redis, keys: createKeys(config.redis.keyPrefix) }),
    brand,
  };
  return {
    services,
    async close() {
      await ids.stop();
      await pg.end();
      if (cache !== redis) await cache.quit().catch(() => cache.disconnect());
    },
  };
}
