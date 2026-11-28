import { z } from 'zod';
import { execute, many, maybeOne, one, sql } from '../query.js';
import { adminRefRow, adminRefSql, msOf } from './adminShared.js';
import { defineQuery } from './define.js';

/**
 * The admin panel's settings rows: app_config values by key (the app
 * settings, the SMS routing, the provider entries), and the brand (the
 * active `brands` row with app_config `brand.welcome`). Primary-key reads
 * and upserts only. Every write runs in the caller's transaction, which
 * writes its audit row; a locked read (`FOR UPDATE`) comes first.
 */

const configRow = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAtMs: z.number().int().nullable(),
  updatedBy: adminRefRow.nullable(),
});
export type ConfigValueRow = z.infer<typeof configRow>;

/** The rows of `keys` (a key without a row is absent), with who saved each last. */
export const configValues = defineQuery({ name: 'settings.values', statements: 1 }, async (db, keys: readonly string[]): Promise<ConfigValueRow[]> => {
  if (keys.length === 0) return [];
  const rows = await many<{ r: unknown }>(
    db,
    sql`SELECT jsonb_build_object('key', c.key, 'value', c.value, 'updatedAtMs', ${msOf(sql`c.updated_at`)},
                                  'updatedBy', ${adminRefSql(sql`c.updated_by`)}) AS r
          FROM app_config c
         WHERE c.key = ANY(${[...keys]}::text[])`,
  );
  return rows.map((row) => configRow.parse(row.r));
});

/** One row locked for the write (null value when there is no row). */
export const configValueForUpdate = defineQuery({ name: 'settings.valueForUpdate', statements: 1 }, async (tx, key: string): Promise<{ exists: boolean; value: unknown }> => {
  const row = await maybeOne<{ value: unknown }>(tx, sql`SELECT c.value FROM app_config c WHERE c.key = ${key}::text FOR UPDATE`);
  return row ? { exists: true, value: row.value } : { exists: false, value: null };
});

/**
 * Writes one value; answers the row as read back. `existed` is what the
 * locked read found: a row it locked is updated; a key it found missing is
 * inserted only if no one else made it meanwhile (two first saves of the
 * same key: the second waits for the first and then writes nothing), and
 * null answers that case so the caller refuses the stale save.
 */
export const configValueSave = defineQuery(
  { name: 'settings.valueSave', statements: 1 },
  async (tx, key: string, value: unknown, adminId: number | null, existed = true): Promise<ConfigValueRow | null> => {
    const onConflict = existed
      ? sql`ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`
      : sql`ON CONFLICT (key) DO NOTHING`;
    const row = await maybeOne<{ r: unknown }>(
      tx,
      sql`WITH w AS (
            INSERT INTO app_config AS c (key, value, updated_at, updated_by)
            VALUES (${key}::text, ${JSON.stringify(value)}::jsonb, now(), ${adminId}::integer)
            ${onConflict}
            RETURNING c.key, c.value, c.updated_at, c.updated_by)
          SELECT jsonb_build_object('key', w.key, 'value', w.value, 'updatedAtMs', ${msOf(sql`w.updated_at`)},
                                    'updatedBy', ${adminRefSql(sql`w.updated_by`)}) AS r
            FROM w`,
    );
    return row ? configRow.parse(row.r) : null;
  },
);

/** Removes one value (a provider entry: back to the deployment's values); true when a row went. */
export const configValueDelete = defineQuery({ name: 'settings.valueDelete', statements: 1 }, async (tx, key: string): Promise<boolean> => {
  return (await execute(tx, sql`DELETE FROM app_config WHERE key = ${key}::text`)) === 1;
});

// ─── Brand ────────────────────────────────────────────────────────────────

const brandRow = z.object({
  welcome: z.unknown(),
  welcomeUpdatedAtMs: z.number().int().nullable(),
  welcomeUpdatedBy: adminRefRow.nullable(),
  active: z
    .object({
      id: z.number().int(),
      key: z.string(),
      config: z.record(z.string(), z.unknown()),
      updatedAtMs: z.number().int().nullable(),
      updatedBy: adminRefRow.nullable(),
    })
    .nullable(),
  /** The row with the brand's key (it may be inactive) and its config, or null. */
  sameKey: z.object({ id: z.number().int(), config: z.record(z.string(), z.unknown()) }).nullable(),
  nextId: z.number().int(),
  /** The admin saving (the locked read only). */
  actor: adminRefRow.nullable().optional(),
});
export type BrandSettingsRow = z.infer<typeof brandRow>;

