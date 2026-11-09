import { SlotLease, createKeys } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { WorkerConfig } from './config.js';
import { createWorkerRedis } from './redis.js';

/**
 * A worker without WORKER_ID takes the lowest free slot of a Valkey lease
 * (`wslot:<n>`) and is named `w<n>`: names stay the same across restarts
 * (stream groups do not collect a consumer per deploy) and two running
 * workers never share one, however many replicas run. The lease lives 30
 * seconds after its last refresh (every 10), so a worker that died frees
 * its name by itself.
 */

export const WORKER_SLOTS = 256;

export interface WorkerSlotEvents {
  /** Another process holds the slot now: this one must stop using the name (exit and start again). */
  onLost(): void;
  onExpired?(): void;
  onRefreshFailed?(error: unknown): void;
}

export interface HeldWorkerSlot {
  config: WorkerConfig;
  lease: SlotLease;
  /** Releases the slot and closes its connection. */
  release(): Promise<void>;
}

/** Waits until a slot is taken (Valkey may still be starting), then names the configuration after it. */
export async function takeWorkerSlot(
  config: WorkerConfig,
  events: WorkerSlotEvents,
  options: { redis?: Redis | undefined; retryMs?: number | undefined; onWait?: ((error: unknown) => void) | undefined } = {},
): Promise<HeldWorkerSlot> {
  const redis = options.redis ?? createWorkerRedis(config.redis.url, 'worker-slot');
  const own = options.redis === undefined;
  const keys = createKeys(config.redis.keyPrefix);
  for (;;) {
    try {
      const lease = await SlotLease.acquire({
        redis,
        keys,
        name: 'wslot',
        slots: WORKER_SLOTS,
        onLost: () => events.onLost(),
        onExpired: () => events.onExpired?.(),
        onRefreshFailed: (error) => events.onRefreshFailed?.(error),
      });
      return {
        config: { ...config, workerId: `w${lease.slot}` },
        lease,
        async release() {
          await lease.stop();
          if (own) await redis.quit().catch(() => redis.disconnect());
        },
      };
    } catch (error) {
      options.onWait?.(error);
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2_000));
    }
  }
}
