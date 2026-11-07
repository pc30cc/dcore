import { cellCentre, homeCell } from '@app/shared/server';
import type { Pool } from '@app/db';

/**
 * The generated discovery dataset of the deck tests: `count` active people
 * (40,000 by default) in about 1,262 resolution-7 cells around two cities,
 * with profiles, preferences, locations and two approved photos each,
 * synced into `discovery` by `discovery_sync()` (the triggers are switched
 * off for the bulk load and the sync runs once per person instead).
 *
 * Mixed on purpose so that every rule of the deck is exercised: genders and
 * whom they want (mostly the other gender, some both, non-binary people
 * open to all), ages 18-60 with ranges around their own, radii of 10-100 km,
 * 4% incognito, 15% verified, 4% verified-only searchers, 1% test accounts,
 * activity spread over the last 45 days (most of it recent), intentions.
 */

export interface DatasetCity {
  name: string;
  lat: number;
  lng: number;
  country: string;
}

export const DATASET_CITIES: readonly DatasetCity[] = [
  { name: 'a', lat: 41.015, lng: 28.979, country: 'TR' },
  { name: 'b', lat: 35.689, lng: 51.389, country: 'IR' },
];

export interface DatasetCell {
  cell: string;
  lat: number;
  lng: number;
  country: string;
}

/** A small deterministic generator (the dataset is the same on every run). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function destination(from: { lat: number; lng: number }, km: number, bearingDeg: number): { lat: number; lng: number } {
  const r = 6371.0088;
  const d = km / r;
  const b = (bearingDeg * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lng1 = (from.lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

/** `perCity` distinct r7 cells within `radiusKm` of each city (denser near the centre). */
export function datasetCells(perCity = 631, radiusKm = 45, seed = 11): DatasetCell[] {
  const random = rng(seed);
  const out: DatasetCell[] = [];
  for (const city of DATASET_CITIES) {
    const seen = new Set<string>();
    for (let tries = 0; seen.size < perCity; tries += 1) {
      if (tries > 200_000) throw new Error(`only ${seen.size} cells within ${radiusKm} km`);
      const cell = homeCell(destination(city, radiusKm * random() ** 0.8, random() * 360));
      if (seen.has(cell)) continue;
      seen.add(cell);
      const centre = cellCentre(cell);
      out.push({ cell, lat: centre.lat, lng: centre.lng, country: city.country });
    }
  }
  return out;
}

/** Ids as the application mints them, under generator `generator`, spread over the year since the id epoch. */
const ID_EPOCH_MS = 1_767_225_600_000;

export interface DatasetOptions {
  count?: number;
  seed?: number;
  cells?: DatasetCell[];
  /** Answers to filterable fields: a single-choice field (options 1-3, 60% answer) and a height field (70% answer, 150-194 cm). */
  fields?: { choiceFieldId?: number; heightFieldId?: number };
}

