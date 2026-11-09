import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { KeyBuilder } from '../kv/keys.js';

/**
 * Purchase tokens on the request path. A token is looked up by its SHA-256
 * (`store_purchases.token_hash`); the token itself goes only to the store.
 *
 * - `iap:lock:<hash>` (kv-core, NX, 60 s): one verification of a token at a
 *   time, so a double tap or the app's outbox never makes two store calls.
 * - `iap:t:<store>:<hash>` (kv-cache, 30 days): what the server recorded the
 *   last time it verified the token (its row, owner and state), so a repeat
 *   of a known token, and a restore of tokens the server has, cost no
 *   statement. Lost to eviction, it is read again from PostgreSQL (one read).
 */

export const PURCHASE_LOCK_SECONDS = 60;
export const TOKEN_RECORD_TTL_SECONDS = 30 * 86_400;

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const tokenRecordSchema = z.object({
  /** store_purchases.id */
  p: z.string().regex(/^[1-9][0-9]{0,18}$/),
  /** The owner (raw id); null while unclaimed. */
  u: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(),
  /** store_purchases.state */
  s: z.number().int().min(1).max(12),
  /** store_products.id */
  r: z.number().int().positive(),
  /** Expiry (epoch ms), subscriptions only. */
  x: z.number().int().nullable(),
});
export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export async function readTokenRecords(cache: Redis, keys: KeyBuilder, store: number, hashes: readonly string[]): Promise<(TokenRecord | null)[]> {
  if (hashes.length === 0) return [];
  const raw = await cache.mget(...hashes.map((h) => keys.iapToken(store, h)));
  return raw.map((value) => {
    if (!value) return null;
    try {
      const parsed = tokenRecordSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
}

export async function writeTokenRecord(cache: Redis, keys: KeyBuilder, store: number, hash: string, record: TokenRecord): Promise<void> {
  await cache.set(keys.iapToken(store, hash), JSON.stringify(record), 'EX', TOKEN_RECORD_TTL_SECONDS);
}

/** Takes the verification lock of a token; the returned value releases it (only while it is still ours). */
export async function lockPurchaseToken(redis: Redis, keys: KeyBuilder, hash: string, seconds: number = PURCHASE_LOCK_SECONDS): Promise<string | null> {
  const value = randomBytes(9).toString('base64url');
  const ok = await redis.set(keys.iapLock(hash), value, 'EX', seconds, 'NX');
  return ok === 'OK' ? value : null;
}

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export async function unlockPurchaseToken(redis: Redis, keys: KeyBuilder, hash: string, value: string): Promise<void> {
  await redis.eval(RELEASE, 1, keys.iapLock(hash), value);
}
