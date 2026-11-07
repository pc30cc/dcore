import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Revoking access tokens before they expire. Access tokens are verified in
 * memory and live 15 minutes; a sign-out, a ban or a deletion must take
 * effect at once, so every authenticated request also reads two Valkey keys
 * in one round trip (`MGET deny:sid:<sid> deny:uid:<uid>`):
 *
 * - `deny:sid:<sid>`: one session is revoked (logout, refresh reuse);
 * - `deny:uid:<uid>`: every token of the user issued up to the stored time
 *   (unix seconds) is revoked ("sign out everywhere", ban, deletion). Tokens
 *   issued after it, such as those of a session signed in later, pass: a
 *   revocation never locks a person out of a new sign-in.
 *
 * Both keys live as long as a token issued just before them could
 * (access TTL plus the clock tolerance plus a margin), so they never pile up.
 * `iat` has a resolution of one second: a token signed in the same second
 * as a user-wide revocation counts as before it (the client's next refresh,
 * a second later, gets a token that passes).
 *
 * The API reads the list on every request; the worker writes it too (bans,
 * deletions), which is why it lives here.
 */

const revokeUserScript = luaScript(new URL('./revokeUser.lua', import.meta.url), 'deny-user', 1);

export interface DenyListOptions {
  redis: Redis;
  keys: KeyBuilder;
  /** The access token lifetime (`AUTH_ACCESS_TOKEN_TTL_SECONDS`). */
  accessTokenTtlSeconds: number;
  /** The verifier's clock tolerance (`AUTH_CLOCK_SKEW_SECONDS`). */
  clockSkewSeconds: number;
}

const MARGIN_SECONDS = 30;

export type DenyVerdict = 'allowed' | 'session_revoked' | 'user_revoked';

export class DenyList {
  private readonly redis: Redis;
  private readonly keys: KeyBuilder;
  readonly ttlSeconds: number;

  constructor(options: DenyListOptions) {
    this.redis = options.redis;
    this.keys = options.keys;
    this.ttlSeconds = options.accessTokenTtlSeconds + options.clockSkewSeconds + MARGIN_SECONDS;
  }

  /** Revokes the access tokens of one session. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.redis.set(this.keys.denySession(sessionId), '1', 'EX', this.ttlSeconds);
  }

  /**
   * Revokes every access token of a user issued up to `at` (now by default).
   * Never moves the cutoff back: a later revocation only extends it.
   */
  async revokeUser(userId: string, at: Date = new Date()): Promise<void> {
    const cutoff = Math.floor(at.getTime() / 1_000);
    await runScript(this.redis, revokeUserScript, [this.keys.denyUser(userId)], [cutoff, this.ttlSeconds]);
  }

  /** One round trip: is this token revoked? `userId` null checks the session only. */
  async check(sessionId: string, userId: string | null, issuedAt: Date): Promise<DenyVerdict> {
    const keys = [this.keys.denySession(sessionId)];
    if (userId !== null) keys.push(this.keys.denyUser(userId));
    const [session, user] = await this.redis.mget(...keys);
    if (session !== null && session !== undefined) return 'session_revoked';
    if (user !== null && user !== undefined && Math.floor(issuedAt.getTime() / 1_000) <= Number(user)) return 'user_revoked';
    return 'allowed';
  }
}
