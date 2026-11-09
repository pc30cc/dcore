import { createHmac, randomBytes } from 'node:crypto';

/**
 * Time-limited TURN credentials for coturn's `use-auth-secret` (the TURN
 * REST scheme): the username is `<expiry unix seconds>:r<16 random hex>` and
 * the password is base64(HMAC-SHA1(shared secret, username)). The username
 * names nothing (no call, no person): it is all the relay logs and all a
 * packet capture shows.
 *
 * The lifetime is the relay setting's (6 h by default), not the LiveKit
 * token's: clients keep their ICE servers for the whole call and reuse them
 * on every reconnect, and coturn refuses a new allocation once the
 * username's expiry has passed.
 */

export interface TurnCredential {
  username: string;
  credential: string;
  expiresAtMs: number;
}

/** The password of a username under a shared secret. */
export function turnPassword(sharedSecret: string, username: string): string {
  return createHmac('sha1', sharedSecret).update(username).digest('base64');
}

export function mintTurnCredential(options: {
  sharedSecret: string;
  ttlSeconds: number;
  now?: number | undefined;
  /** 8 random bytes (tests pass fixed ones). */
  nonce?: Buffer | undefined;
}): TurnCredential {
  if (options.sharedSecret.length === 0) throw new TypeError('a TURN credential needs the shared secret');
  const now = options.now ?? Date.now();
  const expiry = Math.floor(now / 1_000) + options.ttlSeconds;
  const nonce = options.nonce ?? randomBytes(8);
  if (nonce.length !== 8) throw new RangeError('the username nonce is 8 bytes');
  const username = `${expiry}:r${nonce.toString('hex')}`;
  return { username, credential: turnPassword(options.sharedSecret, username), expiresAtMs: expiry * 1_000 };
}
