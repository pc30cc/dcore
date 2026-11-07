import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import { composeId, ID_DATABASE_GENERATOR, ID_MAX_SEQUENCE } from '../../ids.js';
import { createKeys } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Mints application ids under a generator number leased in Valkey
 * (`idgen:<n>`, 60 s, refreshed every 20 s). Two processes never hold the
 * same number at once, and within a number ids are unique by (ms, sequence),
 * so ids are unique without asking the database.
 *
 * A process that cannot vouch for its lease stops minting instead of risking
 * a duplicate (a duplicate row would be dropped silently by the
 * write-behind's `ON CONFLICT DO NOTHING`):
 *
 * - no lease, or the last successful refresh is 40 s old or more (measured
 *   on the monotonic clock, so a GC pause or a frozen VM counts);
 * - the wall clock jumped by more than 1 s against the monotonic clock since
 *   the last refresh, in either direction: minting stops until the next
 *   refresh takes a new baseline;
 * - the wall clock is more than 50 ms behind the last id. Within 50 ms the
 *   generator keeps counting on the last id's millisecond (ids stay
 *   increasing and carry a time at most 50 ms ahead), which is what waiting
 *   for the clock would give, without blocking the event loop.
 */

export type IdUnavailableReason = 'no_lease' | 'lease_stale' | 'clock_jump' | 'clock_behind' | 'stopped';

export class IdGeneratorUnavailableError extends Error {
  readonly reason: IdUnavailableReason;

  constructor(reason: IdUnavailableReason) {
    super(`id generator unavailable: ${reason}`);
    this.name = 'IdGeneratorUnavailableError';
    this.reason = reason;
  }
}

export interface IdClock {
  /** Wall-clock milliseconds since 1970 (ids carry this time). */
  now(): number;
  /** A monotonic clock in milliseconds (pauses and steps of the wall clock do not move it). */
  monotonic(): number;
}

export const systemClock: IdClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export type IdGeneratorEvent =
  | { type: 'acquired'; generator: number }
  | { type: 'lost'; generator: number }
  | { type: 'refresh_failed'; error: unknown }
  | { type: 'exhausted' }
  | { type: 'clock_jump'; driftMs: number }
  | { type: 'released'; generator: number };

export interface IdGeneratorOptions {
  redis: Redis;
  /** The deployment key prefix (`REDIS_KEY_PREFIX`). */
  keyPrefix: string;
  /** What the lease key holds; defaults to `<host>:<pid>:<random>`. */
  holder?: string | undefined;
  leaseMs?: number | undefined;
  refreshMs?: number | undefined;
  maxStaleMs?: number | undefined;
  maxBehindMs?: number | undefined;
  maxJumpMs?: number | undefined;
  /** Refresh on a timer (default). Tests drive `refresh()` themselves. */
  autoRefresh?: boolean | undefined;
  clock?: IdClock | undefined;
  onEvent?: ((event: IdGeneratorEvent) => void) | undefined;
}

const acquireScript = luaScript(new URL('./acquire.lua', import.meta.url), 'idgen-acquire', null);
const refreshScript = luaScript(new URL('./refresh.lua', import.meta.url), 'idgen-refresh', 1);
const releaseScript = luaScript(new URL('./release.lua', import.meta.url), 'idgen-release', 1);

/** Lease numbers tried per round trip while looking for a free one. */
const ACQUIRE_BATCH = 64;

export class IdGenerator {
  private readonly redis: Redis;
  private readonly keys: ReturnType<typeof createKeys>;
  private readonly holder: string;
  private readonly leaseMs: number;
  private readonly refreshMs: number;
  private readonly maxStaleMs: number;
  private readonly maxBehindMs: number;
  private readonly maxJumpMs: number;
  private readonly autoRefresh: boolean;
  private readonly clock: IdClock;
  private readonly onEvent: (event: IdGeneratorEvent) => void;

  private held: number | null = null;
  private lastRefreshMono = Number.NEGATIVE_INFINITY;
  private baseWall = 0;
  private baseMono = 0;
  private suspended = false;
  private lastMs = 0;
  private sequence = 0;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private stopped = false;

