-- 0035 - Daily statistics for the admin dashboard.
--
-- Three aggregate tables written only by the worker's stats jobs (queue
-- `stats`, as app_maint): stats_daily (one row per metric, UTC day and
-- dimension), stats_revenue_daily (the store revenue cube) and
-- stats_moderation_daily (decisions per admin per day). Every read of the
-- panel is a primary-key prefix of one of them. Test accounts are left out
-- everywhere: users.flags & 1, discovery.flags & 8, store_purchases.is_test,
-- and the ids of users_test_idx (a hashed NOT IN of at most a few thousand
-- ids, kept hashed by the statistics users_test_flag_stats).
--
-- Also:
-- - discovery_sync() falls back to the sign-up day (not today) for a person
--   whose last_active_on is still unknown, so a resync never makes a dormant
--   profile look active; and users.last_active_on is backfilled once for
--   statuses 1-6 from discovery.active_on, else the sign-up day. The UPDATE
--   names no column the users triggers watch, so it syncs nothing. On a large
--   table run it by hand in id ranges first; it then updates nothing here.
-- - The admin, finance and analyst roles get dashboard.revenue.
--
-- No audit_log change (0034 owns its CHECK and COMMENT).

-- ─── Tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stats_daily (
  value   bigint NOT NULL,
  day     date   NOT NULL,
  metric  text   NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{1,31}$'),
  dim     text   NOT NULL DEFAULT '' CHECK (dim ~ '^[A-Za-z0-9:_-]{0,40}$'),
  PRIMARY KEY (metric, day, dim)
);

COMMENT ON TABLE stats_daily IS
  'Aggregates per UTC day, written by the worker (stats/rollup); metric and dim names: packages/shared/src/stats.ts. Small (about 1-2k rows a day), kept indefinitely. Test accounts are left out. Cohort metrics (signup_step, signups, signup_refused, ret_d1/7/30, conv_d7/30 by sign-up day; conversations, replied by match day) are keyed by the cohort day. Places (active_city, active_country): no published cell counts 1 to 4 people, nor does a country cell minus its published city cells (stats_rollup_places); a withheld cell has no row; city 0 and country ZZ are the rest. rollup: the epoch second a day was last rolled up.';

CREATE TABLE IF NOT EXISTS stats_revenue_daily (
  gross_micros   bigint   NOT NULL,
  refund_micros  bigint   NOT NULL,
  day            date     NOT NULL,
  payments       integer  NOT NULL,
  refunds        integer  NOT NULL,
  new_subs       integer  NOT NULL,
  product_ref    smallint NOT NULL,
  store          smallint NOT NULL CHECK (store BETWEEN 1 AND 3),
  estimated      boolean  NOT NULL,
  region         char(2)  NOT NULL CHECK (region ~ '^[A-Z]{2}$'),
  currency       char(3)  NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (day, store, product_ref, region, currency)
);

COMMENT ON TABLE stats_revenue_daily IS
  'Store revenue per UTC recording day (store_events id range), test purchases and test accounts left out. gross: payments (first, renewals, recoveries); refund: event 10 amounts; new_subs: first payments of subscriptions; estimated: a Bazaar list price was used. region ZZ: unknown. No FK on product_ref: the figures outlive catalogue changes.';

CREATE TABLE IF NOT EXISTS stats_moderation_daily (
  day             date     NOT NULL,
  admin_id        integer  NOT NULL,
  decisions       integer  NOT NULL,
  photos          integer  NOT NULL,
  texts           integer  NOT NULL,
  reports         integer  NOT NULL,
  appeals         integer  NOT NULL,
  timed           integer  NOT NULL,
  response_p50_s  integer,
  overturned      integer  NOT NULL,
  PRIMARY KEY (day, admin_id)
);

COMMENT ON TABLE stats_moderation_daily IS
  'Queue decisions per admin per UTC day from audit_log (photo, text, report and appeal decisions; admin_id NULL rows are automatic and left out), decisions about test accounts left out. timed: decisions whose waiting time is known (reports and appeals from their id, photos from the photo id; texts have none); response_p50_s: the median of those, seconds. overturned: appeals overturned that day against an action this admin took. Not granted to app_ro (staff figures).';

