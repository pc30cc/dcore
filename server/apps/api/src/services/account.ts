import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { accountView, accountViewSchema, type AccountView, type AccountViewResult, type Pool, type Queryable } from '@app/db';
import { bumpVersion, readVersion, type KeyBuilder } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * The own-account view behind `GET /v1/me`, cached in Valkey under its
 * version: `mev:<uid>` (a version counter, also the ETag; kv-core) and
 * `me:<uid>:<mev>` (the `account_view()` result, deflated, 24 h; kv-cache). A warm
 * read costs two Valkey round trips and no SQL; a miss costs one statement.
 *
 * Every write to the account bumps `mev` after it is durable, so the next
 * read misses and rebuilds; nothing is ever purged. A reader that saw the
 * old version may store a fresher view under it, which is harmless: no one
 * reads that key again.
 */

export const ME_VIEW_TTL_SECONDS = 24 * 3_600;

const cachedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), view: accountViewSchema }),
  z.object({ kind: z.literal('deleted'), deletedAtMs: z.number().int(), purgeAtMs: z.number().int() }),
  z.object({ kind: z.literal('purged') }),
  z.object({ kind: z.literal('missing') }),
]);

export interface LoadedAccount {
  version: number;
  result: AccountViewResult;
  /** Whether the view came from Valkey (no SQL). */
  cached: boolean;
}

export interface AccountStoreOptions {
  pool: Pool;
  /** kv-core: the version counters. */
  redis: Redis;
  /** kv-cache: the views (default: `redis`). */
  cache?: Redis | undefined;
  keys: KeyBuilder;
  log: FastifyBaseLogger;
}

export class AccountStore {
  private readonly pool: Pool;
  private readonly redis: Redis;
  private readonly cache: Redis;
  private readonly keys: KeyBuilder;
  private readonly log: FastifyBaseLogger;

  constructor(options: AccountStoreOptions) {
    this.pool = options.pool;
    this.redis = options.redis;
    this.cache = options.cache ?? options.redis;
    this.keys = options.keys;
    this.log = options.log;
  }

  /** The account's current version (`mev:<uid>`), or null when Valkey cannot be read. */
  async version(userId: string): Promise<number | null> {
    try {
      return await readVersion(this.redis, this.keys.meVersion(userId));
    } catch (error) {
      this.log.warn({ err: error }, 'account: version unreadable');
      return null;
    }
  }

  /**
   * The view at `version`: from Valkey, or built with one statement and
   * stored. Without a version (Valkey down) it is built and not stored.
   */
  async view(userId: string, version: number | null): Promise<LoadedAccount> {
    if (version !== null) {
      const key = this.keys.meView(userId, version);
      try {
        const stored = await this.cache.getBuffer(key);
        if (stored) {
          const parsed = cachedSchema.safeParse(JSON.parse(inflateRawSync(stored).toString('utf8')));
          if (parsed.success) return { version, result: parsed.data, cached: true };
          this.log.warn('account: cached view does not parse; rebuilding');
        }
      } catch (error) {
        this.log.warn({ err: error }, 'account: cached view unreadable');
      }
    }
    const result = await accountView(this.pool, userId);
    if (version !== null) await this.store(userId, version, result);
    return { version: version ?? 0, result, cached: false };
  }

  /** Version, then view: what `GET /v1/me` reads. */
  async load(userId: string): Promise<LoadedAccount> {
    return this.view(userId, await this.version(userId));
  }

  /** Builds the view on `db` (a transaction that just wrote, so it sees the write). */
  async build(db: Queryable, userId: string): Promise<AccountViewResult> {
    return accountView(db, userId);
  }

  /**
   * After a write is committed: a new version, with the view the write's
   * transaction built stored under it (so the next read is warm). When
   * Valkey cannot be written the old view may be served until it expires
   * (24 h); that is logged as an error.
   */
  async changed(userId: string, fresh?: AccountViewResult): Promise<number | null> {
    let version: number;
    try {
      version = await bumpVersion(this.redis, this.keys.meVersion(userId));
    } catch (error) {
      this.log.error({ err: error }, 'account: version not bumped; the cached view is stale until it expires');
      return null;
    }
    if (fresh) await this.store(userId, version, fresh);
    return version;
  }

  private async store(userId: string, version: number, result: AccountViewResult): Promise<void> {
    try {
      const body = deflateRawSync(Buffer.from(JSON.stringify(result)));
      await this.cache.set(this.keys.meView(userId, version), body, 'EX', ME_VIEW_TTL_SECONDS);
    } catch (error) {
      this.log.warn({ err: error }, 'account: view not cached');
    }
  }
}

export type { AccountView, AccountViewResult };