export async function generateDataset(admin: Pool, options: DatasetOptions = {}): Promise<DatasetCell[]> {
  const count = options.count ?? 40_000;
  const cells = options.cells ?? datasetCells();
  const spanMs = Math.max(1, Date.now() - 60_000 - ID_EPOCH_MS);
  const stepMs = Math.max(1, Math.floor(spanMs / count));
  const client = await admin.connect();
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET session_replication_role = replica');
    await client.query(`SELECT setseed(${(options.seed ?? 42) / 100})`);
    await client.query(
      `CREATE TEMP TABLE gen AS
       SELECT g,
              ((($3::bigint * g) << 22) | (1022::bigint << 12) | (g % 4096)) AS id,
              ((($3::bigint * g) << 22) | (1020::bigint << 12) | (g % 4096)) AS photo0,
              ((($3::bigint * g) << 22) | (1021::bigint << 12) | (g % 4096)) AS photo1,
              CASE WHEN r1 < 0.48 THEN 1 WHEN r1 < 0.96 THEN 2 ELSE 3 END::smallint AS gender,
              (DATE '2007-06-01' - (r2 * 15000)::integer) AS birth_date,
              1 + floor(r3 * $2)::integer AS cell_idx,
              r4, r5, r6, r7, r8, r9
         FROM (SELECT g, random() r1, random() r2, random() r3, random() r4, random() r5, random() r6,
                      random() r7, random() r8, random() r9
                 FROM generate_series(1, $1::integer) g) s`,
      [count, cells.length, stepMs],
    );
    await client.query(
      `CREATE TEMP TABLE gen_cells AS
       SELECT ordinality::integer AS idx, c.cell::bigint AS cell, c.lat, c.lng, c.country
         FROM unnest($1::text[], $2::float8[], $3::float8[], $4::text[]) WITH ORDINALITY AS c(cell, lat, lng, country)`,
      [cells.map((c) => c.cell), cells.map((c) => c.lat), cells.map((c) => c.lng), cells.map((c) => c.country)],
    );
    await client.query(
      `INSERT INTO users (id, status, birth_date, gender, country, flags, is_verified, last_active_on, onboarding_step, locale)
       SELECT g.id, 3, g.birth_date, g.gender, c.country, CASE WHEN g.r4 < 0.01 THEN 1 ELSE 0 END, g.r5 < 0.15,
              current_date - floor(power(g.r6, 2.5) * 44)::integer, 50, 'en'
         FROM gen g JOIN gen_cells c ON c.idx = g.cell_idx`,
    );
    await client.query(
      `INSERT INTO profiles (user_id, display_name, completeness, intention, incognito, hide_distance, text_state, about)
       SELECT g.id, 'P' || g.g, 40 + floor(g.r7 * 61)::integer, 1 + floor(g.r8 * 4)::integer,
              g.r4 >= 0.01 AND g.r4 < 0.05, g.r5 > 0.9, 2, 'About ' || g.g
         FROM gen g`,
    );
    await client.query(
      `INSERT INTO preferences (user_id, interested_in, age_min, age_max, max_distance_km, intents, flags)
       SELECT g.id,
              CASE g.gender WHEN 1 THEN CASE WHEN g.r6 < 0.9 THEN 4 ELSE 6 END
                            WHEN 2 THEN CASE WHEN g.r6 < 0.9 THEN 2 ELSE 6 END
                            ELSE 14 END,
              greatest(18, a.age - 4 - floor(g.r7 * 8)::integer),
              least(99, a.age + 4 + floor(g.r8 * 12)::integer),
              10 + floor(g.r9 * 91)::integer,
              CASE WHEN g.r9 < 0.7 THEN 0 WHEN g.r9 < 0.85 THEN 2 | 4 ELSE 8 END,
              CASE WHEN g.r8 < 0.04 THEN 2 ELSE 0 END
         FROM gen g, LATERAL (SELECT extract(year FROM age(current_date, g.birth_date))::integer AS age) a`,
    );
    await client.query(
      `INSERT INTO user_locations (user_id, home_h3, source, country, home_geo)
       SELECT g.id, c.cell, 1, c.country, ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography
         FROM gen g JOIN gen_cells c ON c.idx = g.cell_idx`,
    );
    await client.query(
      `INSERT INTO photos (id, user_id, position, status, width, height, blurhash, blob_ver)
       SELECT p.id, g.id, p.position, 3, 1080, 1350, 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', 1
         FROM gen g CROSS JOIN LATERAL (VALUES (g.photo0, 0), (g.photo1, 1)) AS p(id, position)`,
    );
    if (options.fields?.choiceFieldId !== undefined) {
      await client.query(
        `INSERT INTO profile_field_values (user_id, field_id, opt)
         SELECT g.id, $1, 1 + floor(g.r9 * 1000)::integer % 3 FROM gen g WHERE g.r7 < 0.6`,
        [options.fields.choiceFieldId],
      );
    }
    if (options.fields?.heightFieldId !== undefined) {
      await client.query(
        `INSERT INTO profile_field_values (user_id, field_id, num)
         SELECT g.id, $1, 150 + floor(g.r9 * 104729)::integer % 45 FROM gen g WHERE g.r5 < 0.7`,
        [options.fields.heightFieldId],
      );
    }
    await client.query('SET session_replication_role = DEFAULT');
    await client.query('SELECT count(*) FROM (SELECT discovery_sync(id) FROM gen) s');
    await client.query('DROP TABLE gen');
    await client.query('DROP TABLE gen_cells');
    await client.query('ANALYZE users, profiles, preferences, user_locations, photos, discovery, matches, blocks');
  } finally {
    client.release();
  }
  return cells;
}

/** Problems of each card a viewer was given, against the source tables (not discovery). */
export interface CardViolation {
  id: string;
  problems: string[];
}

/**
 * Every rule of the deck checked again from users, profiles, preferences,
 * locations, blocks, matches and likes: status and shadowban, both people's
 * genders and age ranges, the radius between cell centres (unless the
 * viewer searches the whole country), intentions, blocks and matches,
 * incognito (only to people the person liked), verified-only, and the
 * separation of test accounts.
 */
