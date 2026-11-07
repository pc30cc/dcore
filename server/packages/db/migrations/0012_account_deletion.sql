-- 0012 - Account deletion: what a restore returns to, the purge time of a
-- deleted account, and the purge itself (the tombstone).
--
-- A deletion (in the app, on the web page, or by an admin) sets status 7 at
-- once: sessions revoked, conversations ended, discovery row removed by the
-- users trigger (0006). The person may restore the account until the purge
-- time; after it the worker purges the account into a tombstone (status 8),
-- unless a legal hold names the account.

-- ─── users.restore_status ─────────────────────────────────────────────────
-- The status an account had when it was deleted, so a restore brings back an
-- account in review or snoozed as it was, never past a review. A ban or a
-- suspension still in effect at the restore wins over it (moderation_actions
-- are the record); a penalty that ended during the grace gives an active
-- account. NULL outside status 7.
ALTER TABLE users
  ADD COLUMN restore_status smallint CHECK (restore_status BETWEEN 1 AND 6);

COMMENT ON COLUMN users.restore_status IS
  'While status is 7: the users.status the account had when it was deleted, which a restore returns to (unless a ban or suspension is in effect then, or the account never finished its basics). NULL otherwise.';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (restore_status) ON users TO app_ro;
  END IF;
END
$grant$;

