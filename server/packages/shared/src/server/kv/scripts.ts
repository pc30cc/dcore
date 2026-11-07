import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

/**
 * Lua scripts live as `.lua` files next to their loader. A script receives
 * every key it touches in `KEYS[]` (full names, deployment prefix included)
 * and never builds a key name itself.
 */
export interface LuaScript {
  readonly name: string;
  readonly source: string;
  readonly numberOfKeys: number | null;
}

/** Reads a script file once; `numberOfKeys` null means the caller passes the count (variable KEYS). */
export function luaScript(url: URL, name: string, numberOfKeys: number | null): LuaScript {
  return { name, source: readFileSync(url, 'utf8'), numberOfKeys };
}

/**
 * Runs a script with EVALSHA, loading it on NOSCRIPT (after a restart or a
 * SCRIPT FLUSH), so the source crosses the network once per server.
 */
export async function runScript(redis: Redis, script: LuaScript, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
  if (script.numberOfKeys !== null && keys.length !== script.numberOfKeys) {
    throw new TypeError(`${script.name} takes ${script.numberOfKeys} key(s), got ${keys.length}`);
  }
  const sha = scriptSha(script);
  try {
    return await redis.evalsha(sha, keys.length, ...keys, ...args.map(String));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
    return redis.eval(script.source, keys.length, ...keys, ...args.map(String));
  }
}

const shas = new WeakMap<LuaScript, string>();

function scriptSha(script: LuaScript): string {
  let sha = shas.get(script);
  if (sha === undefined) {
    // SHA-1 is what Redis names scripts by; it is not used for security here.
    sha = createHash('sha1').update(script.source).digest('hex');
    shas.set(script, sha);
  }
  return sha;
}
