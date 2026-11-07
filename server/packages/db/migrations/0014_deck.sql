-- 0014 - The deck refill: the viewer's search in one read, the candidate
-- query extended with people the worker injects (likers, super likers,
-- boosted people), and the batch build of profile cards.
--
-- The refill (worker, about 1.5 times per active person per day) reads
-- deck_viewer() once, computes the search cells with h3-js, runs the pool
-- query and the injected query as one statement, and builds the cards it
-- has no cached copy of in one more statement. Nothing here runs on a
-- request path except profile_cards() for a card that left the cache.

-- ─── The viewer's search ──────────────────────────────────────────────────
-- Everything the worker needs before the candidate query: the effective
-- cell (travel while it lasts, else home: the search cells are computed
-- from it), the preferences, the person's own discovery attributes (for the
-- similarity part of the score), the plans held (see-likes on the cards),
-- and, only when Valkey lost the like buckets (lk:ready absent), the people
-- who liked the viewer in the window (the incognito rule needs them) and
-- the super likers among them. Ids as text; NULL when there is no account.
-- The like lists are PK prefix scans of `likes` (target_id first) over the
-- window's partitions.
CREATE FUNCTION deck_viewer(
  p_viewer      bigint,
  p_store       smallint,
  p_cross_store boolean,
  p_window_days integer,
  p_with_likers boolean
) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'status', u.status,
           'test', (u.flags & 1) <> 0,
           'gender', u.gender,
           'birthDate', u.birth_date,
           'cell', (CASE WHEN l.travel_until > now() THEN l.travel_h3 ELSE l.home_h3 END)::text,
           'country', CASE WHEN l.travel_until > now() THEN l.travel_country ELSE l.country END,
           'preferences', CASE WHEN pr.user_id IS NOT NULL THEN jsonb_build_object(
                            'interestedIn', pr.interested_in, 'ageMin', pr.age_min, 'ageMax', pr.age_max,
                            'maxDistanceKm', pr.max_distance_km, 'intents', pr.intents, 'flags', pr.flags,
                            'filters', pr.filters) END,
           'attrs', to_jsonb(d.attrs),
           'intents', d.intents,
           'plans', (SELECT jsonb_agg(s.plan_id ORDER BY s.plan_id)
                       FROM subscriptions s
                      WHERE s.user_id = u.id AND s.expires_at > now()
                        AND (p_cross_store OR s.store = 0 OR s.store = p_store)),
           'likers', CASE WHEN p_with_likers THEN coalesce((
                       SELECT jsonb_agg(x.actor_id::text)
                         FROM (SELECT DISTINCT lk.actor_id
                                 FROM likes lk
                                WHERE lk.target_id = u.id
                                  AND lk.id >= id_floor(now() - make_interval(days => p_window_days))
                                LIMIT 20000) x), '[]'::jsonb) END,
           'superLikers', CASE WHEN p_with_likers THEN coalesce((
                            SELECT jsonb_agg(DISTINCT lk.actor_id::text)
                              FROM likes lk
                             WHERE lk.target_id = u.id AND lk.kind = 2
                               AND lk.id >= id_floor(now() - make_interval(days => p_window_days))), '[]'::jsonb) END))
    FROM users u
    LEFT JOIN preferences pr   ON pr.user_id = u.id
    LEFT JOIN user_locations l ON l.user_id = u.id
    LEFT JOIN discovery d      ON d.user_id = u.id
   WHERE u.id = p_viewer
$$;

COMMENT ON FUNCTION deck_viewer(bigint, smallint, boolean, integer, boolean) IS
  'The deck worker''s one read of the viewer before a refill (cell, country, preferences, own attributes, plans; likers only while the Valkey like buckets are being rebuilt). Never on a request path.';

-- ─── The candidate query, with injected people ────────────────────────────
-- As in 0006, plus p_only: when set, only those people are considered (the
-- likers, super likers and boosted people the worker wants in the queue
-- whatever their place in the activity order), under exactly the same
-- rules (cells and radius, mutual gender and age, intentions, verified
-- only, incognito, test accounts, activity, hidden peers). The worker runs
-- the pool and the injected people as one statement:
--   SELECT false, * FROM deck_candidates(… pool …)
--   UNION ALL SELECT true, * FROM deck_candidates(… p_only …)
-- h3_r5 is returned so the worker can find boosts by cell for any radius.
DROP FUNCTION deck_candidates(bigint, integer, bigint[], text, geography, integer, bigint[], integer, bigint, date, bigint, integer);

