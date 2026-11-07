import type { FilterField } from './settings.js';

/**
 * Advanced (paid) filters, `preferences.filters`: a choice field's key to the
 * option ids wanted (any of them), a number field's key to `[min, max]`.
 * Several fields must all hold. They are applied to the candidates the
 * query returned, on `discovery.attrs` (`slot * 256 + option`) and
 * `discovery.height_cm`. A candidate who did not answer a filtered field
 * does not pass it: a filter is a requirement. A key the catalogue no
 * longer offers as a filter is ignored (the panel removed it).
 *
 * The API accepts filters only with the `advanced_filters` feature; when a
 * plan ends, the subscription job clears them (not this worker's concern).
 */

export interface FilterTarget {
  attrs: readonly number[];
  heightCm: number | null;
}

export type CompiledFilter = { kind: 'choice'; codes: ReadonlySet<number> } | { kind: 'height'; min: number; max: number };

export function compileFilters(filters: Readonly<Record<string, readonly number[]>>, fields: ReadonlyMap<string, FilterField>): CompiledFilter[] {
  const out: CompiledFilter[] = [];
  for (const [key, values] of Object.entries(filters)) {
    const field = fields.get(key);
    if (!field || values.length === 0) continue;
    if (field.kind === 'choice') {
      out.push({ kind: 'choice', codes: new Set(values.map((option) => field.slot * 256 + option)) });
    } else if (values.length === 2) {
      out.push({ kind: 'height', min: Math.min(values[0]!, values[1]!), max: Math.max(values[0]!, values[1]!) });
    }
  }
  return out;
}

export function passesFilters(target: FilterTarget, filters: readonly CompiledFilter[]): boolean {
  for (const filter of filters) {
    if (filter.kind === 'choice') {
      if (!target.attrs.some((code) => filter.codes.has(code))) return false;
    } else if (target.heightCm === null || target.heightCm < filter.min || target.heightCm > filter.max) {
      return false;
    }
  }
  return true;
}
