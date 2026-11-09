import type { Redis } from 'ioredis';
import { userChannel } from '../../api/realtime.js';
import { bodySnippet, defaultFetch, fetchWithTimeout, isRetryableStatus, ProviderError, type Fetch } from '../clients/http.js';
import type { KeyBuilder } from '../kv/keys.js';
import { chatKeys, PRESENCE_TTL_SECONDS } from './keys.js';

/**
 * Who is online, as Centrifugo knows it: a person is online while one of
 * their connections is subscribed to their personal channel. The server
 * reads it with `presence_stats` (one `/api/batch` for the people on a
 * page; no client can read presence) and keeps each answer 30 s in
 * kv-cache (`pres:<uid>`), so a list costs Centrifugo at most one call per
 * person per half minute. Whether a person is *shown* online is the
 * caller's business (their `showOnline`).
 */
export interface PresenceReader {
  /** Public uid → online, for each person asked. */
  online(publicUids: readonly string[]): Promise<Map<string, boolean>>;
}

interface BatchReply {
  error?: { code?: number; message?: string };
  replies?: { presence_stats?: { num_clients?: number; num_users?: number }; error?: { code?: number } }[];
}

export class CentrifugoPresence implements PresenceReader {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;

  constructor(options: { apiUrl: string; apiKey: string; fetch?: Fetch | undefined; timeoutMs?: number | undefined }) {
    this.base = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  async online(publicUids: readonly string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (publicUids.length === 0) return out;
    const commands = publicUids.map((uid) => ({ presence_stats: { channel: userChannel(uid) } }));
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        `${this.base}/api/batch`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey }, body: JSON.stringify({ commands, parallel: true }) },
        this.timeoutMs,
      );
    } catch (error) {
      throw new ProviderError('centrifugo', 'batch unreachable', { retryable: true, cause: error });
    }
    if (!response.ok) {
      throw new ProviderError('centrifugo', `batch answered ${response.status}: ${await bodySnippet(response)}`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }
    const reply = (await response.json()) as BatchReply;
    if (reply.error) throw new ProviderError('centrifugo', `batch refused: ${reply.error.code ?? '?'}`, { retryable: reply.error.code === 100 });
    publicUids.forEach((uid, i) => {
      const stats = reply.replies?.[i]?.presence_stats;
      // A channel with nobody in it answers zeros (or nothing at all).
      out.set(uid, (stats?.num_users ?? 0) > 0 || (stats?.num_clients ?? 0) > 0);
    });
    return out;
  }
}

/** Presence for tests and for development without Centrifugo. */
export class FakePresence implements PresenceReader {
  readonly onlineUids = new Set<string>();
  calls = 0;
  failWith: Error | null = null;

  async online(publicUids: readonly string[]): Promise<Map<string, boolean>> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return new Map(publicUids.map((uid) => [uid, this.onlineUids.has(uid)]));
  }
}

export interface PresenceLookup {
  cache: Redis;
  keys: KeyBuilder;
  reader: PresenceReader | null;
  publicUidOf(userId: string): string;
  log?: { warn(object: object, message: string): void } | undefined;
}

/**
 * Online or not for each person (raw ids): the kept answers, the others
 * asked in one call and kept 30 s. Without Centrifugo, or when it cannot be
 * reached, nobody unknown is online (and nothing is kept).
 */
export async function onlineOf(lookup: PresenceLookup, userIds: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return out;
  const c = chatKeys(lookup.keys);
  let kept: (string | null)[] = [];
  try {
    kept = await lookup.cache.mget(...unique.map((id) => c.presence(id)));
  } catch (error) {
    lookup.log?.warn({ err: error }, 'presence: kept answers unreadable');
  }
  const unknown: string[] = [];
  unique.forEach((id, i) => {
    const value = kept[i];
    if (value === '1' || value === '0') out.set(id, value === '1');
    else unknown.push(id);
  });
  if (unknown.length === 0 || !lookup.reader) {
    for (const id of unknown) out.set(id, false);
    return out;
  }
  try {
    const asked = await lookup.reader.online(unknown.map((id) => lookup.publicUidOf(id)));
    const pipeline = lookup.cache.pipeline();
    for (const id of unknown) {
      const online = asked.get(lookup.publicUidOf(id)) === true;
      out.set(id, online);
      pipeline.set(c.presence(id), online ? '1' : '0', 'EX', PRESENCE_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (error) {
    lookup.log?.warn({ err: error }, 'presence: not read');
    for (const id of unknown) if (!out.has(id)) out.set(id, false);
  }
  return out;
}

/** Notes that a person was active now (minute precision, kv-cache). */
export async function noteSeen(cache: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<void> {
  const minute = Math.floor(now / 60_000) * 60;
  await cache.set(chatKeys(keys).lastSeen(userId), String(minute), 'EX', 7 * 86_400);
}

/** When each person was last seen (unix seconds), or null. */
export async function lastSeenOf(cache: Redis, keys: KeyBuilder, userIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (userIds.length === 0) return out;
  const c = chatKeys(keys);
  const values = await cache.mget(...userIds.map((id) => c.lastSeen(id)));
  userIds.forEach((id, i) => {
    const n = Number(values[i]);
    out.set(id, values[i] !== null && Number.isSafeInteger(n) && n > 0 ? n : null);
  });
  return out;
}
