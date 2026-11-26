-- 0030 - Admin: a lift writes a kind-5 record for a suspension or a ban only.
-- A shadowban's lift is its revoked_at and revoked_by (as a warning's), its
-- text in the user.lift audit row, so no record but the kind-4 row itself
-- says a shadowban existed. The lift records written for shadowbans before
-- this file are removed.

-- ─── Lifting an action ────────────────────────────────────────────────────
-- As in 0028, but the lift record is written for kinds 2 and 3 only.
-- CREATE OR REPLACE keeps the grants of 0016; callers still pass p_lift_id
-- (unused for kinds 1 and 4).
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
    IF v_kind IN (2, 3) THEN
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

-- ─── Lift records of shadowbans written before this file ──────────────────
-- moderation_revoke wrote the lift in the transaction that set revoked_at, so
-- its starts_at (DEFAULT now()) equals the shadowban's revoked_at, with the
-- same admin and the copied reason code. Every write path revokes one action
-- per transaction (the lift route; appeal_decide only for kinds 1-3), so the
-- match is exact. Nothing references a kind-5 row (appeals reach kinds 1-3,
-- device_bans.action_id kinds 2, 3 and 9 with ON DELETE SET NULL). The inner
-- probe uses moderation_actions_user_idx.
DELETE FROM moderation_actions l
 WHERE l.kind = 5
   AND EXISTS (SELECT 1 FROM moderation_actions s
                WHERE s.user_id = l.user_id AND s.kind = 4
                  AND s.revoked_at = l.starts_at
                  AND s.revoked_by IS NOT DISTINCT FROM l.admin_id
                  AND s.reason_code = l.reason_code);

COMMENT ON COLUMN moderation_actions.revoked_at IS
  'When the action was lifted (revoked_by: by whom). A suspension''s or ban''s lift also writes a kind-5 record; a warning''s or shadowban''s lift is these two columns only.';
