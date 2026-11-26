-- 0028 - Admin (W7d, rules): banned-term scopes, audit targets for terms and
-- device bans, the audit search by action and by target type, the device-ban
-- list by kind; one device-ban row per cause of a ban; the device, phone and
-- Google bans made for a suspension or a ban go when it is lifted or its
-- appeal overturned, and a lift decides the action's open appeal.
--
-- The runner wraps the file in one transaction, so the indexes are built in
-- place (no CONCURRENTLY). An index on the partitioned audit_log is created on
-- every partition, and the partitions made later inherit it. On a database
-- whose device_bans or audit_log is large, build each index by hand first
-- under the same name (CONCURRENTLY; for audit_log one index per partition,
-- then CREATE INDEX ON ONLY audit_log and ALTER INDEX ... ATTACH PARTITION):
-- every CREATE INDEX here says IF NOT EXISTS and then skips it.

-- ─── Banned terms ─────────────────────────────────────────────────────────
-- The code table of the scope bits (the table comment of 0008 stays).
COMMENT ON COLUMN banned_terms.scope IS 'Bitmask: 1 name, 2 about, 4 prompts, 8 messages, 16 job title.';

-- ─── Device bans ──────────────────────────────────────────────────────────
-- GET /v1/admin/device-bans?kind=: newest first within a kind.
CREATE INDEX IF NOT EXISTS device_bans_kind_idx ON device_bans (kind, id);
-- A value is banned while any of its rows is active, and each row is one
-- cause, renewed only by the same cause, so a ban never takes over another
-- cause's row (its author, its record, its removal): the server's own (no
-- admin, no record: an under-age sign-up), one per value; an admin's typed
-- number (an admin, no record), one per value; a record's (action_id: the
-- suspension or ban it goes with, or a kind-9 record), one per value and
-- record. A lift or an overturn removes the rows of its record only.
-- Sign-up and sign-in read every row of a value (device_bans_value_idx).
ALTER TABLE device_bans DROP CONSTRAINT IF EXISTS device_bans_key;
CREATE INDEX IF NOT EXISTS device_bans_value_idx ON device_bans (kind, value_hash);
CREATE UNIQUE INDEX IF NOT EXISTS device_bans_auto_key ON device_bans (kind, value_hash) WHERE created_by IS NULL AND action_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_bans_admin_key ON device_bans (kind, value_hash) WHERE created_by IS NOT NULL AND action_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_bans_action_key ON device_bans (action_id, kind, value_hash) WHERE action_id IS NOT NULL;
COMMENT ON COLUMN device_bans.action_id IS
  'The moderation record this row is for (a suspension or ban: removed with its lift or overturn; or a kind-9 record). NULL: the server''s own ban (created_by NULL) or an admin''s typed number.';

-- ─── The audit log ────────────────────────────────────────────────────────
COMMENT ON COLUMN audit_log.target_type IS
  '0 none, 1 user, 2 photo, 3 report, 4 appeal, 5 purchase, 6 config, 7 admin, 8 campaign, 9 ticket, 10 verification, 11 message (via a report), 12 feature flag, 13 i18n string, 14 product, 15 plan, 16 legal hold, 17 banned term, 18 device ban.';
-- GET /v1/admin/audit?action= and ?targetType= (without a target): newest
-- first within the action or the kind of target.
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, id);
CREATE INDEX IF NOT EXISTS audit_log_target_type_idx ON audit_log (target_type, id);

