import { configSnapshot, type Pool } from '@app/db';
import { fieldType, parseAppConfig, type AppConfig } from '@app/shared';
import type { KeyBuilder } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerServices } from '../services.js';

/**
 * What the deck worker keeps of the run-time configuration: the refill and
 * scoring settings of app_config, the filterable fields (for advanced
 * filters), and the plans with their features (see-likes on the cards).
 * Loaded with the same one-statement snapshot the API uses, and loaded again
 * when `cfg:v` moved (one GET, looked at no more than every 5 seconds, by
 * the next job that needs it), so a plan edited in the panel reaches the
 * deck within seconds. A failed reload keeps the last good settings.
 */

export const SETTINGS_CHECK_MS = 5_000;

/** The scoring weights of docs/10 (`deck.weights`); a missing key takes its default. */
export interface DeckWeights {
  dist: number;
  active: number;
  comp: number;
  recip: number;
  pref: number;
  new: number;
  verif: number;
  load: number;
  /** Paid visibility (boost); not in the seeded row, so its default applies. */
  boost: number;
  /**
   * The per-viewer shuffle: a uniform [0, 1) from the viewer's seeded hash of
   * each candidate, times this. Two people with the same search do not get
   * the same people in the same order. Not in the seeded row either.
   */
  shuffle: number;
}

export const DEFAULT_WEIGHTS: DeckWeights = { dist: 1, active: 1, comp: 0.5, recip: 1, pref: 0.5, new: 0.3, verif: 0.3, load: 0.5, boost: 2, shuffle: 0.6 };

/** A field preferences.filters may name, as the deck can apply it. */
export type FilterField = { kind: 'choice'; slot: number } | { kind: 'height' };

export interface PlanFeatures {
  id: number;
  key: string;
  rank: number;
  features: Readonly<Record<string, number | boolean>>;
}

export interface DeckSettings {
  /** `cfg:v` at load (0 before the panel ever saved). */
  version: number;
  refill: AppConfig['deck.refill'];
  weights: DeckWeights;
  passReturnDays: number;
  likesWindowDays: number;
  bucketCap: number;
  crossStore: boolean;
  filterFields: ReadonlyMap<string, FilterField>;
  plans: readonly PlanFeatures[];
}

export function settingsFrom(rows: Awaited<ReturnType<typeof configSnapshot>>, version: number): DeckSettings {
  const { config } = parseAppConfig(Object.entries(rows.appConfig).map(([key, value]) => ({ key, value })));
  const weights = { ...DEFAULT_WEIGHTS };
  for (const [key, value] of Object.entries(config['deck.weights'])) {
    if (key in weights) weights[key as keyof DeckWeights] = value;
  }
  const filterFields = new Map<string, FilterField>();
  for (const f of rows.fields) {
    if (!f.active || !f.filterable) continue;
    const kind = fieldType.name(f.type);
    if ((kind === 'single' || kind === 'multi') && f.filterSlot !== null) filterFields.set(f.key, { kind: 'choice', slot: f.filterSlot });
    else if (kind === 'number' && f.discoveryColumn === 'height_cm') filterFields.set(f.key, { kind: 'height' });
  }
  return {
    version,
    refill: config['deck.refill'],
    weights,
    passReturnDays: config['deck.pass_return_days'],
    likesWindowDays: config['likes.window_days'],
    bucketCap: config['likes.bucket_cap'],
    crossStore: config['billing.cross_store_entitlements'],
    filterFields,
    plans: rows.plans.map((p) => ({ id: p.id, key: p.key, rank: p.rank, features: p.features })),
  };
}

/** Whether the best plan held (or the free plan) has a feature, as the API decides it. */
export function planHas(settings: DeckSettings, planIds: readonly number[], feature: string): boolean {
  const held = settings.plans.filter((plan) => planIds.includes(plan.id) || plan.key === 'free');
  const best = [...held].sort((a, b) => b.rank - a.rank)[0];
  return best?.features[feature] === true;
}

export class DeckSettingsSource {
  private current: DeckSettings | null = null;
  private checkedAt = 0;
  private loading: Promise<DeckSettings> | null = null;

  constructor(
    private readonly options: { pg: Pool; redis: Redis; keys: KeyBuilder; log: Logger; now?: () => number },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The settings, reloaded first when `cfg:v` moved since they were loaded. */
  async get(): Promise<DeckSettings> {
    if (this.current && this.now() - this.checkedAt < SETTINGS_CHECK_MS) return this.current;
    this.loading ??= this.refresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async refresh(): Promise<DeckSettings> {
    const { pg, redis, keys, log } = this.options;
    let version: number;
    try {
      version = Number((await redis.get(keys.configVersion())) ?? '0') || 0;
    } catch (error) {
      if (this.current) {
        log.warn({ err: error }, 'deck settings: config version unreadable; keeping the loaded settings');
        return this.current;
      }
      throw error;
    }
    if (this.current?.version === version) {
      this.checkedAt = this.now();
      return this.current;
    }
    try {
      this.current = settingsFrom(await configSnapshot(pg), version);
      this.checkedAt = this.now();
      return this.current;
    } catch (error) {
      if (this.current) {
        log.error({ err: error }, 'deck settings: reload failed; keeping the last good settings');
        return this.current;
      }
      throw error;
    }
  }
}

const sources = new WeakMap<WorkerServices, DeckSettingsSource>();

/** The process's settings source for these services (made on first use). */
export function deckSettingsOf(services: WorkerServices, redis: Redis, log: Logger): DeckSettingsSource {
  let source = sources.get(services);
  if (!source) {
    source = new DeckSettingsSource({ pg: services.pg, redis, keys: services.keys, log });
    sources.set(services, source);
  }
  return source;
}
