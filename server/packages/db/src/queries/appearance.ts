import { execute, maybeOne, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The visual templates the admin panel sets (app_config `ui.templates`):
 * the stored JSON, which the caller validates (`uiTemplatesConfigSchema` in
 * `@app/shared`). Request paths never read it here: the API serves it from
 * the configuration in memory; these are the panel's reads and its save.
 */

export const UI_TEMPLATES_CONFIG_KEY = 'ui.templates';

/** The stored value (null when the row is missing). */
export const uiTemplatesValue = defineQuery({ name: 'appearance.value', statements: 1 }, async (db): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(db, sql`SELECT c.value FROM app_config c WHERE c.key = ${UI_TEMPLATES_CONFIG_KEY}::text`);
  return row?.value ?? null;
});

/** The stored value, locked until the transaction ends: two saves never interleave. */
export const uiTemplatesForUpdate = defineQuery({ name: 'appearance.valueForUpdate', statements: 1 }, async (tx): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(tx, sql`SELECT c.value FROM app_config c WHERE c.key = ${UI_TEMPLATES_CONFIG_KEY}::text FOR UPDATE`);
  return row?.value ?? null;
});

/** Writes the value (the caller's transaction writes its audit row). */
export const uiTemplatesSave = defineQuery(
  { name: 'appearance.save', statements: 1 },
  async (tx, value: unknown, adminId: number | null): Promise<void> => {
    const written = await execute(
      tx,
      sql`INSERT INTO app_config (key, value, updated_at, updated_by)
          VALUES (${UI_TEMPLATES_CONFIG_KEY}::text, ${JSON.stringify(value)}::jsonb, now(), ${adminId}::integer)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    );
    if (written !== 1) throw new Error('appearance: the value was not written');
  },
);
