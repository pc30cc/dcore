import { LiveKitApi, type CallJobQueue } from '@app/shared/server';
import fp from 'fastify-plugin';
import { RtcSettingsHolder } from '../services/rtc.js';

/**
 * What the call routes, the LiveKit webhook and the admin RTC route share:
 * `app.calls`.
 *
 * - `livekit`: LiveKit's server API (null without LIVEKIT_*: the call routes
 *   answer 503, the webhook too);
 * - `identitySecret`: the key of the opaque per-call identities;
 * - `rtc`: the RTC settings in memory (reloaded after each configuration change);
 * - `jobs`: the `calls` queue of the worker;
 * - `now` and `random`: the clock and the short ring's dice (tests fix them).
 */

export interface CallsRuntime {
  livekit: LiveKitApi | null;
  identitySecret: string | null;
  rtc: RtcSettingsHolder;
  jobs: CallJobQueue;
  now: () => number;
  random: () => number;
}

export interface CallsOptions {
  /** A LiveKit client of the caller's (tests point it at a fake); null: none. */
  livekit?: LiveKitApi | null | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    calls: CallsRuntime;
  }
}

export const callsPlugin = fp<CallsOptions>(
  async (app, options) => {
    const config = app.config.livekit;
    const livekit =
      options.livekit !== undefined ? options.livekit : config ? new LiveKitApi({ apiUrl: config.apiUrl, apiKey: config.apiKey, apiSecret: config.apiSecret }) : null;
    if (!livekit) app.log.warn('LIVEKIT_* is not set: the call routes answer 503');
    // The panel's call signalling host (the origins document), once it saved one, else the brand's.
    const rtcHost = (): string | undefined => {
      const origin = app.hasDecorator('origins') ? app.origins.override('rtc') : undefined;
      return origin ? new URL(origin).host : app.brand.domains.rtc;
    };
    const rtc = new RtcSettingsHolder({ pool: app.pg, sealer: app.secrets.sealer, log: app.log.child({ component: 'rtc' }), brandHost: rtcHost });
    const jobs: CallJobQueue = {
      add: (name, id, data, opts = {}) => app.jobs.add('calls', name, id, data, opts),
    };
    app.decorate('calls', {
      livekit,
      identitySecret: config?.identitySecret ?? null,
      rtc,
      jobs,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    });
    app.addHook('onReady', async () => {
      // After every configuration load (the first one and each cfg:changed); once now if none came yet.
      if (!app.cfg.peek()) void rtc.reload();
      app.cfg.onLoad(() => void rtc.reload());
    });
  },
  { name: 'calls', fastify: '5.x', dependencies: ['account-services'] },
);
