import { z } from 'zod';
import { one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Everything a process keeps of the run-time configuration, in one
 * statement: app_config, the active brand's overrides, the panel's strings,
 * the field and prompt catalogues, plans and their features, banned terms,
 * feature flags and the store catalogue. Read at start-up and after `cfg:changed`, never on a
 * request path.
 */

const i18n = z.record(z.string(), z.unknown());

const fieldOption = z.looseObject({
  id: z.number().int().min(1).max(255),
  i18n: i18n.optional(),
  active: z.boolean().optional(),
});

export const configSnapshotSchema = z.object({
  appConfig: z.record(z.string(), z.unknown()),
  brand: z.object({ id: z.number().int(), key: z.string(), config: z.record(z.string(), z.unknown()) }).nullable(),
  strings: z.array(z.object({ brandId: z.number().int(), locale: z.string(), key: z.string(), value: z.string() })),
  fields: z.array(
    z.object({
      id: z.number().int().positive(),
      key: z.string(),
      type: z.number().int().min(1).max(5),
      sort: z.number().int(),
      filterSlot: z.number().int().nullable(),
      maxChoices: z.number().int().nullable(),
      active: z.boolean(),
      required: z.boolean(),
      public: z.boolean(),
      filterable: z.boolean(),
      premiumFilter: z.boolean(),
      sensitive: z.boolean(),
      discoveryColumn: z.string().nullable(),
      i18n,
      options: z.array(fieldOption).nullable(),
    }),
  ),
  prompts: z.array(
    z.object({ id: z.number().int().positive(), kind: z.number().int().min(1).max(2), sort: z.number().int(), active: z.boolean(), i18n }),
  ),
  plans: z.array(
    z.object({
      id: z.number().int(),
      key: z.string(),
      rank: z.number().int(),
      active: z.boolean(),
      names: i18n,
      features: z.record(z.string(), z.union([z.number(), z.boolean()])),
    }),
  ),
  bannedTerms: z.array(
    z.object({
      id: z.number().int(),
      matchKind: z.number().int().min(1).max(3),
      severity: z.number().int().min(1).max(3),
      scope: z.number().int().min(1).max(31),
      locale: z.string().nullable(),
      term: z.string(),
    }),
  ),
  flags: z.array(
    z.object({ key: z.string(), enabled: z.boolean(), rolloutPct: z.number().int().min(0).max(100), rules: z.record(z.string(), z.unknown()) }),
  ),
  /** The store catalogue, inactive rows included (a product no longer sold still names what its buyers hold). */
  storeProducts: z.array(
    z.object({
      id: z.number().int().positive(),
      store: z.number().int().min(1).max(3),
      kind: z.number().int().min(1).max(2),
      planId: z.number().int().nullable(),
      period: z.string().nullable(),
      item: z.number().int().min(1).max(4).nullable(),
      quantity: z.number().int().positive().nullable(),
      productId: z.string(),
      basePlanId: z.string().nullable(),
      badge: z.number().int().min(0).max(3),
      sort: z.number().int(),
      active: z.boolean(),
      listPriceMinor: z.number().int().nonnegative().nullable(),
      listCurrency: z.string().nullable(),
    }),
  ),
});
export type ConfigSnapshotRows = z.infer<typeof configSnapshotSchema>;

export const configSnapshot = defineQuery({ name: 'config.snapshot', statements: 1 }, async (db): Promise<ConfigSnapshotRows> => {
  const row = await one<{ snapshot: unknown }>(
    db,
    sql`
SELECT jsonb_build_object(
  'appConfig', (SELECT coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb) FROM app_config c),
  'brand', (SELECT jsonb_build_object('id', b.id, 'key', b.key, 'config', b.config) FROM brands b WHERE b.is_active),
  'strings', (SELECT coalesce(jsonb_agg(jsonb_build_object('brandId', s.brand_id, 'locale', s.locale, 'key', s.key, 'value', s.value)
                                         ORDER BY s.brand_id, s.locale, s.key), '[]'::jsonb)
                FROM i18n_strings s
               WHERE s.brand_id = 0 OR s.brand_id IN (SELECT b.id FROM brands b WHERE b.is_active)),
  'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', f.id, 'key', f.key, 'type', f.type, 'sort', f.sort, 'filterSlot', f.filter_slot,
                 'maxChoices', f.max_choices, 'active', f.is_active, 'required', f.is_required, 'public', f.is_public,
                 'filterable', f.is_filterable, 'premiumFilter', f.is_premium_filter, 'sensitive', f.is_sensitive,
                 'discoveryColumn', f.discovery_column, 'i18n', f.i18n, 'options', f.options)
               ORDER BY f.sort, f.id), '[]'::jsonb)
               FROM profile_field_defs f),
  'prompts', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'sort', p.sort, 'active', p.is_active, 'i18n', p.i18n)
                ORDER BY p.sort, p.id), '[]'::jsonb)
                FROM prompt_defs p),
  'plans', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', p.id, 'key', p.key, 'rank', p.rank, 'active', p.is_active, 'names', p.names,
                 'features', (SELECT coalesce(jsonb_object_agg(f.feature, f.value), '{}'::jsonb) FROM plan_features f WHERE f.plan_id = p.id))
               ORDER BY p.rank), '[]'::jsonb)
              FROM plans p),
  'bannedTerms', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'id', t.id, 'matchKind', t.match_kind, 'severity', t.severity, 'scope', t.scope, 'locale', t.locale, 'term', t.term)
                    ORDER BY t.id), '[]'::jsonb)
                    FROM banned_terms t WHERE t.is_active),
  'flags', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', g.key, 'enabled', g.is_enabled, 'rolloutPct', g.rollout_pct, 'rules', g.rules)
              ORDER BY g.key), '[]'::jsonb)
              FROM feature_flags g),
  'storeProducts', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', p.id, 'store', p.store, 'kind', p.kind, 'planId', p.plan_id, 'period', p.period,
                        'item', p.grant_item, 'quantity', p.grant_qty, 'productId', p.product_id, 'basePlanId', p.base_plan_id,
                        'badge', p.badge, 'sort', p.sort, 'active', p.is_active,
                        'listPriceMinor', p.list_price_minor, 'listCurrency', p.list_currency)
                      ORDER BY p.store, p.sort, p.id), '[]'::jsonb)
                      FROM store_products p)
) AS snapshot`,
  );
  return configSnapshotSchema.parse(row.snapshot);
});