-- ─── Test-account filter ──────────────────────────────────────────────────
-- Every function below leaves test accounts out with
-- `x NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)`. Without
-- statistics on the expression the planner takes it for almost every user
-- and, past what fits in hash_mem, runs the subquery once per outer row.
-- These keep the estimate at the real (small) number, so the NOT IN stays a
-- hashed SubPlan over users_test_idx; autovacuum keeps them current.
-- CREATE STATISTICS and ANALYZE take a ShareUpdateExclusiveLock only. An
-- empty table is not analyzed here (its first bulk load would then be planned
-- as for an empty table); autovacuum builds the statistics once it fills.
CREATE STATISTICS IF NOT EXISTS users_test_flag_stats ON ((flags & 1)) FROM users;
DO $analyze$
BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    ANALYZE users;
  END IF;
END
$analyze$;

-- ─── Helpers ──────────────────────────────────────────────────────────────
-- Months in an ISO 8601 period of a store product (P1W, P1M, P3M, P1Y).
CREATE OR REPLACE FUNCTION stats_period_months(p_period text) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN p_period ~ '^P[1-9][0-9]?D$' THEN substring(p_period FROM 2 FOR length(p_period) - 2)::numeric / 30.4375
    WHEN p_period ~ '^P[1-9][0-9]?W$' THEN substring(p_period FROM 2 FOR length(p_period) - 2)::numeric * 7 / 30.4375
    WHEN p_period ~ '^P[1-9][0-9]?M$' THEN substring(p_period FROM 2 FOR length(p_period) - 2)::numeric
    WHEN p_period ~ '^P[1-9][0-9]?Y$' THEN substring(p_period FROM 2 FOR length(p_period) - 2)::numeric * 12
  END;

