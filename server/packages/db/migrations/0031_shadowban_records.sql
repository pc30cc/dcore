-- 0031 - Shadowban records, for callers who may not see shadowbans, and the
-- lift records of shadowbans once more.

-- ─── An appeal's history without shadowbans ───────────────────────────────
-- As admin_appeal_json and admin_appeal_view of 0027, with p_with_shadow:
-- false leaves kind 4 out inside the LIMIT of the person's ten newest other
-- records, so the history holds ten records whenever ten others can be shown
-- (removed after the limit, the one gap a caller sees is a shadowban). The
-- one-argument functions stay as 0027 wrote them (the API of the previous
-- release calls them during a rollout); a call with two arguments resolves
-- to these, never ambiguously.
CREATE FUNCTION admin_appeal_json(ap appeals, p_with_shadow boolean) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  RETURN jsonb_build_object(
    'id', ap.id::text,
    'status', ap.status,
    'body', ap.body,
    'filedAtMs', floor(extract(epoch FROM id_time(ap.id)) * 1000)::bigint,
    'decisionText', ap.decision_text,
    'decidedAtMs', floor(extract(epoch FROM ap.decided_at) * 1000)::bigint,
    'decidedBy', (SELECT jsonb_build_object('id', a.id::text, 'displayName', a.display_name) FROM admin_users a WHERE a.id = ap.decided_by),
    'action', (SELECT admin_action_json(m) FROM moderation_actions m WHERE m.id = ap.action_id),
    'user', (SELECT admin_user_ref(u) FROM users u WHERE u.id = ap.user_id),
    'history', coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT m.id, admin_action_json(m) AS item
                                   FROM moderation_actions m
                                  WHERE m.user_id = ap.user_id AND m.id <> ap.action_id
                                    AND (p_with_shadow OR m.kind <> 4)
                                  ORDER BY m.id DESC
                                  LIMIT 10) x), '[]'::jsonb));

-- VOLATILE, as admin_appeal_view of 0027: it reads the decision of the
-- statement that calls it.
CREATE FUNCTION admin_appeal_view(p_appeal bigint, p_with_shadow boolean) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (SELECT admin_appeal_json(ap, p_with_shadow) FROM appeals ap WHERE ap.id = p_appeal);
END
$$;

REVOKE ALL ON FUNCTION admin_appeal_json(appeals, boolean), admin_appeal_view(bigint, boolean) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION admin_appeal_json(appeals, boolean), admin_appeal_view(bigint, boolean) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grants$;

-- ─── Lift records of shadowbans, once more ────────────────────────────────
-- 0030 ran in one transaction: until it committed, other sessions still ran
-- the moderation_revoke of 0028, and a shadowban lift that committed after
-- 0030's DELETE took its snapshot kept its kind-5 record. Every call that
-- starts after 0030's commit runs the new body, which writes none, so the
-- same exact, idempotent DELETE as 0030's removes those records now (see
-- 0030 for why the match is exact). Only a lift whose transaction was still
-- open from before 0030's commit until after this statement began would be
-- left; the statement can be run again by hand at any time.
DELETE FROM moderation_actions l
 WHERE l.kind = 5
   AND EXISTS (SELECT 1 FROM moderation_actions s
                WHERE s.user_id = l.user_id AND s.kind = 4
                  AND s.revoked_at = l.starts_at
                  AND s.revoked_by IS NOT DISTINCT FROM l.admin_id
                  AND s.reason_code = l.reason_code);
