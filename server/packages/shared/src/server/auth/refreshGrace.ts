import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * The 30-second refresh grace of a session (`rtg:<sid>`). A refresh token
 * is rotated once; a second refresh with the same token inside the grace
 * gets the same answer instead of counting as a reuse (two parts of an app
 * renewing at once, or a lost answer retried). Single flight: the first
 * request claims the token's entry, the others wait for its answer.
 *
 * Answers are stored sealed by the caller (they hold tokens). Entries are
 * keyed by the hash of the refresh token that was used, never the token.
 */

const graceScript = luaScript(new URL('./refreshGrace.lua', import.meta.url), 'refresh-grace', 2);

export type GraceClaim = { state: 'claimed' } | { state: 'pending' } | { state: 'done'; answer: string } | { state: 'limited'; retryAfterMs: number };

export interface RefreshGraceOptions {
  redis: Redis;
  keys: KeyBuilder;
  /** How long an answer is handed out again (30 s). */
  graceMs?: number | undefined;
  /** How long an in-flight claim blocks others before it is considered lost. */
  inFlightMs?: number | undefined;
}

export class RefreshGrace {
  private readonly redis: Redis;
  private readonly keys: KeyBuilder;
  readonly graceMs: number;
  readonly inFlightMs: number;

  constructor(options: RefreshGraceOptions) {
    this.redis = options.redis;
    this.keys = options.keys;
    this.graceMs = options.graceMs ?? 30_000;
    this.inFlightMs = options.inFlightMs ?? 10_000;
  }

  /**
   * Claims the refresh of `tokenHash` (hex) for `sessionId`, counting it
   * against the session's limit when `count` is set.
   */
  async claim(sessionId: string, tokenHash: string, limit: { count: boolean; cap: number; windowMs: number }): Promise<GraceClaim> {
    const reply = (await runScript(this.redis, graceScript, [this.keys.refreshGrace(sessionId), this.keys.rateLimit('refresh', sessionId)], [
      'claim',
      tokenHash,
      this.inFlightMs,
      limit.count ? 1 : 0,
      limit.cap,
      limit.windowMs,
    ])) as [string, unknown];
    switch (reply[0]) {
      case 'done':
        return { state: 'done', answer: String(reply[1]) };
      case 'pending':
        return { state: 'pending' };
      case 'limited':
        return { state: 'limited', retryAfterMs: Math.max(0, Number(reply[1])) };
      default:
        return { state: 'claimed' };
    }
  }

  /** Stores the answer of a claimed refresh for the grace period. */
  async complete(sessionId: string, tokenHash: string, answer: string): Promise<void> {
    await runScript(this.redis, graceScript, [this.keys.refreshGrace(sessionId), this.keys.rateLimit('refresh', sessionId)], ['complete', tokenHash, this.graceMs, answer]);
  }

  /** Gives up a claim (the refresh failed), so a retry is not kept waiting. */
  async release(sessionId: string, tokenHash: string): Promise<void> {
    await runScript(this.redis, graceScript, [this.keys.refreshGrace(sessionId), this.keys.rateLimit('refresh', sessionId)], ['release', tokenHash]);
  }

  /** Forgets every answer of a session (logout, revocation). */
  async forget(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await this.redis.del(...sessionIds.map((sid) => this.keys.refreshGrace(sid)));
  }
}
