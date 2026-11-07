import type { ClientIpResolver } from '@app/shared/server';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The client's public address: `cf-connecting-ip` when the edge
     * (`request.ip` under TRUST_PROXY) is Cloudflare's, else the edge itself;
     * null when no public address can be known (local development).
     */
    readonly clientIp: string | null;
    /** The country Cloudflare saw (ISO alpha-2), only for requests that came through it. */
    readonly clientCountry: string | null;
  }
}

const RESOLVED = Symbol('clientAddress');

/** Resolves the client address once per request, on first use. */
export const clientIpPlugin = fp<{ resolver: ClientIpResolver }>(
  async (app, { resolver }) => {
    type WithAddress = { [RESOLVED]?: ReturnType<ClientIpResolver['resolve']> };
    const resolve = (request: { ip: string; headers: Record<string, string | string[] | undefined> } & WithAddress) =>
      (request[RESOLVED] ??= resolver.resolve({ edgeIp: request.ip, headers: request.headers }));
    app.decorateRequest('clientIp', {
      getter() {
        return resolve(this).ip;
      },
    });
    app.decorateRequest('clientCountry', {
      getter() {
        return resolve(this).country;
      },
    });
  },
  { name: 'client-ip', fastify: '5.x' },
);