function brandStatement(brandKey: string, lock: boolean, actorId: number | null = null) {
  return sql`SELECT jsonb_build_object(
      'welcome', c.value,
      'welcomeUpdatedAtMs', ${msOf(sql`c.updated_at`)},
      'welcomeUpdatedBy', ${adminRefSql(sql`c.updated_by`)},
      'active', (SELECT jsonb_build_object('id', b.id, 'key', b.key, 'config', b.config, 'updatedAtMs', ${msOf(sql`b.updated_at`)},
                                           'updatedBy', ${adminRefSql(sql`b.updated_by`)})
                   FROM brands b WHERE b.is_active),
      'sameKey', (SELECT jsonb_build_object('id', s.id, 'config', s.config) FROM brands s WHERE s.key = ${brandKey}::text),
      'nextId', (SELECT coalesce(max(m.id), 0) + 1 FROM brands m),
      'actor', ${adminRefSql(sql`${actorId}::integer`)}) AS r
    FROM app_config c WHERE c.key = 'brand.welcome'${lock ? sql` FOR UPDATE OF c` : sql``}`;
}

/** The brand's stored values (the active row, the welcome row). */
export const brandSettingsValue = defineQuery({ name: 'settings.brand', statements: 1 }, async (db, brandKey: string): Promise<BrandSettingsRow> => {
  const row = await one<{ r: unknown }>(db, brandStatement(brandKey, false));
  return brandRow.parse(row.r);
});

/** The same, the welcome row locked: every brand save takes that lock first. */
export const brandSettingsForUpdate = defineQuery(
  { name: 'settings.brandForUpdate', statements: 1 },
  async (tx, brandKey: string, actorId: number | null): Promise<BrandSettingsRow> => {
  const row = await one<{ r: unknown }>(tx, brandStatement(brandKey, true, actorId));
  return brandRow.parse(row.r);
  },
);

export interface BrandSave {
  /** The row to write (the active one, the one with the brand's key, or a new id). */
  id: number;
  key: string;
  config: Record<string, unknown>;
  welcome: unknown;
  adminId: number | null;
}

/** Writes the brand row (made active) and the welcome row in one statement; throws when either was not written. */
export const brandSettingsSave = defineQuery({ name: 'settings.brandSave', statements: 1 }, async (tx, input: BrandSave): Promise<void> => {
  const welcome = JSON.stringify(input.welcome);
  const row = await one<{ brand: boolean; welcome: boolean }>(
    tx,
    sql`WITH b AS (
          INSERT INTO brands AS t (id, key, config, is_active, updated_at, updated_by)
          VALUES (${input.id}::smallint, ${input.key}::text, ${JSON.stringify(input.config)}::jsonb, true, now(), ${input.adminId}::integer)
          ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, is_active = true, updated_at = now(), updated_by = EXCLUDED.updated_by
          RETURNING t.id),
        w AS (
          UPDATE public.app_config
             SET value = ${welcome}::jsonb, updated_at = now(), updated_by = ${input.adminId}::integer
           WHERE key = 'brand.welcome'
          RETURNING key)
        SELECT EXISTS (SELECT 1 FROM b) AS brand, EXISTS (SELECT 1 FROM w) AS welcome`,
  );
  if (!row.brand || !row.welcome) throw new Error('brand: the brand or the welcome row was not written');
});

// ─── Providers ────────────────────────────────────────────────────────────

/** The stored provider entries (and only them), for a process's provider loop. */
export const providerRows = defineQuery({ name: 'settings.providerRows', statements: 1 }, async (db, keys: readonly string[]): Promise<Record<string, unknown>> => {
  const rows = await many<{ key: string; value: unknown }>(db, sql`SELECT c.key, c.value FROM app_config c WHERE c.key = ANY(${[...keys]}::text[])`);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
});
