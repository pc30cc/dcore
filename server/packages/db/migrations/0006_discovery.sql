-- 0006 - Discovery: the one visibility rule, the derived discovery index the
-- deck worker reads, the triggers that keep it exact, the deck query, the
-- profile card builder, and the coalesced batch writes.
--
-- Blocks, bans, deletions, snoozes and shadowbans are applied by one shared
-- rule in every list. In SQL that rule is the group user_listable /
-- blocked_peers / hidden_peers / can_see / visible_subset below; every SQL
-- list (deck, likes, matches, requests, admin previews) goes through it.
-- Lists served from Valkey are kept consistent by the same rule applied when
-- the state changes, and the TypeScript mirror of user_listable is tested
-- against this function. Test accounts (users.flags 1) and everyone else
-- never see each other: can_see, visible_subset and the deck compare the bit.

-- ─── The visibility rule ──────────────────────────────────────────────────
-- p_ctx 1 = discovery lists (deck, explore, who liked me, search, social):
--           only active, not shadowbanned (snoozed, in review, suspended,
--           banned and deleted accounts vanish).
-- p_ctx 2 = relationship lists (matches, chats, calls): a snoozed account
--           stays in its existing conversations; everything else as in 1.
CREATE FUNCTION user_listable(p_status smallint, p_shadowbanned boolean, p_ctx integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE p_ctx
           WHEN 1 THEN p_status = 3 AND NOT p_shadowbanned
           WHEN 2 THEN p_status IN (3, 4) AND NOT p_shadowbanned
           ELSE false
         END;

-- Everyone in a block with p_viewer, whoever blocked.
CREATE FUNCTION blocked_peers(p_viewer bigint) RETURNS SETOF bigint
  LANGUAGE sql STABLE PARALLEL SAFE
  BEGIN ATOMIC
    SELECT b.user_hi FROM blocks b WHERE b.user_lo = p_viewer
    UNION ALL
    SELECT b.user_lo FROM blocks b WHERE b.user_hi = p_viewer;
  END;

-- Everyone p_viewer must never be offered again: blocks either way and every
-- match ever made (active or ended). Passes are excluded separately, by the
-- viewer's Bloom filters in Valkey.
CREATE FUNCTION hidden_peers(p_viewer bigint) RETURNS SETOF bigint
  LANGUAGE sql STABLE PARALLEL SAFE
  BEGIN ATOMIC
    SELECT b.user_hi FROM blocks b WHERE b.user_lo = p_viewer
    UNION ALL
    SELECT b.user_lo FROM blocks b WHERE b.user_hi = p_viewer
    UNION ALL
    SELECT m.user_hi FROM matches m WHERE m.user_lo = p_viewer
    UNION ALL
    SELECT m.user_lo FROM matches m WHERE m.user_hi = p_viewer;
  END;

-- Point check: may p_viewer see p_target in a list of context p_ctx?
CREATE FUNCTION can_see(p_viewer bigint, p_target bigint, p_ctx integer) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN p_viewer <> p_target
     AND EXISTS (SELECT 1 FROM users u, users v
                  WHERE u.id = p_target AND v.id = p_viewer
                    AND user_listable(u.status, u.is_shadowbanned, p_ctx)
                    AND (u.flags & 1) = (v.flags & 1))
     AND NOT EXISTS (SELECT 1 FROM blocks b
                      WHERE b.user_lo = least(p_viewer, p_target) AND b.user_hi = greatest(p_viewer, p_target));

-- Batch check for a list built elsewhere (ids from Valkey, a cached page):
-- returns the ids p_viewer may see, in no particular order. One statement,
-- two primary-key probes per id (plus one for the viewer).
CREATE FUNCTION visible_subset(p_viewer bigint, p_ids bigint[], p_ctx integer) RETURNS SETOF bigint
  LANGUAGE sql STABLE PARALLEL SAFE
  BEGIN ATOMIC
    SELECT u.id
      FROM users v
      JOIN users u ON u.id = ANY (p_ids)
     WHERE v.id = p_viewer
       AND u.id <> p_viewer
       AND user_listable(u.status, u.is_shadowbanned, p_ctx)
       AND (u.flags & 1) = (v.flags & 1)
       AND NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE b.user_lo = least(p_viewer, u.id) AND b.user_hi = greatest(p_viewer, u.id));
  END;