export async function cardViolations(admin: Pool, viewerId: string, ids: readonly string[]): Promise<CardViolation[]> {
  if (ids.length === 0) return [];
  const { rows } = await admin.query<{ id: string; problems: string[] }>(
    `WITH v AS (
       SELECT u.id, u.gender, u.flags AS uflags, extract(year FROM age(current_date, u.birth_date))::integer AS age,
              pr.interested_in, pr.age_min, pr.age_max, pr.max_distance_km, pr.flags AS pflags, pr.intents,
              CASE WHEN l.travel_until > now() THEN l.travel_geo ELSE l.home_geo END AS geo,
              CASE WHEN l.travel_until > now() THEN l.travel_country ELSE l.country END AS country
         FROM users u JOIN preferences pr ON pr.user_id = u.id JOIN user_locations l ON l.user_id = u.id
        WHERE u.id = $1),
     c AS (
       SELECT u.id, u.gender, u.flags AS uflags, u.status, u.is_shadowbanned, u.is_verified,
              extract(year FROM age(current_date, u.birth_date))::integer AS age, p.incognito, p.mode_match,
              pr.interested_in, pr.age_min, pr.age_max, pr.intents,
              CASE WHEN l.travel_until > now() THEN l.travel_geo ELSE l.home_geo END AS geo,
              CASE WHEN l.travel_until > now() THEN l.travel_country ELSE l.country END AS country
         FROM users u JOIN profiles p ON p.user_id = u.id JOIN preferences pr ON pr.user_id = u.id
         JOIN user_locations l ON l.user_id = u.id
        WHERE u.id = ANY ($2::bigint[]))
     SELECT x.id::text AS id, x.problems FROM (
       SELECT c.id, array_remove(ARRAY[
         CASE WHEN c.id = v.id THEN 'self' END,
         CASE WHEN c.status <> 3 OR c.is_shadowbanned OR NOT c.mode_match THEN 'status' END,
         CASE WHEN (v.interested_in & (1 << c.gender)) = 0 THEN 'gender' END,
         CASE WHEN (c.interested_in & (1 << v.gender)) = 0 THEN 'their_gender' END,
         CASE WHEN c.age NOT BETWEEN v.age_min AND v.age_max THEN 'age' END,
         CASE WHEN v.age NOT BETWEEN c.age_min AND c.age_max THEN 'their_age' END,
         CASE WHEN (v.pflags & 1) = 0 AND ST_Distance(v.geo, c.geo, false) > v.max_distance_km * 1000 THEN 'radius' END,
         CASE WHEN (v.pflags & 1) <> 0 AND c.country <> v.country THEN 'country' END,
         CASE WHEN v.intents <> 0 AND c.intents <> 0 AND (v.intents & c.intents) = 0 THEN 'intents' END,
         CASE WHEN EXISTS (SELECT 1 FROM blocks b WHERE b.user_lo = least(v.id, c.id) AND b.user_hi = greatest(v.id, c.id)) THEN 'block' END,
         CASE WHEN EXISTS (SELECT 1 FROM matches m WHERE m.user_lo = least(v.id, c.id) AND m.user_hi = greatest(v.id, c.id)) THEN 'match' END,
         CASE WHEN c.incognito AND NOT EXISTS (SELECT 1 FROM likes lk WHERE lk.target_id = v.id AND lk.actor_id = c.id) THEN 'incognito' END,
         CASE WHEN (v.pflags & 2) <> 0 AND NOT c.is_verified THEN 'verified' END,
         CASE WHEN (v.uflags & 1) <> (c.uflags & 1) THEN 'test_account' END
       ], NULL) AS problems
         FROM c CROSS JOIN v) x
     WHERE cardinality(x.problems) > 0`,
    [viewerId, ids],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  // A card whose person has no profile, preferences or location row at all is a violation too.
  if (missing.length > 0) {
    const { rows: present } = await admin.query<{ id: string }>(
      `SELECT u.id::text AS id FROM users u JOIN profiles p ON p.user_id = u.id JOIN preferences pr ON pr.user_id = u.id
         JOIN user_locations l ON l.user_id = u.id WHERE u.id = ANY ($1::bigint[])`,
      [missing],
    );
    const ok = new Set(present.map((r) => r.id));
    for (const id of missing) if (!ok.has(id)) rows.push({ id, problems: ['no_source_rows'] });
  }
  return rows;
}
