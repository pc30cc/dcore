import { loadBrand } from '@app/config';
import { createPool, testAccountIds, type Pool } from '@app/db';
import type { Brand } from '@app/shared';
import {
  CentrifugoPublisher,
  FcmSender,
  IdGenerator,
  TestAccounts,
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

  // dashboard
  /** The raw ids of test accounts, kept 10 minutes or until a flip moves `stats:testv` (absent in tests: made from `pg` when a stats job needs it). */
  testAccounts?: TestAccounts | undefined;

  // content

  // revenue

  // growth

  // app

  // support

  // system
}

/** More test accounts than this: the set is cut (logged), and the statistics count the rest as people. */
export const TEST_ACCOUNTS_MAX = 10_000;

/**
 * The test-account set of a pool: users_test_idx, at most
 * {@link TEST_ACCOUNTS_MAX} ids; with `flips` (kv-core) it also reloads
 * within seconds of a flip (`stats:testv`, one GET at most every 5 s).
 */
export function testAccountsFrom(
  pg: Pool,
  logger: Pick<Logger, 'error' | 'warn'>,
  flips?: { redis: Redis; keys: KeyBuilder; checkMs?: number },
): TestAccounts {
  return new TestAccounts({
    load: async () => {
      const ids = await testAccountIds(pg, TEST_ACCOUNTS_MAX + 1);
      if (ids.length > TEST_ACCOUNTS_MAX) logger.error({ max: TEST_ACCOUNTS_MAX }, 'test accounts: more than the statistics can leave out');
      return ids.slice(0, TEST_ACCOUNTS_MAX);
    },
    version: flips ? () => flips.redis.get(flips.keys.statsTestVersion()) : undefined,
    checkMs: flips?.checkMs,
    onError: (error) => logger.warn({ err: error }, 'test accounts: not reloaded; the last set stays'),
  });
}

const fallbackTestAccounts = new WeakMap<Pool, TestAccounts>();

/** The process's test-account set, or one made once for this pool (suites that build services by hand). */
export function testAccountsOf(services: Pick<WorkerServices, 'pg' | 'testAccounts'>, logger: Pick<Logger, 'error' | 'warn'>): TestAccounts {
  if (services.testAccounts) return services.testAccounts;
  let made = fallbackTestAccounts.get(services.pg);
  if (!made) {
    made = testAccountsFrom(services.pg, logger);
    fallbackTestAccounts.set(services.pg, made);
  }
  return made;
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
  const keys = createKeys(config.redis.keyPrefix);
  const services: WorkerServices = {
    pg,
    cache,
    ids,
    keys,
    publicIds: createPublicIds(config.ids.publicKey, config.ids.billingKey),
    realtime: config.realtime ? new CentrifugoPublisher(config.realtime) : null,
    media: config.storage ? createMediaStore(config.storage, { timeoutMs: config.storage.timeoutMs }) : null,
    photoModerator: new FakePhotoModerator({ autoApprove: config.photos.autoApprove }),
    push: config.push ? new FcmSender({ account: config.push.account }) : null,
    iap: iapServicesFrom(config, logger, { redis, keys }),
    brand,

    // dashboard
    testAccounts: testAccountsFrom(pg, logger, { redis, keys }),

    // content

    // revenue

    // growth

    // app

    // support

    // system
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
