import { loadBrand } from '@app/config';
import type { Brand } from '@app/shared';
import fp from 'fastify-plugin';
import { authSettingsFromConfig } from '../auth/settings.js';
import { AccountStore } from '../services/account.js';
import { ConfigService } from '../services/cfg.js';
import { CityIndex } from '../services/cities.js';
import type { OwnPhotoUrl } from '../services/me.js';

/**
 * The in-memory services of the account routes, as app decorations other
 * routes may use too:
 *
 * - `app.cfg`: the run-time configuration (app_config, catalogues, banned
 *   terms, feature flags, the `GET /v1/config` documents); it also keeps
 *   `app.clientPolicy` (minimum versions, maintenance) current;
 * - `app.cities`: the bundled city table;
 * - `app.account`: the cached own-account view (`mev:<uid>`, `me:<uid>:<mev>:s<shape>`);
 * - `app.ownPhotoUrl`: signed links of a person's own photos (none until
 *   media storage is configured).
 *
 * The configuration is loaded when the app is ready (waiting at most a few
 * seconds) and follows `cfg:changed` afterwards.
 */

declare module 'fastify' {
  interface FastifyInstance {
    cfg: ConfigService;
    cities: CityIndex;
    account: AccountStore;
    brand: Brand;
    ownPhotoUrl: OwnPhotoUrl;
  }
}

export interface AccountServicesOptions {
  /** A brand already loaded (tests); otherwise brands/<BRAND>/brand.json. */
  brand?: Brand | undefined;
  cities?: CityIndex | undefined;
  ownPhotoUrl?: OwnPhotoUrl | undefined;
  /** How often `cfg:v` is polled (tests use a short one). */
  configPollMs?: number | undefined;
}

export const accountServicesPlugin = fp<AccountServicesOptions>(
  async (app, options) => {
    const brand = options.brand ?? loadBrand({ brandId: app.config.brand.id, brandsDir: app.config.brand.dir });
    const cities = options.cities ?? CityIndex.bundled();
    const cfg = new ConfigService({
      pool: app.pg,
      redis: app.redis,
      keys: app.keys,
      brand,
      clientPolicy: app.clientPolicy,
      log: app.log.child({ component: 'cfg' }),
      // Listed only when the server can verify Google's tokens.
      googleSignIn: () => app.config.google.webClientId !== undefined,
      pollMs: options.configPollMs,
    });
    const account = new AccountStore({ pool: app.pg, redis: app.redis, cache: app.cache, keys: app.keys, log: app.log.child({ component: 'account' }) });

    app.decorate('brand', brand);
    app.decorate('cities', cities);
    app.decorate('cfg', cfg);
    app.decorate('account', account);
    app.decorate('ownPhotoUrl', options.ownPhotoUrl ?? (() => undefined));
    app.decorateRequest('appSession', null);

    app.addHook('onReady', async () => {
      // The sign-in settings live in their own holder (registered after this plugin).
      if (app.hasDecorator('authSettings')) cfg.onLoad((snapshot) => app.authSettings.set(authSettingsFromConfig(snapshot.app)));
      await cfg.start();
    });
    app.addHook('onClose', async () => {
      await cfg.stop();
    });
    app.log.info({ cities: cities.size, brand: brand.id }, 'account services ready');
  },
  { name: 'account-services', fastify: '5.x' },
);
