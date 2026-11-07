import { one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The home location: an H3 r7 cell and the cell's centre (never the phone's
 * position), the city the API resolved for that centre, the source and the
 * country. Written only when one of them changes; the discovery row follows
 * through its trigger. The account's own country is filled in from it when
 * sign-up did not set one.
 */
export interface HomeLocation {
  cell: string;
  centre: { lat: number; lng: number };
  cityId: number | null;
  source: number;
  country: string;
}

export const writeHomeLocation = defineQuery({ name: 'location.writeHome', statements: 1 }, async (db, userId: string, home: HomeLocation) => {
  const row = await one<{ written: boolean }>(
    db,
    sql`
WITH loc AS (
  INSERT INTO user_locations AS l (user_id, home_h3, home_geo, home_city_id, source, country)
  VALUES (${userId}::bigint, ${home.cell}::bigint,
          ST_SetSRID(ST_MakePoint(${home.centre.lng}::float8, ${home.centre.lat}::float8), 4326)::geography,
          ${home.cityId}::integer, ${home.source}::smallint, ${home.country}::char(2))
  ON CONFLICT (user_id) DO UPDATE SET
     home_h3 = EXCLUDED.home_h3, home_geo = EXCLUDED.home_geo, home_city_id = EXCLUDED.home_city_id,
     source = EXCLUDED.source, country = EXCLUDED.country, updated_at = now()
   WHERE (l.home_h3, l.home_city_id, l.source, l.country)
         IS DISTINCT FROM (EXCLUDED.home_h3, EXCLUDED.home_city_id, EXCLUDED.source, EXCLUDED.country)
  RETURNING l.user_id
), own AS (
  UPDATE users SET country = ${home.country}::char(2) WHERE id = ${userId}::bigint AND country IS NULL AND status NOT IN (7, 8)
)
SELECT EXISTS (SELECT 1 FROM loc) AS written`,
  );
  return row.written;
});