-- ─── The purge time ───────────────────────────────────────────────────────
-- When a deleted account is purged: its deletion time plus app_config
-- retention.deleted_account_days (30 by default). The same rule as
-- account_view() (0010) and the sign-in state; the API answers it as
-- `purgeAt` / `restorableUntil`, and a restore after it is refused.
CREATE FUNCTION account_purge_at(p_deleted_at timestamptz) RETURNS timestamptz
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  RETURN p_deleted_at + make_interval(days => coalesce(
    (SELECT (c.value #>> '{}')::integer FROM app_config c WHERE c.key = 'retention.deleted_account_days'), 30));

-- ─── The purge ────────────────────────────────────────────────────────────
-- Turns a deleted account whose grace is over into a tombstone, in one
-- transaction:
--
--   deleted  profile, field values, prompts, preferences, location,
--            verifications, devices, sessions, sign-in identities, blocks,
--            message requests in both directions, likes received, and the
--            account's conversations: their messages, calls (cascade) and
--            the matches rows themselves;
--   kept     the users row as a tombstone (status 8; birth date, gender,
--            country, activity date NULL), consent records, reports,
--            moderation actions and appeals, device and phone bans, store
--            purchases and events, the wallet ledger, support tickets;
--   later    likes the person gave leave with their weekly partitions
--            (there is no actor index on purpose).
--
-- Photo rows are kept and returned: the worker deletes their blobs from
-- object storage, then the rows (account_purge_photos below), so a failed
-- storage call never loses track of a blob. A conversation named by an
-- active legal hold is kept whole (messages, calls, the match) and listed in
-- `heldMatchIds`; the worker runs the purge again later, which then deletes
-- what was released. An account named by an active hold is not purged at all
-- (`held`). Running it again on a tombstone deletes what is left and changes
-- nothing else.
--
-- p_now: the time the purge is due against (the worker's clock; NULL is
-- now()). The row lock is FOR UPDATE, which also waits for a legal hold being
-- inserted for the account (its foreign key takes KEY SHARE on the row), so
-- the hold check below sees every hold committed before the purge.
--
-- Returns {outcome: purged | not_due | held | not_deleted | missing,
--          purgeAtMs, matchIds, heldMatchIds, deviceIds, sessionIds,
--          photos: [{id, blobVer}]} (ids as text).
CREATE FUNCTION account_purge(p_user bigint, p_now timestamptz DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_now       timestamptz := coalesce(p_now, now());
  v_status    smallint;
  v_deleted   timestamptz;
  v_purge_at  timestamptz;
  v_matches   bigint[];
  v_held      bigint[];
  v_devices   bigint[];
  v_sessions  bigint[];
  v_photos    jsonb;
BEGIN
  SELECT u.status, u.deleted_at INTO v_status, v_deleted FROM users u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  IF v_status NOT IN (7, 8) THEN
    RETURN jsonb_build_object('outcome', 'not_deleted');
  END IF;
  v_purge_at := account_purge_at(v_deleted);
  IF v_status = 7 AND v_purge_at > v_now THEN
    RETURN jsonb_build_object('outcome', 'not_due',
                              'purgeAtMs', floor(extract(epoch FROM v_purge_at) * 1000)::bigint);
  END IF;
  IF EXISTS (SELECT 1 FROM legal_holds h WHERE h.user_id = p_user AND h.released_at IS NULL) THEN
    RETURN jsonb_build_object('outcome', 'held',
                              'purgeAtMs', floor(extract(epoch FROM v_purge_at) * 1000)::bigint);
  END IF;

  -- The account's conversations, apart from the ones an active hold names.
  SELECT coalesce(array_agg(x.id) FILTER (WHERE NOT x.held), '{}'),
         coalesce(array_agg(x.id) FILTER (WHERE x.held), '{}')
    INTO v_matches, v_held
    FROM (SELECT m.id, EXISTS (SELECT 1 FROM legal_holds h WHERE h.match_id = m.id AND h.released_at IS NULL) AS held
            FROM matches m WHERE m.user_lo = p_user
          UNION ALL
          SELECT m.id, EXISTS (SELECT 1 FROM legal_holds h WHERE h.match_id = m.id AND h.released_at IS NULL)
            FROM matches m WHERE m.user_hi = p_user) x;

  IF cardinality(v_matches) > 0 THEN
    -- Each messages partition is probed by its primary key (match_id, id).
    DELETE FROM messages WHERE match_id = ANY (v_matches);
    -- calls cascade; reports and message requests keep their row (match_id SET NULL).
    DELETE FROM matches WHERE id = ANY (v_matches);
  END IF;

  DELETE FROM message_requests WHERE from_id = p_user;
  DELETE FROM message_requests WHERE to_id = p_user;
  DELETE FROM likes WHERE target_id = p_user;
  DELETE FROM blocks WHERE user_lo = p_user;
  DELETE FROM blocks WHERE user_hi = p_user;

  DELETE FROM verifications WHERE user_id = p_user;
  DELETE FROM profile_prompts WHERE user_id = p_user;
  DELETE FROM profile_field_values WHERE user_id = p_user;
  DELETE FROM preferences WHERE user_id = p_user;
  DELETE FROM user_locations WHERE user_id = p_user;
  DELETE FROM profiles WHERE user_id = p_user;
  DELETE FROM discovery WHERE user_id = p_user;

  -- Sessions name devices: both in one statement (foreign keys are checked at its end).
  WITH s AS (DELETE FROM sessions WHERE user_id = p_user RETURNING id),
       d AS (DELETE FROM devices WHERE user_id = p_user RETURNING id)
  SELECT coalesce((SELECT array_agg(s.id) FROM s), '{}'), coalesce((SELECT array_agg(d.id) FROM d), '{}')
    INTO v_sessions, v_devices;
  DELETE FROM auth_identities WHERE user_id = p_user;

  UPDATE users
     SET status = 8, birth_date = NULL, gender = NULL, country = NULL, last_active_on = NULL,
         is_verified = false, restore_status = NULL
   WHERE id = p_user;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id::text, 'blobVer', p.blob_ver) ORDER BY p.id), '[]')
    INTO v_photos
    FROM photos p WHERE p.user_id = p_user;

  RETURN jsonb_build_object(
    'outcome', 'purged',
    'purgeAtMs', floor(extract(epoch FROM v_purge_at) * 1000)::bigint,
    'matchIds', (SELECT coalesce(jsonb_agg(v::text), '[]') FROM unnest(v_matches) v),
    'heldMatchIds', (SELECT coalesce(jsonb_agg(v::text), '[]') FROM unnest(v_held) v),
    'deviceIds', (SELECT coalesce(jsonb_agg(v::text), '[]') FROM unnest(v_devices) v),
    'sessionIds', (SELECT coalesce(jsonb_agg(v::text), '[]') FROM unnest(v_sessions) v),
    'photos', v_photos);
END;
$$;

COMMENT ON FUNCTION account_purge(bigint, timestamptz) IS
  'Purges a deleted account whose grace is over into a tombstone (status 8), keeping what a legal hold names and the photo rows whose blobs the worker still has to delete. Idempotent.';

-- After the worker deleted the blobs of a purged account's photos: the rows.
-- Only a tombstone's, so a restored account can never lose a photo here.
CREATE FUNCTION account_purge_photos(p_user bigint, p_photos bigint[]) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM photos p
   USING users u
   WHERE u.id = p_user AND u.status = 8
     AND p.user_id = p_user AND p.id = ANY (p_photos);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- The purge is the worker's: not for PUBLIC (the analytics role among them).
-- Both run with the caller's rights, so the caller also needs the DML.
REVOKE ALL ON FUNCTION account_purge(bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION account_purge_photos(bigint, bigint[]) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION account_purge(bigint, timestamptz), account_purge_photos(bigint, bigint[]) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grants$;
