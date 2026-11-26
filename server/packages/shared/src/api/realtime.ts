import { z } from 'zod';
import { PUBLIC_UID_PATTERN, timeSchema } from './common.js';

/** The one personal channel of a user: `user:#<publicUid>` (a Centrifugo user-limited channel). */
export function userChannel(publicUid: string): string {
  if (!PUBLIC_UID_PATTERN.test(publicUid)) throw new TypeError('not a public user id');
  return `user:#${publicUid}`;
}

/**
 * The `meta` claim of a connection token, which Centrifugo hands the
 * subscribe check of every subscription on that connection: the session
 * (`sid`) and the issue time of the access token it was minted with (`ati`,
 * unix seconds), checked against the access-token deny list. Not strict:
 * keys added later do not refuse a connection.
 */
export const realtimeConnectionMetaSchema = z.object({
  sid: z.string().regex(/^[1-9][0-9]{0,18}$/),
  ati: z.number().int().positive(),
});
export type RealtimeConnectionMeta = z.infer<typeof realtimeConnectionMetaSchema>;

/** The disconnect a refused subscription closes its connection with: a terminal code (4500-4999), so the client does not reconnect with the same token. */
export const REALTIME_DISCONNECT_REVOKED = { code: 4501, reason: 'revoked' } as const;

/** `POST /v1/realtime/token`: a connection token for the personal channel. */
export const realtimeTokenSchema = z.object({
  wsUrl: z.url({ protocol: /^wss?$/ }),
  token: z.string().min(1),
  expiresAt: timeSchema,
  channel: z.string().regex(/^user:#[a-z2-7]{13}$/),
});
export type RealtimeToken = z.infer<typeof realtimeTokenSchema>;