-- ─── discovery ────────────────────────────────────────────────────────────
-- One narrow row per person who may appear in someone's deck, derived from
-- users, profiles, preferences, user_locations, photos and field values by
-- discovery_sync() (triggers below). Membership IS the visibility rule
-- (context 1), so the deck query never joins users. About 180 bytes a row
-- plus 130 bytes of indexes: a million discoverable people fit in ~0.3 GB.
-- Hot column: active_on (once a day per active person, not indexed: HOT).
CREATE TABLE discovery (
  user_id        bigint   PRIMARY KEY REFERENCES users (id),
  h3_r7          bigint   NOT NULL CHECK (h3_is_cell(h3_r7) AND h3_resolution(h3_r7) = 7),
  h3_r5          bigint   GENERATED ALWAYS AS (h3_parent(h3_r7, 5)) STORED,
  h3_r3          bigint   GENERATED ALWAYS AS (h3_parent(h3_r7, 3)) STORED,
  birth_date     date     NOT NULL,
  active_on      date     NOT NULL,
  profile_ver    integer  NOT NULL,
  city_id        integer,
  gender         smallint NOT NULL,
  interested_in  smallint NOT NULL,
  age_min        smallint NOT NULL,
  age_max        smallint NOT NULL,
  intents        smallint NOT NULL,
  flags          smallint NOT NULL,
  completeness   smallint NOT NULL,
  quality        smallint NOT NULL DEFAULT 500 CHECK (quality BETWEEN 0 AND 1000),
  height_cm      smallint,
  country        char(2)  NOT NULL,
  geo            geography(Point, 4326) NOT NULL,
  attrs          smallint[] NOT NULL DEFAULT '{}'
) WITH (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

COMMENT ON TABLE discovery IS
  'Derived; never written by the application except active_on (daily) and quality (worker). Membership needs status active, not shadowbanned, mode_match on and at least two approved photos (the configured photo minimum). flags: 1 verified, 2 incognito, 4 hide distance, 8 test account. attrs: filter_slot * 256 + option id of every filterable choice field. geo: centre of h3_r7 (the effective cell: travel while it lasts, else home). quality: Bayesian like-rate score x 1000, never shown.';

-- Candidate access paths, one per search width: radius up to ~60 km via
-- resolution-5 cells (edge 9.9 km), up to ~400 km via resolution-3 cells
-- (edge 69 km), "whole country" via country. gender and birth_date are index
-- conditions in all three.
CREATE INDEX discovery_r5_idx ON discovery (h3_r5, gender, birth_date);
CREATE INDEX discovery_r3_idx ON discovery (h3_r3, gender, birth_date);
CREATE INDEX discovery_country_idx ON discovery (country, gender, birth_date);

CREATE FUNCTION discovery_sync(p_user bigint) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  SELECT u.birth_date,
         coalesce(u.last_active_on, current_date)                                  AS active_on,
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

COMMENT ON FUNCTION discovery_sync(bigint) IS
  'Recomputes one person''s discovery row from its sources (insert, update or delete). Called by triggers; also by the worker when a travel period ends, and by discovery_resync() after a field catalogue change.';

-- After a change to profile_field_defs (a field deactivated, filter_slot or
-- discovery_column changed), attrs and height_cm of the people using it are
-- stale. The worker walks the discovery table in primary-key order, one
-- chunk per statement: SELECT discovery_resync($after, 5000) until it
-- returns NULL. Rare (catalogue edits), so no field index is kept for it.
CREATE FUNCTION discovery_resync(p_after bigint, p_limit integer) RETURNS bigint
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_id   bigint;
  v_last bigint;
BEGIN
  FOR v_id IN SELECT d.user_id FROM discovery d
               WHERE d.user_id > coalesce(p_after, -1)
               ORDER BY d.user_id
               LIMIT p_limit LOOP
    PERFORM discovery_sync(v_id);
    v_last := v_id;
  END LOOP;
  RETURN v_last;
END;
$$;

-- ─── Triggers that keep discovery and the card version exact ─────────────
-- All sources change only when a person or an admin edits something, so the
-- cost is a handful of primary-key reads per edit. The daily last_active_on
-- update does not fire them (it names no watched column).

CREATE FUNCTION discovery_sync_from_user() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.is_verified, NEW.birth_date, NEW.gender) IS DISTINCT FROM (OLD.is_verified, OLD.birth_date, OLD.gender) THEN
    -- The card shows these: a new version (its profiles trigger syncs discovery).
    UPDATE profiles SET version = version + 1, updated_at = now() WHERE user_id = NEW.id;
  END IF;
  PERFORM discovery_sync(NEW.id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_discovery_sync
  AFTER INSERT OR UPDATE OF status, gender, birth_date, is_shadowbanned, is_verified, flags ON users
  FOR EACH ROW EXECUTE FUNCTION discovery_sync_from_user();

CREATE FUNCTION discovery_sync_from_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM discovery_sync(CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END);
  RETURN NULL;
END;
$$;

-- profiles: a change the card carries bumps the version (BEFORE), and the
-- version or a discovery switch re-syncs (AFTER). hide_distance and
-- show_online are on the card as internal fields (see profile_card), so they
-- bump it too; hide_distance also reaches discovery.flags through the sync.
CREATE FUNCTION profiles_touch() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version = OLD.version
     AND (NEW.display_name, NEW.about, NEW.job_title, NEW.intention, NEW.hide_age, NEW.text_state,
          NEW.hide_distance, NEW.show_online)
         IS DISTINCT FROM (OLD.display_name, OLD.about, OLD.job_title, OLD.intention, OLD.hide_age, OLD.text_state,
                           OLD.hide_distance, OLD.show_online) THEN
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_touch
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION profiles_touch();

-- A column list (UPDATE OF version, ...) would not fire for a version bumped
-- by profiles_touch: it only sees columns the UPDATE statement names. The
-- WHEN of an AFTER trigger sees the final row, so it catches the bump.
CREATE TRIGGER profiles_discovery_sync
  AFTER INSERT OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION discovery_sync_from_row();

CREATE TRIGGER profiles_discovery_sync_upd
  AFTER UPDATE ON profiles
  FOR EACH ROW
  WHEN ((NEW.version, NEW.mode_match, NEW.incognito, NEW.completeness)
        IS DISTINCT FROM (OLD.version, OLD.mode_match, OLD.incognito, OLD.completeness))
  EXECUTE FUNCTION discovery_sync_from_row();

CREATE TRIGGER preferences_discovery_sync
  AFTER INSERT OR DELETE OR UPDATE OF interested_in, age_min, age_max, intents ON preferences
  FOR EACH ROW EXECUTE FUNCTION discovery_sync_from_row();

CREATE TRIGGER user_locations_discovery_sync
  AFTER INSERT OR UPDATE OR DELETE ON user_locations
  FOR EACH ROW EXECUTE FUNCTION discovery_sync_from_row();

-- photos, prompts and field values: one version bump per statement and
-- person (a reorder of nine photos is one bump, not nine). Statement-level
-- triggers with transition tables need one trigger per event.
CREATE FUNCTION profile_version_bump_new() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE profiles p SET version = p.version + 1, updated_at = now()
   WHERE p.user_id IN (SELECT DISTINCT n.user_id FROM new_rows n);
  RETURN NULL;
END;
$$;

CREATE FUNCTION profile_version_bump_old() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE profiles p SET version = p.version + 1, updated_at = now()
   WHERE p.user_id IN (SELECT DISTINCT o.user_id FROM old_rows o);
  RETURN NULL;
END;
$$;

CREATE TRIGGER photos_version_ins AFTER INSERT ON photos
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER photos_version_upd AFTER UPDATE ON photos
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER photos_version_del AFTER DELETE ON photos
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_old();

CREATE TRIGGER profile_prompts_version_ins AFTER INSERT ON profile_prompts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER profile_prompts_version_upd AFTER UPDATE ON profile_prompts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER profile_prompts_version_del AFTER DELETE ON profile_prompts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_old();

CREATE TRIGGER profile_field_values_version_ins AFTER INSERT ON profile_field_values
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER profile_field_values_version_upd AFTER UPDATE ON profile_field_values
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_new();
CREATE TRIGGER profile_field_values_version_del AFTER DELETE ON profile_field_values
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION profile_version_bump_old();

-- ─── The deck query ───────────────────────────────────────────────────────
-- Run by the deck worker only (never on a request path), about once per
-- person per session: it returns up to p_limit candidates (600 by default);
-- the worker drops those in the viewer's Bloom filters, applies advanced
-- filters on attrs/height_cm, scores the rest with the panel's weights, and
-- queues the best ~200 in Valkey.
--
-- p_res 5: p_cells are resolution-5 cells covering the viewer's radius
--   (h3-js gridDisk of the viewer's r5 parent); 3: resolution-3 cells; 0:
--   the whole country p_country (preferences flag "whole country").
-- p_center/p_radius_m: the viewer's effective cell centre and radius; the
--   exact cut after the coarse cell match (NULL radius: no cut).
-- p_likers: who liked the viewer (from Valkey); the only people an
--   incognito candidate may be shown to.
-- p_max_idle_days: candidates active within that many days. The worker
--   starts small (deck.refill.idle_steps) and widens only when fewer than
--   p_limit rows come back, so a dense area never sorts its whole pool.
-- p_seed: per viewer and day (the worker hashes both). Recent activity
--   (a date, so most of the pool ties) orders first, then a hash of the
--   candidate under the seed: every viewer gets a different, stable order
--   instead of the newest sign-ups first.
-- p_after_active/p_after_tie: keyset cursor of the previous page (NULL
--   first), the last row's active_on and tie.
--
-- Exclusions: hidden_peers (blocks either way, every match) are read once
-- into an array and passed to the query as a constant, so `<> ALL` is a
-- hashed lookup per candidate whatever the viewer's history (a CTE or a
-- subquery here was planned as a nested-loop anti-join, which rescans the
-- excluded set for every candidate). EXECUTE plans each call with its own
-- values: the cell column and the radius cut fold away when unused.
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
  p_limit         integer
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
  attrs         smallint[]
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

  RETURN QUERY EXECUTE format($q$
    SELECT c.user_id, c.profile_ver,
           CASE WHEN $5 IS NULL THEN NULL ELSE ST_Distance(c.geo, $5, false)::integer END,
           c.active_on, hashint8extended(c.user_id, $9),
           c.birth_date, c.completeness, c.quality, c.flags, c.intents, c.height_cm, c.city_id, c.attrs
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
        v_hidden;
END;
$fn$;

-- ─── The profile card ─────────────────────────────────────────────────────
-- Built only on a cache miss (Valkey `card:<id>:<version>:<catalogue>`).
-- Never contains the birth date, a cell, coordinates, the phone or anything
-- a moderator has not approved; the API adds the public id and the viewer's
-- rounded distance. `hd` (hide distance) and `so` (show online) are internal:
-- the API reads them (no distance on a card with hd, no presence without so)
-- and strips them before sending.
CREATE FUNCTION profile_card(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'v', p.version,
           'name', p.display_name,
           'age', CASE WHEN p.hide_age THEN NULL ELSE extract(year FROM age(current_date, u.birth_date))::integer END,
           'gender', u.gender,
           'verified', u.is_verified,
           'intention', p.intention,
           'job', CASE WHEN p.text_state = 2 THEN p.job_title END,
           'about', CASE WHEN p.text_state = 2 THEN p.about END,
           'city', CASE WHEN l.travel_until > now() THEN l.travel_city_id ELSE l.home_city_id END,
           'traveling', CASE WHEN l.travel_until > now() THEN true END,
           'hd', p.hide_distance,
           'so', p.show_online,
           'photos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ph.id, 'w', ph.width, 'h', ph.height,
                                                                   'bh', ph.blurhash, 'bv', ph.blob_ver)
                                                ORDER BY ph.position)
                                 FROM photos ph WHERE ph.user_id = u.id AND ph.status = 3), '[]'),
           'prompts', coalesce((SELECT jsonb_agg(jsonb_build_object('p', pp.prompt_id, 'a', pp.answer, 'ms', pp.audio_ms)
                                                 ORDER BY pp.position)
                                  FROM profile_prompts pp WHERE pp.user_id = u.id AND pp.status = 2), '[]'),
           'fields', coalesce((SELECT jsonb_agg(jsonb_build_object('f', v.field_id, 'o', v.opt, 'os', v.opts,
                                                                   'n', v.num, 't', v.txt)
                                                ORDER BY f.sort, f.id)
                                 FROM profile_field_values v JOIN profile_field_defs f ON f.id = v.field_id
                                WHERE v.user_id = u.id AND f.is_public AND f.is_active), '[]')))
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    LEFT JOIN user_locations l ON l.user_id = u.id
   WHERE u.id = p_user
     AND u.status IN (3, 4)
