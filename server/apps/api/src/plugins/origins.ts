import { OriginsKeyError, OriginsSigner } from '@app/shared/server';
import fp from 'fastify-plugin';
import { OriginsService, originDefaults } from '../services/origins.js';

/**
 * `app.origins`: the signed origins document in memory, following the
 * configuration snapshot (`app.cfg`), so `GET /v1/origins` sends no
 * statement. Registered after the account services (it needs the brand and
 * the configuration) and before the routes that hand out hosts (realtime,
 * calls), which follow the panel's hosts once it saved some.
 */

declare module 'fastify' {
  interface FastifyInstance {
    origins: OriginsService;
  }
}

export interface OriginsOptions {
  /** A clock (tests). */
  now?: (() => number) | undefined;
}

export const originsPlugin = fp<OriginsOptions>(
  async (app, options) => {
    const log = app.log.child({ component: 'origins' });
    const { signingKey, kid, ttlSeconds } = app.config.origins;
    let signer: OriginsSigner | null = null;
    if (signingKey) {
      try {
        signer = new OriginsSigner(kid, signingKey);
      } catch (error) {
        // The message names the problem, never the key.
        throw new Error(`ORIGINS_SIGNING_KEY: ${error instanceof OriginsKeyError ? error.message : 'not usable'}`, { cause: error });
      }
      const listed = app.brand.origins.publicKeys;
      if (listed.length === 0) {
        log.warn({ kid, publicKey: signer.publicKey }, 'origins: brand.json lists no public key; apps built from it cannot check the document');
      } else if (!listed.some((entry) => entry.kid === kid && entry.key === signer?.publicKey)) {
        log.error({ kid, publicKey: signer.publicKey }, 'origins: the signing key is not in brand.json origins.publicKeys under its id; apps will refuse the document');
      }
    } else if (app.config.env === 'production') {
      log.error('origins: ORIGINS_SIGNING_KEY is not set; GET /v1/origins answers 503 and apps keep the hosts they were built with');
    }
    const service = new OriginsService({
      brandId: app.brand.id,
      signer,
      defaults: originDefaults(app.brand, app.config, log),
      ttlSeconds,
      redis: app.redis,
      keys: app.keys,
      log,
      now: options.now,
    });
    app.decorate('origins', service);
    app.cfg.onLoad((snapshot) => service.update(snapshot.app['origins.hosts']));
    app.addHook('onReady', async () => {
      service.start();
    });
    app.addHook('onClose', async () => {
      await service.stop();
    });
  },
  { name: 'origins', fastify: '5.x', dependencies: ['account-services'] },
);
