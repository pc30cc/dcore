-- 0017 - A match and a block (or a ban, a deletion) of the same people never
-- pass each other.
--
-- A match INSERT checked can_see() in its own snapshot, and block_apply()
-- ended the pair's active match with an UPDATE that cannot see a match row
-- not yet committed: a block committing while the INSERT was in flight left
-- an active match between a blocked pair. Now both writers of a pair take
-- one transaction-level advisory lock on the pair first, so one waits for
-- the other and, under READ COMMITTED, its next statement sees what the
-- other committed:
--
--   * match_create() (the API's fast path and the wb:match worker: one
--     statement each) takes the pair's lock, then a share lock on both
--     accounts' rows, so a ban, a deletion or any status change of either
--     person in flight (they lock the users row: moderation_apply() with
--     FOR UPDATE, the others by updating it) commits first and the match
--     sees it, or waits for the match and then ends it;
--   * block_apply() takes the same pair lock before it writes the block and
--     ends the match (report_file() calls it, so a report's block does too).
--
-- The lock key is a 64-bit hash of the pair (a collision only makes two
-- unrelated pairs wait for each other).

-- The advisory lock key of a pair (the order of the two ids does not matter).
CREATE FUNCTION pair_lock_key(p_a bigint, p_b bigint) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN hashtextextended('pair:' || least(p_a, p_b)::text || ':' || greatest(p_a, p_b)::text, 0);

-- The match of a mutual like, serialised with the pair's block and both
-- accounts' status changes: INSERT with the pre-minted id unless the pair
-- already has a match (ON CONFLICT DO NOTHING), only while each may see the
-- other in discovery; the row it created, or the pair's existing row
-- (created false), with both people's cards. No row: the pair may not match.
-- New matches take the call bits from both profiles' accept_calls.
CREATE FUNCTION match_create(p_id bigint, p_actor bigint, p_target bigint, p_source smallint)
  RETURNS TABLE (o_id bigint, o_lo bigint, o_hi bigint, o_state smallint, o_flags smallint, o_source smallint,
                 o_created boolean, o_lo_card jsonb, o_hi_card jsonb)
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo bigint := least(p_actor, p_target);
  v_hi bigint := greatest(p_actor, p_target);
BEGIN
  IF p_actor = p_target THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(pair_lock_key(v_lo, v_hi));
  PERFORM 1 FROM users u WHERE u.id IN (v_lo, v_hi) ORDER BY u.id FOR SHARE;
  -- A new statement: its snapshot sees whatever the locks waited for.
  RETURN QUERY
    WITH ins AS (
      INSERT INTO matches (id, user_lo, user_hi, source, flags)
      SELECT p_id, v_lo, v_hi, p_source,
             ((CASE WHEN coalesce((SELECT pl.accept_calls FROM profiles pl WHERE pl.user_id = v_lo), true) THEN 1 ELSE 0 END)
              | (CASE WHEN coalesce((SELECT ph.accept_calls FROM profiles ph WHERE ph.user_id = v_hi), true) THEN 2 ELSE 0 END))::smallint
       WHERE can_see(p_actor, p_target, 1) AND can_see(p_target, p_actor, 1)
      ON CONFLICT (user_lo, user_hi) DO NOTHING
      RETURNING id, user_lo, user_hi, state, flags, source
    ), found AS (
      SELECT i.id, i.user_lo, i.user_hi, i.state, i.flags, i.source, true AS created FROM ins i
      UNION ALL
      SELECT x.id, x.user_lo, x.user_hi, x.state, x.flags, x.source, false
        FROM matches x
       WHERE x.user_lo = v_lo AND x.user_hi = v_hi AND NOT EXISTS (SELECT 1 FROM ins)
    )
    SELECT f.id, f.user_lo, f.user_hi, f.state, f.flags, f.source, f.created,
           profile_card(f.user_lo), profile_card(f.user_hi)
      FROM found f;
END
$$;

COMMENT ON FUNCTION match_create(bigint, bigint, bigint, smallint) IS
  'The match of a mutual like under the pair''s advisory lock and share locks on both users rows (so a block, a ban or a deletion of either is never passed): the created or existing row with both cards; no row when the pair may not match.';

-- block_apply() of 0016 with the pair's lock taken first.
CREATE OR REPLACE FUNCTION block_apply(p_actor bigint, p_target bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo     bigint   := least(p_actor, p_target);
  v_hi     bigint   := greatest(p_actor, p_target);
  v_bit    smallint := CASE WHEN p_actor < p_target THEN 1 ELSE 2 END;
  v_before smallint;
  v_match  bigint;
  v_state  smallint;
  v_ended  boolean := false;
BEGIN
  IF p_actor = p_target OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_target AND u.status <> 8) THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  -- A match of the pair in flight commits first (and is ended below), or waits for this block and is refused.
  PERFORM pg_advisory_xact_lock(pair_lock_key(v_lo, v_hi));
  SELECT b.blocked_by INTO v_before FROM blocks b WHERE b.user_lo = v_lo AND b.user_hi = v_hi FOR UPDATE;
  IF v_before IS NULL THEN
    INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES (v_lo, v_hi, v_bit)
    ON CONFLICT (user_lo, user_hi) DO UPDATE SET blocked_by = blocks.blocked_by | EXCLUDED.blocked_by;
  ELSIF (v_before & v_bit) = 0 THEN
    UPDATE blocks SET blocked_by = blocked_by | v_bit WHERE user_lo = v_lo AND user_hi = v_hi;
  END IF;
  UPDATE matches m SET state = 3, ended_at = now(), ended_by = v_bit
   WHERE m.user_lo = v_lo AND m.user_hi = v_hi AND m.state = 1
  RETURNING m.id, m.state INTO v_match, v_state;
  IF v_match IS NOT NULL THEN
    v_ended := true;
  ELSE
    SELECT m.id, m.state INTO v_match, v_state FROM matches m WHERE m.user_lo = v_lo AND m.user_hi = v_hi;
  END IF;
  RETURN jsonb_build_object(
    'found', true,
    'already', coalesce((v_before & v_bit) <> 0, false),
    'endedNow', v_ended,
    'match', CASE WHEN v_match IS NULL THEN NULL
                  ELSE jsonb_build_object('matchId', v_match::text, 'lo', v_lo::text, 'hi', v_hi::text, 'state', v_state) END);
END
$$;

-- Writes: only the application's roles (CREATE OR REPLACE keeps block_apply's grants).
REVOKE ALL ON FUNCTION match_create(bigint, bigint, bigint, smallint) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION match_create(bigint, bigint, bigint, smallint) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grant$;