$$;

-- ─── Coalesced batch writes ───────────────────────────────────────────────
-- "Active today": the worker drains Valkey's set la:<day> in batches of up to
-- 5,000 ids and calls this once per batch, so a person costs at most one
-- users row and one discovery row update a day. Only rows that move forward
-- are written. Returns the number of users rows written.
CREATE FUNCTION users_mark_active(p_ids bigint[], p_day date) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE users u SET last_active_on = p_day
   WHERE u.id = ANY (p_ids) AND (u.last_active_on IS NULL OR u.last_active_on < p_day);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE discovery d SET active_on = p_day
   WHERE d.user_id = ANY (p_ids) AND d.active_on < p_day;
  RETURN v_n;
END;
$$;

-- Read cursors: the worker drains Valkey's rp:dirty set once a minute and
-- flushes the newest cursor of each conversation in one statement. A cursor
-- only moves forward. 0 in an array element means "this side did not move".
CREATE FUNCTION matches_flush_read(p_ids bigint[], p_lo bigint[], p_hi bigint[]) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE matches m
     SET lo_read_id = greatest(m.lo_read_id, v.lo),
         hi_read_id = greatest(m.hi_read_id, v.hi)
    FROM unnest(p_ids, p_lo, p_hi) AS v(id, lo, hi)
   WHERE m.id = v.id
     AND (v.lo > m.lo_read_id OR v.hi > m.hi_read_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
