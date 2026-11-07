import type { Redis } from 'ioredis';
import { luaScript, runScript } from './scripts.js';

/**
 * Version counters behind ETags and versioned cache keys (`mev:<uid>` for
 * the own account, later `cv:<uid>` for conversation lists). A value is
 * never handed out twice for the same key, even after the key expired or
 * Valkey lost it: a counter starts at the current time in milliseconds and a
 * bump moves to `max(now, current + 1)`, so an ETag a client kept from
 * before can never match a newer state by accident.
 */

const versionScript = luaScript(new URL('./version.lua', import.meta.url), 'version', 1);
const bumpFromScript = luaScript(new URL('./versionBumpFrom.lua', import.meta.url), 'version-bump-from', 1);

/** Thirty days, renewed on every read and bump. */
export const VERSION_TTL_SECONDS = 30 * 24 * 3_600;

function asVersion(reply: unknown): number {
  const value = typeof reply === 'number' ? reply : Number(reply);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('version counter returned a non-positive value');
  return value;
}

/** The current version (started when missing). */
export async function readVersion(redis: Redis, key: string, now: number = Date.now()): Promise<number> {
  return asVersion(await runScript(redis, versionScript, [key], [now, VERSION_TTL_SECONDS, 'read']));
}

/** A new version, after a change is durable. */
export async function bumpVersion(redis: Redis, key: string, now: number = Date.now()): Promise<number> {
  return asVersion(await runScript(redis, versionScript, [key], [now, VERSION_TTL_SECONDS, 'bump']));
}

/**
 * A new version, after a change is durable, and whether the counter still
 * held `seen` (the value read before the change): only then can nothing
 * newer have been announced in between, so a view built inside the change
 * may be stored under the new version.
 */
export async function bumpVersionFrom(redis: Redis, key: string, seen: number, now: number = Date.now()): Promise<{ version: number; unchanged: boolean }> {
  const reply = await runScript(redis, bumpFromScript, [key], [now, VERSION_TTL_SECONDS, seen]);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('version counter returned an unexpected reply');
  return { version: asVersion(reply[0]), unchanged: Number(reply[1]) === 1 };
}
