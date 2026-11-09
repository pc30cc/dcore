import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Valkey names of the origins document (kv-core):
 *
 * - `origins:doc` hash {v, t, b, body}: the newest signed document any API
 *   process made (version, issuedAt ms, the signer's start time, the body
 *   as served). The worker publishes `body` to the bootstrap targets.
 * - `origins:pub:<target>` hash {v, t, at, sha}: what was last published to
 *   one target (version, issuedAt ms, when, SHA-256 of the body).
 */
export function originsKeys(keys: KeyBuilder) {
  return {
    document: () => keys.raw('origins', 'doc'),
    published: (target: string) => keys.raw('origins', 'pub', target),
  };
}

const storeScript = luaScript(new URL('./storeDocument.lua', import.meta.url), 'origins.storeDocument', 1);

export interface StoredOrigins {
  version: number;
  issuedAtMs: number;
  body: string;
}

/** Stores a document unless the stored one is as new or newer; true when stored. */
export async function storeOriginsDocument(
  redis: Redis,
  keys: KeyBuilder,
  document: StoredOrigins & { signerStartedAtMs: number },
): Promise<boolean> {
  const stored = await runScript(redis, storeScript, [originsKeys(keys).document()], [
    document.version,
    document.issuedAtMs,
    document.signerStartedAtMs,
    document.body,
  ]);
  return stored === 1;
}

/** The newest stored document, or null before any API process signed one. */
export async function readOriginsDocument(redis: Redis, keys: KeyBuilder): Promise<StoredOrigins | null> {
  const [v = null, t = null, body = null] = await redis.hmget(originsKeys(keys).document(), 'v', 't', 'body');
  if (v === null || t === null || body === null) return null;
  const version = Number(v);
  const issuedAtMs = Number(t);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(issuedAtMs)) return null;
  return { version, issuedAtMs, body };
}
