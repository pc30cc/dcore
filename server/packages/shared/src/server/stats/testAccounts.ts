import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { STATS_TEST_IDS_TTL_SECONDS } from './snapshot.js';

/**
 * The raw ids of test accounts (users.flags & 1), held by the worker so the
 * statistics leave them out without reading users per job: loaded through
 * `load` (one statement on users_test_idx) and kept `maxAgeMs`, or until
 * `version` (`stats:testv`, a new value on every flip) reads another value
 * than it did before the load; the version is looked at no more than every
 * `checkMs`, by the next caller. A reload that fails keeps the last good set
 * and is tried again after `checkMs`; `has` answers from the set already
 * loaded (empty before the first load) and starts a reload when one is due.
 */
export class TestAccounts {
  private readonly load: () => Promise<readonly string[]>;
  private readonly versionOf: (() => Promise<string | null>) | undefined;
  private readonly maxAgeMs: number;
  private readonly checkMs: number;
  private readonly now: () => number;
  private set: ReadonlySet<string> = new Set();
  private list: readonly string[] = [];
  private loadedAt: number | null = null;
  private loadedVersion: string | null | undefined = undefined;
  private triedAt: number | null = null;
  private loading: Promise<readonly string[]> | null = null;
  private readonly onError: (error: unknown) => void;

  constructor(options: {
    load: () => Promise<readonly string[]>;
    /** The value of `stats:testv` (null: no flip since it was lost); absent: only `maxAgeMs` reloads. */
    version?: (() => Promise<string | null>) | undefined;
    maxAgeMs?: number | undefined;
    checkMs?: number | undefined;
    now?: (() => number) | undefined;
    onError?: ((error: unknown) => void) | undefined;
  }) {
    this.load = options.load;
    this.versionOf = options.version;
    this.maxAgeMs = options.maxAgeMs ?? 600_000;
    this.checkMs = options.checkMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  private stale(): boolean {
    return this.loadedAt === null || this.now() - this.loadedAt >= this.maxAgeMs;
  }

  private due(): boolean {
    if (this.triedAt !== null && this.now() - this.triedAt < this.checkMs) return false;
    return this.stale() || this.versionOf !== undefined;
  }

  /** The ids, reloaded first when stale or when the version moved (a failed reload answers the last good set). */
  async ids(): Promise<readonly string[]> {
    if (this.loading) return this.loading;
    if (!this.due()) return this.list;
    this.loading = this.refresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async refresh(): Promise<readonly string[]> {
    this.triedAt = this.now();
    // Unreadable: the value read last stands (an older value can only fail to match, never match a newer flip).
    let version = this.loadedVersion;
    if (this.versionOf) {
      let read = false;
      try {
        version = await this.versionOf();
        read = true;
      } catch (error) {
        this.onError(error);
      }
      // Fresh, and no flip since the load (or the version unreadable): the set stays.
      if (!this.stale() && (!read || version === this.loadedVersion)) return this.list;
    }
    try {
      const ids = await this.load();
      this.list = [...ids];
      this.set = new Set(ids);
      this.loadedAt = this.now();
      this.loadedVersion = version;
      return this.list;
    } catch (error) {
      this.onError(error);
      return this.list;
    }
  }

  /** Whether a load has succeeded once (before that `has` knows no test account). */
  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  /**
   * The value of `stats:testv` read last before the set now held was loaded
   * (null: the key was missing); undefined: none read yet, or no version source.
   */
  get version(): string | null | undefined {
    return this.loadedVersion;
  }

  /** Whether a version source was given (else the set follows `maxAgeMs` only). */
  get followsFlips(): boolean {
    return this.versionOf !== undefined;
  }

  /** Whether `uid` is a test account, from the set already loaded. */
  has(uid: string): boolean {
    if (this.loading === null && this.due()) void this.ids();
    return this.set.has(uid);
  }
}

/**
 * A member of `stats:testids` that is no raw id: the set exists while its
 * writers keep it, even with no test account in it, so the live read never
 * falls back to an older count because the last id was removed.
 */
export const STATS_TEST_IDS_NONE = '-';

/** A value of `stats:testv` that no earlier flip wrote (random, so a lost and recreated key never repeats one). */
function newTestVersion(): string {
  return randomBytes(8).toString('hex');
}

/**
 * After a test flag was written (the commit done): the person goes into or
 * out of `stats:testids` at once and `stats:testv` takes a new value, in one
 * MULTI, so the live read subtracts the right people now and every
 * TestAccounts set reloads on its next look. Throws when Valkey refuses.
 */
export async function announceTestAccount(redis: Redis, keys: KeyBuilder, uid: string, test: boolean): Promise<void> {
  const key = keys.statsTestIds();
  const multi = redis.multi();
  if (test) multi.sadd(key, STATS_TEST_IDS_NONE, uid).expire(key, STATS_TEST_IDS_TTL_SECONDS, 'NX');
  else multi.srem(key, uid);
  const replies = await multi.set(keys.statsTestVersion(), newTestVersion()).exec();
  if (!replies) throw new Error('test account: no answer from Valkey');
  const failed = replies.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}
