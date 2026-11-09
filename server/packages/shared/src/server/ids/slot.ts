import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * A numbered slot held with a Valkey lease (`<name>:<n>`, the lowest free
 * number): a process name that stays the same across restarts and is never
 * held by two running processes, such as a worker's id (stream consumer
 * and queue worker names), without a fixed value in the deployment.
 *
 * The lease is refreshed every `refreshMs` and expires `ttlMs` after the
 * last refresh, so a process that died frees its slot by itself. When no
 * refresh succeeded for a whole lease, `onExpired` says so (another process
 * may take the slot meanwhile) and refreshing goes on. A refresh that finds
 * the lease gone (Valkey restarted, or was out of reach longer than the
 * lease) takes the same slot again when it is still free; when another
 * process holds it now, `onLost` is called and the slot is not refreshed
 * any more: the process should stop using the name.
 */

const acquire = luaScript(new URL('./acquire.lua', import.meta.url), 'slot.acquire', null);
const refresh = luaScript(new URL('./refresh.lua', import.meta.url), 'slot.refresh', 1);
const release = luaScript(new URL('./release.lua', import.meta.url), 'slot.release', 1);

export class SlotsTakenError extends Error {
  constructor(name: string, slots: number) {
    super(`all ${slots} "${name}" slots are held`);
    this.name = 'SlotsTakenError';
  }
}

export interface SlotLeaseOptions {
  redis: Redis;
  keys: KeyBuilder;
  /** The lease family, e.g. `wslot`. */
  name: string;
  slots?: number | undefined;
  ttlMs?: number | undefined;
  refreshMs?: number | undefined;
  /** Another process holds the slot now. */
  onLost?: (() => void) | undefined;
  /** No refresh succeeded for a whole lease (called once per outage). */
  onExpired?: (() => void) | undefined;
  onRefreshFailed?: ((error: unknown) => void) | undefined;
  /** A monotonic clock in ms (tests). */
  clock?: (() => number) | undefined;
}

export class SlotLease {
  readonly slot: number;
  private readonly key: string;
  private readonly token: string;
  private readonly options: SlotLeaseOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastRefresh: number;
  private lost = false;
  private expiredSaid = false;
  private stopped = false;
  private refreshing = false;

  private constructor(options: SlotLeaseOptions, slot: number, token: string) {
    this.options = options;
    this.slot = slot;
    this.token = token;
    this.key = options.keys.raw(options.name, slot);
    this.lastRefresh = this.now();
  }

  /** Takes the lowest free slot (64 names per round trip); throws {@link SlotsTakenError} when every one is held. */
  static async acquire(options: SlotLeaseOptions): Promise<SlotLease> {
    const slots = options.slots ?? 256;
    const ttlMs = options.ttlMs ?? 30_000;
    const token = randomUUID();
    for (let start = 0; start < slots; start += 64) {
      const names = Array.from({ length: Math.min(64, slots - start) }, (_, i) => options.keys.raw(options.name, start + i));
      const index = Number(await runScript(options.redis, acquire, names, [token, ttlMs]));
      if (index > 0) {
        const lease = new SlotLease(options, start + index - 1, token);
        lease.schedule();
        return lease;
      }
    }
    throw new SlotsTakenError(options.name, slots);
  }

  private now(): number {
    return (this.options.clock ?? (() => performance.now()))();
  }

  private schedule(): void {
    this.timer = setInterval(() => void this.refreshNow(), this.options.refreshMs ?? 10_000);
    this.timer.unref();
  }

  private checkExpired(): void {
    if (!this.expiredSaid && this.now() - this.lastRefresh >= (this.options.ttlMs ?? 30_000)) {
      this.expiredSaid = true;
      this.options.onExpired?.();
    }
  }

  /** One refresh (also what the timer runs); while one waits for Valkey, the next only checks the lease's age. */
  async refreshNow(): Promise<void> {
    if (this.lost || this.stopped) return;
    if (this.refreshing) {
      this.checkExpired();
      return;
    }
    this.refreshing = true;
    try {
      await this.refreshOnce();
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const ttlMs = this.options.ttlMs ?? 30_000;
    try {
      let held = Number(await runScript(this.options.redis, refresh, [this.key], [this.token, ttlMs])) === 1;
      // The lease expired (Valkey restarted, or was out of reach for a while): take the same slot back when it is free.
      if (!held) held = (await this.options.redis.set(this.key, this.token, 'PX', ttlMs, 'NX')) === 'OK';
      if (!held) {
        this.lose();
        return;
      }
      this.lastRefresh = this.now();
      this.expiredSaid = false;
    } catch (error) {
      this.options.onRefreshFailed?.(error);
      this.checkExpired();
    }
  }

  /** Whether the slot was lost to another process. */
  get isLost(): boolean {
    return this.lost;
  }

  private lose(): void {
    if (this.lost) return;
    this.lost = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.options.onLost?.();
  }

  /** Frees the slot (only while this process still holds it). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.lost || this.stopped) return;
    this.stopped = true;
    await runScript(this.options.redis, release, [this.key], [this.token]).catch(() => undefined);
  }
}