-- ─── Lifting an action ────────────────────────────────────────────────────
-- As in 0016, and: an open appeal of the lifted action is decided with it
-- (overturned, by the lifting admin, without a decision text: the lift's own
-- text is an internal note), and the device, phone and Google bans made for
-- the action (device_bans.action_id; the panel's "also ban" of a suspension or
-- ban) are removed, answered as `deviceBans` (never the hashes) for their
-- audit rows. A lift locks the action, then the appeal; appeal_decide below
-- takes them in the same order.
CREATE OR REPLACE FUNCTION moderation_revoke(p_action bigint, p_admin integer, p_lift_id bigint, p_reason_text text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_user    bigint;
  v_kind    smallint;
  v_code    smallint;
  v_revoked timestamptz;
  v_settled jsonb;
  v_bans    jsonb;
BEGIN
  SELECT a.user_id, a.kind, a.reason_code, a.revoked_at INTO v_user, v_kind, v_code, v_revoked
    FROM moderation_actions a WHERE a.id = p_action FOR UPDATE;
  IF NOT FOUND OR v_kind NOT IN (1, 2, 3, 4) THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  IF v_revoked IS NULL THEN
    UPDATE moderation_actions SET revoked_at = now(), revoked_by = p_admin WHERE id = p_action;
    IF v_kind IN (2, 3, 4) THEN
      INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text)
      VALUES (p_lift_id, v_user, p_admin, 5, v_code, left(coalesce(nullif(btrim(p_reason_text), ''), 'Lifted.'), 1000));
    END IF;
    UPDATE public.appeals SET status = 3, decided_at = now(), decided_by = p_admin
     WHERE action_id = p_action AND status = 1;
  END IF;
  WITH gone AS (DELETE FROM device_bans b WHERE b.action_id = p_action RETURNING b.id, b.kind, b.store, b.reason, b.expires_at)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id::text, 'kind', g.kind, 'store', g.store, 'reason', g.reason,
           'expiresAtMs', floor(extract(epoch FROM g.expires_at) * 1000)::bigint) ORDER BY g.id), '[]'::jsonb)
    INTO v_bans FROM gone g;
  v_settled := moderation_settle(v_user);
  RETURN v_settled || jsonb_build_object('outcome', 'revoked', 'already', v_revoked IS NOT NULL, 'actionId', p_action::text,
                                         'kind', v_kind, 'action', moderation_action_view(p_action), 'deviceBans', v_bans);
END
$$;

-- As in 0016, and: the action is locked before the appeal (the order of a
-- lift, so a lift and a decision on the same action wait for each other
-- instead of deadlocking), and an uphold of an action lifted meanwhile is
-- refused ({outcome: 'lifted'}): its person must not hear that a lifted
-- penalty stands.
CREATE OR REPLACE FUNCTION appeal_decide(p_appeal bigint, p_admin integer, p_overturn boolean, p_text text, p_lift_id bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_action  bigint;
  v_user    bigint;
  v_status  smallint;
  v_revoked timestamptz;
  v_out     jsonb;
BEGIN
  SELECT ap.action_id INTO v_action FROM appeals ap WHERE ap.id = p_appeal;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'missing'); END IF;
  SELECT a.revoked_at INTO v_revoked FROM moderation_actions a WHERE a.id = v_action FOR UPDATE;
  SELECT ap.user_id, ap.status INTO v_user, v_status FROM appeals ap WHERE ap.id = p_appeal FOR UPDATE;
  IF v_status <> 1 THEN RETURN jsonb_build_object('outcome', 'decided'); END IF;
  IF NOT p_overturn AND v_revoked IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'lifted'); END IF;
  UPDATE public.appeals
     SET status = CASE WHEN p_overturn THEN 3 ELSE 2 END, decided_at = now(), decided_by = p_admin,
         decision_text = left(nullif(btrim(p_text), ''), 2000)
   WHERE id = p_appeal;
  IF p_overturn THEN
    v_out := moderation_revoke(v_action, p_admin, p_lift_id, p_text);
  ELSE
    v_out := jsonb_build_object('userId', v_user::text, 'action', moderation_action_view(v_action));
  END IF;
  RETURN v_out || jsonb_build_object('outcome', CASE WHEN p_overturn THEN 'overturned' ELSE 'upheld' END,
                                     'appealId', p_appeal::text, 'actionId', v_action::text, 'userId', v_user::text);
END
$$;