-- Upserts [{metric, day, dim?, value}]; a row whose value did not change is
-- not written. Returns the rows written.
CREATE OR REPLACE FUNCTION stats_put(p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO stats_daily AS s (metric, day, dim, value)
  SELECT r->>'metric', (r->>'day')::date, coalesce(r->>'dim', ''), (r->>'value')::bigint
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  ON CONFLICT (metric, day, dim) DO UPDATE SET value = EXCLUDED.value
   WHERE s.value IS DISTINCT FROM EXCLUDED.value;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ─── Live counts (stats/live, once a minute) ──────────────────────────────
-- Today's low-volume counts by id range and the review queues, each queue
-- bounded by p_cap + 1 (more than p_cap reads as "p_cap+").
CREATE OR REPLACE FUNCTION stats_live(p_cap integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_lo  bigint := id_floor(v_day::timestamp AT TIME ZONE 'UTC');
  v_cap integer := greatest(coalesce(p_cap, 10000), 1) + 1;
BEGIN
  RETURN jsonb_build_object(
    'day', v_day::text,
    'signups', (SELECT count(*) FROM users u WHERE u.id >= v_lo AND (u.flags & 1) = 0),
    'matches', (SELECT count(*) FROM matches m WHERE m.id >= v_lo
                   AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'calls', (SELECT count(*) FROM calls c WHERE c.id >= v_lo
                 AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'callsAnswered', (SELECT count(*) FROM calls c WHERE c.id >= v_lo AND c.outcome = 1
                         AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'reports', (SELECT count(*) FROM reports r WHERE r.id >= v_lo AND r.reporter_id IS NOT NULL
                   AND r.reporter_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'photos', (SELECT count(*) FROM (SELECT 1 FROM photos p WHERE p.status = 2 LIMIT v_cap) q),
    'texts', (SELECT count(*) FROM (SELECT x.user_id FROM (
                 SELECT p.user_id FROM profiles p
                  WHERE p.text_state = 1 AND (p.about IS NOT NULL OR p.job_title IS NOT NULL)
                 UNION
                 SELECT pp.user_id FROM profile_prompts pp WHERE pp.status = 1) x LIMIT v_cap) q),
    'reportsOpen', (SELECT count(*) FROM (SELECT 1 FROM reports r WHERE r.status IN (1, 2) LIMIT v_cap) q),
    'reportsUrgent', (SELECT count(*) FROM (SELECT 1 FROM reports r WHERE r.status IN (1, 2) AND r.reason IN (6, 8) LIMIT v_cap) q),
    'appeals', (SELECT count(*) FROM (SELECT 1 FROM appeals a WHERE a.status = 1 LIMIT v_cap) q),
    'tickets', (SELECT count(*) FROM (SELECT 1 FROM support_tickets s WHERE s.status = 1 LIMIT v_cap) q),
    'revenue', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', g.currency, 'micros', g.micros::text, 'estimated', g.estimated) ORDER BY g.currency)
        FROM (SELECT e.currency::text AS currency, sum(e.amount_micros) AS micros, bool_or(e.amount_estimated) AS estimated
                FROM store_events e JOIN store_purchases p ON p.id = e.purchase_id
               WHERE e.id >= v_lo AND e.amount_micros IS NOT NULL AND e.event <> 10 AND NOT p.is_test
                 AND (e.user_id IS NULL OR e.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0))
               GROUP BY e.currency) g), '[]'::jsonb));
END;
$$;

-- ─── Nightly rollup (stats/rollup) ────────────────────────────────────────
-- Each function is one statement for the worker and rewrites only the rows
-- of the days it owns, so running a day again changes nothing.

-- Sign-up cohorts p_day - 29 .. p_day: the stored onboarding step of each
-- account (30 = finished), the cohort size and the under-age refusals.
CREATE OR REPLACE FUNCTION stats_rollup_people(p_day date) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_from date := p_day - 29;
  v_lo   bigint := id_floor(v_from::timestamp AT TIME ZONE 'UTC');
  v_hi   bigint := id_floor((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_n    integer;
BEGIN
  DELETE FROM stats_daily WHERE metric IN ('signup_step', 'signups', 'signup_refused') AND day BETWEEN v_from AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT g.metric, g.day, g.dim, g.n
    FROM (
      SELECT 'signup_step' AS metric, (id_time(u.id) AT TIME ZONE 'UTC')::date AS day,
             least(u.onboarding_step, 30)::text AS dim, count(*) AS n
        FROM users u WHERE u.id >= v_lo AND u.id < v_hi AND (u.flags & 1) = 0
       GROUP BY 2, 3
      UNION ALL
      SELECT 'signups', (id_time(u.id) AT TIME ZONE 'UTC')::date, '', count(*)
        FROM users u WHERE u.id >= v_lo AND u.id < v_hi AND (u.flags & 1) = 0
       GROUP BY 2
      UNION ALL
      SELECT 'signup_refused', (id_time(u.id) AT TIME ZONE 'UTC')::date, '', count(*)
        FROM users u WHERE u.id >= v_lo AND u.id < v_hi AND (u.flags & 1) = 0 AND u.deleted_via = 4
       GROUP BY 2) g;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_n);
END;
$$;

-- Matches of p_day by source; conversations and both-replied for the match
-- cohorts p_day - 6 .. p_day (a person's message, kinds 1-4, within 7 days of
-- the match day and before today, so a day run again later never shortens a
-- window that has closed; two primary-key probes per match); calls placed
-- on p_day - 1 and p_day by kind (a call row is written when it ends);
-- reports of p_day by reason, filed by people and raised automatically.
CREATE OR REPLACE FUNCTION stats_rollup_social(p_day date) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo    bigint := id_floor(p_day::timestamp AT TIME ZONE 'UTC');
  v_hi    bigint := id_floor((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_lo7   bigint := id_floor((p_day - 6)::timestamp AT TIME ZONE 'UTC');
  v_lo2   bigint := id_floor((p_day - 1)::timestamp AT TIME ZONE 'UTC');
  v_today bigint := id_floor((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC');
  v_n     integer;
  v_total integer := 0;
BEGIN
  DELETE FROM stats_daily WHERE metric = 'matches' AND day = p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT 'matches', p_day, m.source::text, count(*)
    FROM matches m
   WHERE m.id >= v_lo AND m.id < v_hi
     AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
   GROUP BY m.source;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('conversations', 'replied') AND day BETWEEN p_day - 6 AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT x.metric, x.day, '', x.n
    FROM (
      SELECT s.day, count(*) FILTER (WHERE s.lo_wrote OR s.hi_wrote) AS conversations,
             count(*) FILTER (WHERE s.lo_wrote AND s.hi_wrote) AS replied
        FROM (SELECT w.day,
                     EXISTS (SELECT 1 FROM messages x
                              WHERE x.match_id = w.id AND x.id >= w.id AND x.id < w.until
                                AND x.sender_id = w.user_lo AND x.kind BETWEEN 1 AND 4) AS lo_wrote,
                     EXISTS (SELECT 1 FROM messages x
                              WHERE x.match_id = w.id AND x.id >= w.id AND x.id < w.until
                                AND x.sender_id = w.user_hi AND x.kind BETWEEN 1 AND 4) AS hi_wrote
                FROM (SELECT m.id, m.user_lo, m.user_hi, c.day,
                             least(id_floor((c.day + 7)::timestamp AT TIME ZONE 'UTC'), v_today) AS until
                        FROM matches m
                       CROSS JOIN LATERAL (SELECT (id_time(m.id) AT TIME ZONE 'UTC')::date AS day) c
                       WHERE m.id >= v_lo7 AND m.id < v_hi
                         AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)) w) s
       GROUP BY s.day) c
   CROSS JOIN LATERAL (VALUES ('conversations', c.day, c.conversations), ('replied', c.day, c.replied)) AS x(metric, day, n)
   WHERE x.n > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('calls', 'calls_answered', 'call_minutes') AND day BETWEEN p_day - 1 AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT x.metric, x.day, x.dim, x.n
    FROM (
      SELECT (id_time(c.id) AT TIME ZONE 'UTC')::date AS day, c.kind::text AS dim, count(*) AS calls,
             count(*) FILTER (WHERE c.outcome = 1) AS answered, sum(c.duration_s) / 60 AS minutes
        FROM calls c
       WHERE c.id >= v_lo2 AND c.id < v_hi
         AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
       GROUP BY 1, 2) g
   CROSS JOIN LATERAL (VALUES ('calls', g.day, g.dim, g.calls), ('calls_answered', g.day, g.dim, g.answered),
                              ('call_minutes', g.day, g.dim, g.minutes)) AS x(metric, day, dim, n)
   WHERE x.n > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('reports', 'reports_auto') AND day = p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT CASE WHEN r.reporter_id IS NULL THEN 'reports_auto' ELSE 'reports' END, p_day, r.reason::text, count(*)
    FROM reports r
   WHERE r.id >= v_lo AND r.id < v_hi
     AND coalesce(r.reporter_id, r.target_id) NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
   GROUP BY 1, r.reason;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RETURN jsonb_build_object('rows', v_total);
END;
$$;

-- Money of p_day: the revenue cube; subscription ends (expired, revoked or
-- refunded; a replaced token is not an end) and renewals turned off, by
-- <store>:<plan id>; conversion of the sign-up cohorts p_day - 29 .. p_day
-- (people whose first payment came within 7 and 30 days of signing up, by
-- the store of that payment, counted up to the start of today, so a day run
-- again later never shortens a window that has closed); and with p_snapshot
-- (yesterday only: nothing older can be reconstructed) the subscriptions
-- held and MRR.
CREATE OR REPLACE FUNCTION stats_rollup_money(p_day date, p_snapshot boolean) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo    bigint := id_floor(p_day::timestamp AT TIME ZONE 'UTC');
  v_hi    bigint := id_floor((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_lo30  bigint := id_floor((p_day - 29)::timestamp AT TIME ZONE 'UTC');
  v_today bigint := id_floor((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC');
  v_n     integer;
  v_total integer := 0;
BEGIN
  DELETE FROM stats_revenue_daily WHERE day = p_day;
  INSERT INTO stats_revenue_daily (gross_micros, refund_micros, day, payments, refunds, new_subs, product_ref, store,
                                   estimated, region, currency)
  SELECT coalesce(sum(e.amount_micros) FILTER (WHERE e.event <> 10), 0),
         coalesce(sum(e.amount_micros) FILTER (WHERE e.event = 10), 0),
         p_day,
         count(*) FILTER (WHERE e.event <> 10),
         count(*) FILTER (WHERE e.event = 10),
         count(*) FILTER (WHERE e.event = 1 AND p.kind = 1),
         p.product_ref, e.store, bool_or(e.amount_estimated), coalesce(p.region, 'ZZ'), e.currency
    FROM store_events e JOIN store_purchases p ON p.id = e.purchase_id
   WHERE e.id >= v_lo AND e.id < v_hi AND e.amount_micros IS NOT NULL AND NOT p.is_test
     AND (e.user_id IS NULL OR e.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0))
   GROUP BY p.product_ref, e.store, coalesce(p.region, 'ZZ'), e.currency;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('churn', 'cancels') AND day = p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT CASE WHEN e.event = 3 THEN 'cancels' ELSE 'churn' END, p_day, e.store::text || ':' || coalesce(sp.plan_id, 0)::text, count(*)
    FROM store_events e
    JOIN store_purchases p ON p.id = e.purchase_id
    JOIN store_products sp ON sp.id = p.product_ref
   WHERE e.id >= v_lo AND e.id < v_hi AND e.event IN (3, 9, 10) AND p.kind = 1 AND NOT p.is_test
     AND (e.user_id IS NULL OR e.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0))
   GROUP BY 1, 3;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  -- A cohort account's payments all come after its sign-up (at or after
  -- v_lo30), so the earliest one before today is its first ever.
  DELETE FROM stats_daily WHERE metric IN ('conv_d7', 'conv_d30') AND day BETWEEN p_day - 29 AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT x.metric, f.cohort, f.store::text, x.n
    FROM (
      SELECT (id_time(fp.user_id) AT TIME ZONE 'UTC')::date AS cohort, fp.store,
             count(*) FILTER (WHERE fp.first_id < id_floor(((id_time(fp.user_id) AT TIME ZONE 'UTC')::date + 7)::timestamp AT TIME ZONE 'UTC')) AS d7,
             count(*) FILTER (WHERE fp.first_id < id_floor(((id_time(fp.user_id) AT TIME ZONE 'UTC')::date + 30)::timestamp AT TIME ZONE 'UTC')) AS d30
        FROM (SELECT DISTINCT ON (e.user_id) e.user_id, e.id AS first_id, e.store
                FROM store_events e JOIN store_purchases p ON p.id = e.purchase_id
               WHERE e.id >= v_lo30 AND e.id < v_today
                 AND e.user_id >= v_lo30 AND e.user_id < v_hi
                 AND e.amount_micros IS NOT NULL AND e.event <> 10 AND NOT p.is_test
                 AND e.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
               ORDER BY e.user_id, e.id) fp
       GROUP BY 1, 2) f
   CROSS JOIN LATERAL (VALUES ('conv_d7', f.d7), ('conv_d30', f.d30)) AS x(metric, n)
   WHERE x.n > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  IF p_snapshot THEN
    DELETE FROM stats_daily WHERE metric IN ('subs', 'subs_renewing', 'mrr') AND day = p_day;
    INSERT INTO stats_daily (metric, day, dim, value)
    SELECT x.metric, p_day, x.dim, x.n
      FROM (
        SELECT s.store::text || ':' || s.plan_id::text AS dim, count(*) AS subs, count(*) FILTER (WHERE s.status IN (1, 3)) AS renewing
          FROM subscriptions s JOIN store_purchases p ON p.id = s.purchase_id
         WHERE s.store IN (1, 2) AND s.status IN (1, 2, 3) AND NOT p.is_test
           AND s.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
         GROUP BY 1) g
     CROSS JOIN LATERAL (VALUES ('subs', g.dim, g.subs), ('subs_renewing', g.dim, g.renewing)) AS x(metric, dim, n)
     WHERE x.n > 0
    UNION ALL
    SELECT 'mrr', p_day, s.store::text || ':' || last.currency::text, round(sum(last.amount_micros / stats_period_months(sp.period)))::bigint
      FROM subscriptions s
      JOIN store_purchases p ON p.id = s.purchase_id
      JOIN store_products sp ON sp.id = p.product_ref
      JOIN LATERAL (SELECT e.amount_micros, e.currency
                      FROM store_events e
                     WHERE e.purchase_id = p.id AND e.amount_micros IS NOT NULL AND e.event <> 10
                     ORDER BY e.id DESC LIMIT 1) last ON true
     WHERE s.store IN (1, 2) AND s.status IN (1, 3) AND NOT p.is_test AND stats_period_months(sp.period) > 0
       AND s.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
     GROUP BY s.store, last.currency;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END IF;
  RETURN jsonb_build_object('rows', v_total);
END;
$$;

-- Matchable people (discovery, test accounts out) active in the 7 days up to
-- p_day, by city and by country and gender. No published cell counts 1 to 4
-- people, and neither does a country cell minus its published city cells, nor
-- Other minus ZZ:
-- - each city belongs to one country (the smallest code among its people),
--   so the cities nest in the countries;
-- - a country cell is published when the country has at least 10 people and
--   the cell at least 5 (else it goes to ZZ);
-- - a city cell is published when its country cell is, the city has at least
--   10 people and the cell at least 5 (else it goes to Other, city 0);
-- - a country cell minus its published city cells must be 0 or at least 5:
--   when it is 1 to 4, that country's smallest published city cell of the
--   gender is withheld too (once is enough: the rest then counts at least 6);
-- - ZZ is published at 5 or more; Other at 5 or more unless ZZ counts 1 to 4
--   (Other minus ZZ is the sum of the published countries' rests, each 0 or
--   at least 5, so either one tells the other).
-- A withheld cell has no row.
CREATE OR REPLACE FUNCTION stats_rollup_places(p_day date) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM stats_daily WHERE metric IN ('active_city', 'active_country') AND day = p_day;
  WITH raw AS MATERIALIZED (
    SELECT coalesce(d.city_id, 0) AS city, d.country::text AS country, d.gender
      FROM discovery d
     WHERE d.active_on BETWEEN p_day - 6 AND p_day AND (d.flags & 8) = 0
  ), home AS (
    SELECT r.city, min(r.country) AS country FROM raw r WHERE r.city <> 0 GROUP BY r.city
  ), people AS MATERIALIZED (
    SELECT r.city, coalesce(h.country, r.country) AS country, r.gender
      FROM raw r LEFT JOIN home h ON h.city = r.city
  ), countries AS (
    SELECT p.country, p.gender, count(*) AS n, sum(count(*)) OVER (PARTITION BY p.country) AS place_n
      FROM people p GROUP BY p.country, p.gender
  ), kept_countries AS MATERIALIZED (
    SELECT c.country, c.gender, c.n FROM countries c WHERE c.country <> 'ZZ' AND c.n >= 5 AND c.place_n >= 10
  ), cities AS (
    SELECT p.city, p.country, p.gender, count(*) AS n, sum(count(*)) OVER (PARTITION BY p.city) AS place_n
      FROM people p WHERE p.city <> 0 GROUP BY p.city, p.country, p.gender
  ), candidates AS MATERIALIZED (
    SELECT c.city, c.country, c.gender, c.n
      FROM cities c JOIN kept_countries k ON k.country = c.country AND k.gender = c.gender
     WHERE c.n >= 5 AND c.place_n >= 10
  ), rests AS (
    SELECT k.country, k.gender, k.n - coalesce(sum(c.n), 0) AS rest
      FROM kept_countries k LEFT JOIN candidates c ON c.country = k.country AND c.gender = k.gender
     GROUP BY k.country, k.gender, k.n
  ), withheld AS (
    SELECT DISTINCT ON (c.country, c.gender) c.city, c.gender
      FROM candidates c JOIN rests x ON x.country = c.country AND x.gender = c.gender
     WHERE x.rest BETWEEN 1 AND 4
     ORDER BY c.country, c.gender, c.n, c.city
  ), kept_cities AS MATERIALIZED (
    SELECT c.city, c.gender, c.n FROM candidates c
     WHERE NOT EXISTS (SELECT 1 FROM withheld w WHERE w.city = c.city AND w.gender = c.gender)
  ), others AS (
    SELECT g.gender,
           g.n - coalesce((SELECT sum(c.n) FROM kept_cities c WHERE c.gender = g.gender), 0) AS city_rest,
           g.n - coalesce((SELECT sum(k.n) FROM kept_countries k WHERE k.gender = g.gender), 0) AS country_rest
      FROM (SELECT p.gender, count(*) AS n FROM people p GROUP BY p.gender) g
  )
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT 'active_city', p_day, c.city::text || ':' || c.gender::text, c.n FROM kept_cities c
  UNION ALL
  SELECT 'active_country', p_day, k.country || ':' || k.gender::text, k.n FROM kept_countries k
  UNION ALL
  SELECT 'active_city', p_day, '0:' || o.gender::text, o.city_rest FROM others o
   WHERE o.city_rest >= 5 AND o.country_rest NOT BETWEEN 1 AND 4
  UNION ALL
  SELECT 'active_country', p_day, 'ZZ:' || o.gender::text, o.country_rest FROM others o
   WHERE o.country_rest >= 5;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_n);
END;
$$;

-- Queue decisions of p_day per admin (audit_log is partitioned by id: the
-- day is an id range of its partition). Waiting time: from the report's or
-- appeal's id, or the photo id the decision names, to the decision.
CREATE OR REPLACE FUNCTION stats_rollup_moderation(p_day date) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo bigint := id_floor(p_day::timestamp AT TIME ZONE 'UTC');
  v_hi bigint := id_floor((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_n  integer;
BEGIN
  DELETE FROM stats_moderation_daily WHERE day = p_day;
  WITH a AS (
    SELECT a.id, a.admin_id, a.action, a.target_type, a.target_id, a.detail
      FROM audit_log a
     WHERE a.id >= v_lo AND a.id < v_hi AND a.admin_id IS NOT NULL
       AND a.action IN ('photo.approve', 'photo.reject', 'text.approve', 'text.reject',
                        'report.resolve', 'report.dismiss', 'appeal.uphold', 'appeal.overturn')
  ), d AS (
    SELECT a.admin_id, split_part(a.action, '.', 1) AS kind,
           CASE a.target_type
             WHEN 3 THEN (SELECT r.target_id FROM reports r WHERE r.id = a.target_id)
             WHEN 4 THEN (SELECT ap.user_id FROM appeals ap WHERE ap.id = a.target_id)
             ELSE a.target_id END AS subject,
           CASE
             WHEN a.target_type IN (3, 4) AND a.target_id > 0 THEN (a.id >> 22) - (a.target_id >> 22)
             WHEN a.action LIKE 'photo.%' AND (a.detail->>'photoId') ~ '^[1-9][0-9]{0,17}$'
               THEN (a.id >> 22) - ((a.detail->>'photoId')::bigint >> 22)
           END AS wait_ms
      FROM a
  ), kept AS (
    SELECT * FROM d WHERE d.subject IS NULL OR d.subject NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
  ), per AS (
    SELECT k.admin_id, count(*) AS decisions,
           count(*) FILTER (WHERE k.kind = 'photo') AS photos, count(*) FILTER (WHERE k.kind = 'text') AS texts,
           count(*) FILTER (WHERE k.kind = 'report') AS reports, count(*) FILTER (WHERE k.kind = 'appeal') AS appeals,
           count(*) FILTER (WHERE k.wait_ms >= 0) AS timed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY k.wait_ms) FILTER (WHERE k.wait_ms >= 0) AS p50_ms
      FROM kept k GROUP BY k.admin_id
  ), o AS (
    SELECT ma.admin_id, count(*) AS n
      FROM a
      JOIN appeals ap ON ap.id = a.target_id
      JOIN moderation_actions ma ON ma.id = ap.action_id
     WHERE a.action = 'appeal.overturn' AND a.target_type = 4 AND ma.admin_id IS NOT NULL
       AND ap.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
     GROUP BY ma.admin_id
  )
  INSERT INTO stats_moderation_daily (day, admin_id, decisions, photos, texts, reports, appeals, timed, response_p50_s, overturned)
  SELECT p_day, coalesce(per.admin_id, o.admin_id), coalesce(per.decisions, 0), coalesce(per.photos, 0), coalesce(per.texts, 0),
         coalesce(per.reports, 0), coalesce(per.appeals, 0), coalesce(per.timed, 0), round(per.p50_ms / 1000)::integer,
         coalesce(o.n, 0)
    FROM per FULL JOIN o ON o.admin_id = per.admin_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_n);
END;
$$;

-- ─── discovery_sync: an unknown last activity is the sign-up day ──────────
-- As 0006, with one change: coalesce(u.last_active_on, <sign-up day>) where
-- it read current_date, so a resync (a profile edit, a catalogue change)
-- never puts a dormant profile back into decks.
CREATE OR REPLACE FUNCTION discovery_sync(p_user bigint) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  SELECT u.birth_date,
         coalesce(u.last_active_on, (id_time(u.id) AT TIME ZONE 'UTC')::date)       AS active_on,
         p.version                                                                 AS profile_ver,
         u.gender, pr.interested_in, pr.age_min, pr.age_max, pr.intents,
         ((CASE WHEN u.is_verified THEN 1 ELSE 0 END)
          | (CASE WHEN p.incognito THEN 2 ELSE 0 END)
          | (CASE WHEN p.hide_distance THEN 4 ELSE 0 END)
          | (CASE WHEN (u.flags & 1) <> 0 THEN 8 ELSE 0 END))::smallint            AS flags,
         p.completeness,
         CASE WHEN l.travel_until > now() THEN l.travel_h3 ELSE l.home_h3 END      AS h3_r7,
         CASE WHEN l.travel_until > now() THEN l.travel_geo ELSE l.home_geo END    AS geo,
         CASE WHEN l.travel_until > now() THEN l.travel_country ELSE l.country END AS country,
         CASE WHEN l.travel_until > now() THEN l.travel_city_id ELSE l.home_city_id END AS city_id,
         (SELECT least(greatest(v.num, 0), 32767)::smallint
            FROM profile_field_values v JOIN profile_field_defs f ON f.id = v.field_id
           WHERE v.user_id = u.id AND f.discovery_column = 'height_cm' AND f.is_active
           LIMIT 1)                                                                AS height_cm,
         coalesce((SELECT array_agg(DISTINCT s.code ORDER BY s.code)
                     FROM (SELECT (f.filter_slot * 256 + v.opt)::smallint AS code
                             FROM profile_field_values v JOIN profile_field_defs f ON f.id = v.field_id
                            WHERE v.user_id = u.id AND f.filter_slot IS NOT NULL AND f.is_active AND v.opt IS NOT NULL
                           UNION ALL
                           SELECT (f.filter_slot * 256 + o.opt)::smallint
                             FROM profile_field_values v JOIN profile_field_defs f ON f.id = v.field_id
                                  CROSS JOIN LATERAL unnest(v.opts) AS o(opt)
                            WHERE v.user_id = u.id AND f.filter_slot IS NOT NULL AND f.is_active) s),
                  '{}')                                                            AS attrs
    INTO r
    FROM users u
    JOIN profiles p        ON p.user_id = u.id
    JOIN preferences pr    ON pr.user_id = u.id
    JOIN user_locations l  ON l.user_id = u.id
   WHERE u.id = p_user
     AND user_listable(u.status, u.is_shadowbanned, 1)
     AND p.mode_match
     -- The photo minimum (GET /v1/config limits.photosMin): approved photos only.
     AND (SELECT count(*) FROM photos ph WHERE ph.user_id = u.id AND ph.status = 3) >= 2;

  IF NOT FOUND THEN
    DELETE FROM discovery WHERE user_id = p_user;
    RETURN;
  END IF;

  INSERT INTO discovery AS d (user_id, h3_r7, birth_date, active_on, profile_ver, city_id, gender,
                              interested_in, age_min, age_max, intents, flags, completeness, height_cm,
                              country, geo, attrs)
  VALUES (p_user, r.h3_r7, r.birth_date, r.active_on, r.profile_ver, r.city_id, r.gender,
          r.interested_in, r.age_min, r.age_max, r.intents, r.flags, r.completeness, r.height_cm,
          r.country, r.geo, r.attrs)
  ON CONFLICT (user_id) DO UPDATE
     SET h3_r7 = EXCLUDED.h3_r7, birth_date = EXCLUDED.birth_date, active_on = greatest(d.active_on, EXCLUDED.active_on),
         profile_ver = EXCLUDED.profile_ver, city_id = EXCLUDED.city_id, gender = EXCLUDED.gender,
         interested_in = EXCLUDED.interested_in, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
         intents = EXCLUDED.intents, flags = EXCLUDED.flags, completeness = EXCLUDED.completeness,
         height_cm = EXCLUDED.height_cm, country = EXCLUDED.country, geo = EXCLUDED.geo, attrs = EXCLUDED.attrs
   -- No write when nothing changed (geo is a function of h3_r7).
   WHERE (d.h3_r7, d.birth_date, d.profile_ver, d.city_id, d.gender, d.interested_in, d.age_min, d.age_max,
          d.intents, d.flags, d.completeness, d.height_cm, d.country, d.attrs)
         IS DISTINCT FROM
         (EXCLUDED.h3_r7, EXCLUDED.birth_date, EXCLUDED.profile_ver, EXCLUDED.city_id, EXCLUDED.gender,
          EXCLUDED.interested_in, EXCLUDED.age_min, EXCLUDED.age_max, EXCLUDED.intents, EXCLUDED.flags,
          EXCLUDED.completeness, EXCLUDED.height_cm, EXCLUDED.country, EXCLUDED.attrs);
END;
$$;

-- ─── Backfill of the last active day ──────────────────────────────────────
UPDATE users u
   SET last_active_on = coalesce((SELECT d.active_on FROM discovery d WHERE d.user_id = u.id),
                                 (id_time(u.id) AT TIME ZONE 'UTC')::date)
 WHERE u.last_active_on IS NULL AND u.status BETWEEN 1 AND 6;

-- ─── Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION stats_put(jsonb), stats_live(integer), stats_rollup_people(date), stats_rollup_social(date),
  stats_rollup_money(date, boolean), stats_rollup_places(date), stats_rollup_moderation(date) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maint') THEN
    -- The worker's role; the API cannot run them.
    GRANT EXECUTE ON FUNCTION stats_put(jsonb), stats_live(integer), stats_rollup_people(date), stats_rollup_social(date),
      stats_rollup_money(date, boolean), stats_rollup_places(date), stats_rollup_moderation(date), stats_period_months(text)
      TO app_maint;
  ELSE
    RAISE NOTICE 'role app_maint does not exist: grants skipped (development database?)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION stats_period_months(text) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    -- Aggregates only; the moderation figures stay out.
    GRANT SELECT ON stats_daily, stats_revenue_daily TO app_ro;
  ELSE
    RAISE NOTICE 'role app_ro does not exist: grants skipped';
  END IF;
END
$grants$;

-- ─── Seeded grant ─────────────────────────────────────────────────────────
-- Money figures (revenue, conversion) on the dashboard and in the statistics.
INSERT INTO admin_role_permissions (role_id, permission)
SELECT r.id, 'dashboard.revenue' FROM admin_roles r WHERE r.key IN ('admin', 'finance', 'analyst')
ON CONFLICT DO NOTHING;
