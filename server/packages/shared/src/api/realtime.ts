import { z } from 'zod';
import { PUBLIC_UID_PATTERN, timeSchema } from './common.js';

/** The one personal channel of a user: `u:#<publicUid>` (a Centrifugo user-limited channel). */
export function userChannel(publicUid: string): string {
  if (!PUBLIC_UID_PATTERN.test(publicUid)) throw new TypeError('not a public user id');
  return `u:#${publicUid}`;
}

/** `POST /v1/realtime/token`: a connection token for the personal channel. */
export const realtimeTokenSchema = z.object({
  wsUrl: z.url({ protocol: /^wss?$/ }),
  token: z.string().min(1),
  expiresAt: timeSchema,
  channel: z.string().regex(/^u:#[a-z2-7]{13}$/),
});
export type RealtimeToken = z.infer<typeof realtimeTokenSchema>;