CREATE FUNCTION deck_candidates(
  p_viewer        bigint,
  p_res           integer,
  p_cells         bigint[],
  p_country       text,
  p_center        geography,
  p_radius_m      integer,
  p_likers        bigint[],
  p_max_idle_days integer,
  p_seed          bigint,
  p_after_active  date,
  p_after_tie     bigint,
  p_limit         integer,
  p_only          bigint[] DEFAULT NULL
) RETURNS TABLE (
  user_id       bigint,
  profile_ver   integer,
  distance_m    integer,
  active_on     date,
  tie           bigint,
  birth_date    date,
  completeness  smallint,
  quality       smallint,
  flags         smallint,
  intents       smallint,
  height_cm     smallint,
  city_id       integer,
  attrs         smallint[],
  h3_r5         bigint
)
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_gender        smallint;
  v_intents       smallint;
  v_verified_only boolean;
  v_is_test       boolean;
  v_age           integer;
  v_genders       smallint[];
  v_born_after    date;
  v_born_until    date;
  v_hidden        bigint[];
  v_where         text;
BEGIN
  IF p_only IS NOT NULL AND cardinality(p_only) = 0 THEN
    RETURN;
  END IF;

  SELECT u.gender, pr.intents,
         (pr.flags & 2) <> 0,
         (u.flags & 1) <> 0,
         extract(year FROM age(current_date, u.birth_date))::integer,
         ARRAY(SELECT g::smallint FROM generate_series(1, 3) AS g WHERE (pr.interested_in & (1 << g)) <> 0),
         (current_date - make_interval(years => pr.age_max + 1))::date,
         (current_date - make_interval(years => pr.age_min))::date
    INTO v_gender, v_intents, v_verified_only, v_is_test, v_age, v_genders, v_born_after, v_born_until
    FROM users u JOIN preferences pr ON pr.user_id = u.id
   WHERE u.id = p_viewer AND u.birth_date IS NOT NULL AND u.gender IS NOT NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_hidden := ARRAY(SELECT h.peer FROM hidden_peers(p_viewer) AS h(peer));

  v_where := CASE p_res
               WHEN 5 THEN 'c.h3_r5 = ANY ($3)'
               WHEN 3 THEN 'c.h3_r3 = ANY ($3)'
               WHEN 0 THEN 'c.country = $4'
             END;
  IF v_where IS NULL THEN
    RAISE EXCEPTION 'deck_candidates: p_res must be 5, 3 or 0, got %', p_res;
  END IF;
  IF p_only IS NOT NULL THEN
    v_where := v_where || ' AND c.user_id = ANY ($22)';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT c.user_id, c.profile_ver,
           CASE WHEN $5 IS NULL THEN NULL ELSE ST_Distance(c.geo, $5, false)::integer END,
           c.active_on, hashint8extended(c.user_id, $9),
           c.birth_date, c.completeness, c.quality, c.flags, c.intents, c.height_cm, c.city_id, c.attrs, c.h3_r5
      FROM discovery c
     WHERE %s
       AND c.gender = ANY ($13)
       AND c.birth_date > $14 AND c.birth_date <= $15
       AND c.user_id <> $1
       AND (c.interested_in & (1 << $16)) <> 0
       AND $17 BETWEEN c.age_min AND c.age_max
       AND ($18 = 0 OR c.intents = 0 OR ($18 & c.intents) <> 0)
       AND (NOT $19 OR (c.flags & 1) <> 0)
       AND ((c.flags & 2) = 0 OR c.user_id = ANY ($7))
       AND ((c.flags & 8) <> 0) = $20
       AND c.active_on >= current_date - $8
       AND ($6 IS NULL OR ST_DWithin(c.geo, $5, $6, false))
       AND c.user_id <> ALL ($21)
       AND ($10 IS NULL OR (c.active_on, hashint8extended(c.user_id, $9)) < ($10, $11))
     ORDER BY c.active_on DESC, hashint8extended(c.user_id, $9) DESC
     LIMIT $12
  $q$, v_where)
  USING p_viewer, p_res, p_cells, p_country, p_center, p_radius_m, p_likers, p_max_idle_days, p_seed,
        p_after_active, p_after_tie, p_limit,
        v_genders, v_born_after, v_born_until, v_gender::integer, v_age, v_intents, v_verified_only, v_is_test,
        v_hidden, p_only;
END;
$fn$;

COMMENT ON FUNCTION deck_candidates(bigint, integer, bigint[], text, geography, integer, bigint[], integer, bigint, date, bigint, integer, bigint[]) IS
  'The deck worker''s candidate query (0006) with p_only (only these people, same rules) and each candidate''s r5 cell. Never on a request path.';

-- ─── Cards in batches ─────────────────────────────────────────────────────
-- profile_card() of many people in one statement: the refill's cache misses,
-- or the misses of one page of a list. People without a card (not active or
-- snoozed, gone) come back with NULL.
CREATE FUNCTION profile_cards(p_ids bigint[]) RETURNS TABLE (user_id bigint, card jsonb)
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
AS $$
  SELECT i.id, profile_card(i.id) FROM unnest(p_ids) AS i(id)
$$;
