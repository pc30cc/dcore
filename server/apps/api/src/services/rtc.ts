import { rtcSettingsValue, type Pool } from '@app/db';
import { EMPTY_RTC_SETTINGS, RTC_SETTINGS_KEY, normalizeClientWsUrl, rtcSettingsOf, type DataSealer, type RtcSettings } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The RTC settings (the clients' signalling URL, the in-country relay, the
 * live cap) in process memory, the relay's secret opened once per load: a
 * token request reads no statement. Loaded at start and again after every
 * configuration change (`cfg:changed`, which the admin RTC route announces
 * after a save), one statement each time; until the first load there is no
 * relay and no cap, and clients get the brand's `rtc` host.
 */
export class RtcSettingsHolder {
  private current: RtcSettings = EMPTY_RTC_SETTINGS;
  private loading: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly options: {
      pool: Pool;
      sealer: DataSealer;
      log: FastifyBaseLogger;
      /** The signalling host for clients when no URL is stored: the panel's (origins), else the brand's `domains.rtc`. */
      brandHost: string | undefined | (() => string | undefined);
    },
  ) {}

  get(): RtcSettings {
    return this.current;
  }

  /** The signalling URL clients are given: the stored one, else `wss://<the brand's rtc host>`; null without either. */
  clientWsUrl(settings: RtcSettings = this.current): string | null {
    if (settings.wsUrl) return settings.wsUrl;
    const host = typeof this.options.brandHost === 'function' ? this.options.brandHost() : this.options.brandHost;
    return host ? normalizeClientWsUrl(`wss://${host}`) : null;
  }

  /** Sets the settings from a stored value (the admin route, right after its save). */
  set(value: unknown): RtcSettings {
    this.current = rtcSettingsOf(value, this.options.sealer, (error) =>
      this.options.log.error({ err: error }, 'rtc: the stored TURN secret cannot be opened (DATA_KEYS changed?); the relay is withheld'),
    );
    return this.current;
  }

  /** Loads the stored value; concurrent calls share one load and ask for one more after it. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = rtcSettingsValue(this.options.pool, RTC_SETTINGS_KEY)
      .then((value) => {
        this.set(value);
      })
      .catch((error: unknown) => this.options.log.warn({ err: error }, 'rtc: settings not loaded; keeping the last ones'))
      .finally(() => {
        this.loading = null;
        if (this.again) {
          this.again = false;
          void this.reload();
        }
      });
    return this.loading;
  }
}
