import { CentrifugoPresence, type PresenceReader } from '@app/shared/server';
import fp from 'fastify-plugin';

/**
 * What the chat routes share: `app.presence`, who is online as Centrifugo
 * knows it (null without Centrifugo's server API: nobody is shown online).
 */

declare module 'fastify' {
  interface FastifyInstance {
    presence: PresenceReader | null;
  }
}

export interface ChatOptions {
  /** A presence reader of the caller's (tests pass a fake; null: none). */
  presence?: PresenceReader | null | undefined;
}

export const chatPlugin = fp<ChatOptions>(
  async (app, options) => {
    const api = app.config.realtime.api;
    const presence = options.presence !== undefined ? options.presence : api ? new CentrifugoPresence(api) : null;
    app.decorate('presence', presence);
  },
  { name: 'chat', fastify: '5.x' },
);
