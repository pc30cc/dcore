import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Locale } from '@app/shared';
import { haversineKm, type LatLng } from '@app/shared/server';
import { z } from 'zod';

/**
 * The bundled city table (GeoNames ids, CC BY 4.0; `data/cities.json.gz`,
 * built by `src/scripts/build-cities.ts`), held in memory: city search for
 * the location step, city names in the requested language, and the city
 * and country of a cell centre. Never read from PostgreSQL.
 */

export interface CityRecord {
  id: number;
  lat: number;
  lng: number;
  country: string;
  population: number;
  /** GeoNames' own name, then the names per language ('' when GeoNames has none). */
  name: string;
  fa: string;
  tr: string;
  en: string;
}

export interface CityHit {
  id: number;
  name: string;
  country: string;
}

export interface NearestCity {
  city: CityRecord;
  km: number;
}

const documentSchema = z.object({
  columns: z.tuple([
    z.literal('id'),
    z.literal('lat'),
    z.literal('lng'),
    z.literal('country'),
    z.literal('population'),
    z.literal('name'),
    z.literal('fa'),
    z.literal('tr'),
    z.literal('en'),
  ]),
  rows: z.array(
    z.tuple([
      z.number().int().positive(),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.string().regex(/^[A-Z]{2}$/),
      z.number().int().nonnegative(),
      z.string().min(1),
      z.string(),
      z.string(),
      z.string(),
    ]),
  ),
});

export const CITIES_FILE = new URL('../../data/cities.json.gz', import.meta.url);

/** A city is named for a cell only within this distance of the cell's centre. */
export const CITY_RADIUS_KM = 40;
/** The country of a cell is that of the nearest city within this distance; beyond it the place is not served. */
export const COUNTRY_RADIUS_KM = 400;

const SEARCH_LIMIT = 20;

/**
 * Folds a name or a query for matching: case, Latin diacritics, the Turkish
 * dotless i, Arabic letter forms used in Persian, zero-width joiners and
 * Arabic diacritics.
 */
export function foldName(value: string): string {
  return value
    .replaceAll('ı', 'i')
    .replaceAll('İ', 'i')
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟـ]/g, '')
    .replaceAll('ي', 'ی')
    .replaceAll('ى', 'ی')
    .replaceAll('ك', 'ک')
    .replaceAll('ة', 'ه')
    .replaceAll('أ', 'ا')
    .replaceAll('إ', 'ا')
    .replaceAll('آ', 'ا')
    .replace(/\u200c|\u200d|\u200e|\u200f/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const GRID_DEGREES = 1;

export class CityIndex {
  readonly size: number;
  private readonly cities: CityRecord[];
  private readonly byId = new Map<number, CityRecord>();
  /** Folded names of each city (index-aligned with `cities`). */
  private readonly folded: string[][];
  /** First folded letter of any word → city indexes, by population. */
  private readonly byInitial = new Map<string, number[]>();
  private readonly grid = new Map<string, number[]>();

  constructor(cities: CityRecord[]) {
    this.cities = [...cities].sort((a, b) => b.population - a.population || a.id - b.id);
    this.size = this.cities.length;
    this.folded = this.cities.map((city) => {
      const names = new Set<string>();
      for (const name of [city.name, city.fa, city.tr, city.en]) if (name) names.add(foldName(name));
      names.delete('');
      return [...names];
    });
    this.cities.forEach((city, index) => {
      this.byId.set(city.id, city);
      const initials = new Set<string>();
      for (const name of this.folded[index] ?? []) for (const word of name.split(' ')) if (word) initials.add(word.slice(0, 1));
      for (const initial of initials) {
        const list = this.byInitial.get(initial) ?? [];
        list.push(index);
        this.byInitial.set(initial, list);
      }
      const cell = this.gridKey(Math.floor(city.lat / GRID_DEGREES), Math.floor(city.lng / GRID_DEGREES));
      const list = this.grid.get(cell) ?? [];
      list.push(index);
      this.grid.set(cell, list);
    });
  }

  private static shared: CityIndex | undefined;

  /** The bundled table, read once per process. */
  static bundled(): CityIndex {
    CityIndex.shared ??= CityIndex.fromFile(CITIES_FILE);
    return CityIndex.shared;
  }

  static fromFile(file: URL | string = CITIES_FILE): CityIndex {
    const parsed = documentSchema.parse(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')));
    return new CityIndex(
      parsed.rows.map(([id, lat, lng, country, population, name, fa, tr, en]) => ({ id, lat, lng, country, population, name, fa, tr, en })),
    );
  }

  get(id: number): CityRecord | undefined {
    return this.byId.get(id);
  }

  /** The city's name in `locale`, else in English, else GeoNames' own. */
  nameOf(city: CityRecord, locale: Locale): string {
    return (locale === 'fa' ? city.fa : locale === 'tr' ? city.tr : city.en) || city.en || city.name;
  }

  /**
   * Cities whose name (in any of the kept languages) starts with the query,
   * or has a word that does: exact names first, then whole-name prefixes,
   * then word prefixes, each by population.
   */
  search(query: string, locale: Locale, country?: string, limit = SEARCH_LIMIT): CityHit[] {
    const q = foldName(query);
    if (!q) return [];
    const candidates = this.byInitial.get(q.slice(0, 1)) ?? [];
    const ranked: { index: number; rank: number }[] = [];
    for (const index of candidates) {
      const city = this.cities[index];
      if (!city || (country !== undefined && city.country !== country)) continue;
      let rank = 3;
      for (const name of this.folded[index] ?? []) {
        if (name === q) rank = Math.min(rank, 0);
        else if (name.startsWith(q)) rank = Math.min(rank, 1);
        else if (name.includes(` ${q}`)) rank = Math.min(rank, 2);
      }
      if (rank < 3) ranked.push({ index, rank });
    }
    // Candidates are already in population order; a stable sort by rank keeps it within a rank.
    ranked.sort((a, b) => a.rank - b.rank);
    return ranked.slice(0, limit).map(({ index }) => {
      const city = this.cities[index]!;
      return { id: city.id, name: this.nameOf(city, locale), country: city.country };
    });
  }

  /** The nearest city to a point, if one lies within `maxKm`. */
  nearest(point: LatLng, maxKm: number): NearestCity | undefined {
    const row = Math.floor(point.lat / GRID_DEGREES);
    const col = Math.floor(point.lng / GRID_DEGREES);
    let best: NearestCity | undefined;
    // One grid step is at least ~111 km of latitude; longitude steps shrink towards the poles.
    const kmPerStep = 111 * GRID_DEGREES * Math.max(0.05, Math.cos((Math.min(Math.abs(point.lat) + GRID_DEGREES, 90) * Math.PI) / 180));
    const maxRing = Math.min(180, Math.ceil(maxKm / kmPerStep) + 1);
    for (let ring = 0; ring <= maxRing; ring += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        for (let dc = -ring; dc <= ring; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = row + dr;
          if (r < -90 || r > 89) continue;
          const c = ((((col + dc + 180) % 360) + 360) % 360) - 180;
          for (const index of this.grid.get(this.gridKey(r, c)) ?? []) {
            const city = this.cities[index]!;
            const km = haversineKm(point, city);
            if (km <= maxKm && (best === undefined || km < best.km)) best = { city, km };
          }
        }
      }
      // Every city outside this ring is at least `ring` grid steps away.
      if (best !== undefined && best.km <= ring * kmPerStep) break;
    }
    return best;
  }

  private gridKey(row: number, col: number): string {
    return `${row}:${col}`;
  }
}