  constructor(options: IdGeneratorOptions) {
    this.redis = options.redis;
    this.keys = createKeys(options.keyPrefix);
    this.holder = options.holder ?? `${hostname()}:${process.pid}:${randomBytes(6).toString('hex')}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.refreshMs = options.refreshMs ?? 20_000;
    this.maxStaleMs = options.maxStaleMs ?? 40_000;
    this.maxBehindMs = options.maxBehindMs ?? 50;
    this.maxJumpMs = options.maxJumpMs ?? 1_000;
    this.autoRefresh = options.autoRefresh ?? true;
    this.clock = options.clock ?? systemClock;
    this.onEvent = options.onEvent ?? (() => undefined);
    if (!(this.refreshMs < this.maxStaleMs && this.maxStaleMs < this.leaseMs)) {
      throw new RangeError('needs refreshMs < maxStaleMs < leaseMs');
    }
  }

  /** The leased generator number, or null. */
  get generator(): number | null {
    return this.held;
  }

  /**
   * Takes a lease (and starts refreshing it). Resolves once a number is held;
   * rejects when Valkey cannot be reached or every number is taken, in which
   * case the timer keeps trying.
   */
  async start(): Promise<number> {
    this.stopped = false;
    if (this.autoRefresh && this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, this.refreshMs);
      this.timer.unref();
    }
    await this.refresh();
    if (this.held === null) throw new IdGeneratorUnavailableError('no_lease');
    return this.held;
  }

  /** Extends the lease, or takes one when none is held. Never throws; failures are events. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.held !== null) {
        const extended = await runScript(this.redis, refreshScript, [this.keys.idLease(this.held)], [this.holder, this.leaseMs]);
        if (Number(extended) === 1) {
          this.renewed();
          return;
        }
        const lost = this.held;
        this.held = null;
        this.onEvent({ type: 'lost', generator: lost });
      }
      const acquired = await this.acquire();
      if (acquired === null) {
        this.onEvent({ type: 'exhausted' });
        return;
      }
      this.held = acquired;
      // A new number starts a new sequence space.
      this.lastMs = 0;
      this.sequence = 0;
      this.renewed();
      this.onEvent({ type: 'acquired', generator: acquired });
    } catch (error) {
      this.onEvent({ type: 'refresh_failed', error });
    }
  }

  private async acquire(): Promise<number | null> {
    for (let first = 0; first < ID_DATABASE_GENERATOR; first += ACQUIRE_BATCH) {
      const numbers: number[] = [];
      for (let n = first; n < Math.min(first + ACQUIRE_BATCH, ID_DATABASE_GENERATOR); n += 1) numbers.push(n);
      const index = Number(
        await runScript(this.redis, acquireScript, numbers.map((n) => this.keys.idLease(n)), [this.holder, this.leaseMs]),
      );
      if (index > 0) return numbers[index - 1] ?? null;
    }
    return null;
  }

  private renewed(): void {
    const mono = this.clock.monotonic();
    this.lastRefreshMono = mono;
    this.baseMono = mono;
    this.baseWall = this.clock.now();
    this.suspended = false;
  }

  /** The next id; throws {@link IdGeneratorUnavailableError} when the generator cannot vouch for it. */
  next(): bigint {
    if (this.stopped) throw new IdGeneratorUnavailableError('stopped');
    const generator = this.held;
    if (generator === null) throw new IdGeneratorUnavailableError('no_lease');
    const mono = this.clock.monotonic();
    if (mono - this.lastRefreshMono >= this.maxStaleMs) throw new IdGeneratorUnavailableError('lease_stale');
    if (this.suspended) throw new IdGeneratorUnavailableError('clock_jump');
    const wall = this.clock.now();
    const drift = wall - this.baseWall - (mono - this.baseMono);
    if (Math.abs(drift) > this.maxJumpMs) {
      this.suspended = true;
      this.onEvent({ type: 'clock_jump', driftMs: drift });
      throw new IdGeneratorUnavailableError('clock_jump');
    }
    let ms = Math.floor(wall);
    if (ms < this.lastMs) {
      if (this.lastMs - ms > this.maxBehindMs) throw new IdGeneratorUnavailableError('clock_behind');
      ms = this.lastMs;
    }
    let sequence = 0;
    if (ms === this.lastMs) {
      sequence = this.sequence + 1;
      if (sequence > ID_MAX_SEQUENCE) {
        ms += 1;
        sequence = 0;
        if (ms - wall > this.maxBehindMs) throw new IdGeneratorUnavailableError('clock_behind');
      }
    }
    this.lastMs = ms;
    this.sequence = sequence;
    return composeId({ ms, generator, sequence });
  }

  /** The next id as the decimal string the wire and the database drivers take. */
  nextId(): string {
    return this.next().toString();
  }

  /** Stops minting and refreshing, then frees the number for another process. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.refreshing;
    const held = this.held;
    this.held = null;
    if (held === null) return;
    try {
      await runScript(this.redis, releaseScript, [this.keys.idLease(held)], [this.holder]);
      this.onEvent({ type: 'released', generator: held });
    } catch (error) {
      // The lease expires by itself; nothing else to do.
      this.onEvent({ type: 'refresh_failed', error });
    }
  }
}

export function createIdGenerator(options: IdGeneratorOptions): IdGenerator {
  return new IdGenerator(options);
}
