-- 0027 - Admin (W7d, moderation): the text queue, photo decisions, report
-- resolution codes and queues, hold release reasons. (The photo reject codes'
-- comment is in 0026.)
--
-- The runner wraps the file in one transaction, so the indexes are built in
-- place (no CONCURRENTLY), holding a SHARE lock on their table until COMMIT.
-- On a database whose profiles or reports tables are large, build each index
-- by hand first with CREATE INDEX CONCURRENTLY under the same name: every
-- CREATE INDEX here says IF NOT EXISTS and then skips it. The new column is
-- added bare and its CHECKs NOT VALID (the rows that exist hold NULL; every
-- row written later is checked).

-- ─── The text queue ───────────────────────────────────────────────────────
-- GET /v1/admin/moderation/texts: profiles whose about or job waits for a
-- human, and prompt answers that do. A profile made with a name only also
-- sits at text_state 1 (writeProfile's default) and has no text: the
-- predicate leaves it out.
CREATE INDEX IF NOT EXISTS profiles_text_review_idx ON profiles (user_id)
  WHERE text_state = 1 AND (about IS NOT NULL OR job_title IS NOT NULL);
CREATE INDEX IF NOT EXISTS profile_prompts_review_idx ON profile_prompts (user_id) WHERE status = 1;

-- ─── Reports ──────────────────────────────────────────────────────────────
COMMENT ON COLUMN reports.resolution IS
  '1 warning, 2 suspension, 3 ban, 4 shadowban, 5 content removed, 6 other action (1-6 close with action: status 3), 11 no violation, 12 not enough evidence, 13 duplicate (status 5), 14 other (11-14 close without action: status 4, a duplicate 5).';
-- "Assigned to me" and the closed history of the reports page.
CREATE INDEX IF NOT EXISTS reports_assignee_idx ON reports (assigned_to, priority DESC, id)
  WHERE status IN (1, 2) AND assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_resolved_idx ON reports (resolved_at DESC, id DESC) WHERE status IN (3, 4, 5);

-- ─── Legal holds ──────────────────────────────────────────────────────────
-- Why a hold was released (the panel asks for it). No app_ro grant: holds are
-- not analytics data (0009 grants nothing on legal_holds).
ALTER TABLE legal_holds ADD COLUMN released_reason text;
ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_released_reason_check CHECK (char_length(released_reason) BETWEEN 1 AND 500) NOT VALID;
ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_released_reason CHECK (released_reason IS NULL OR released_at IS NOT NULL) NOT VALID;
-- The holds page's active list.
CREATE INDEX IF NOT EXISTS legal_holds_active_idx ON legal_holds (id) WHERE released_at IS NULL;

-- ─── photo_decide ─────────────────────────────────────────────────────────
-- An admin's decision on one photo (the photo queue, the user page, a
-- report), in one statement:
--   approve   waiting (2) or rejected (4) -> approved (3); approved: unchanged;
--   reject    waiting, approved or rejected for another reason -> rejected
--             (4) with p_reason, and a kind-6 record; rejected for the same
--             reason: unchanged.
-- A photo still processing (1) is not decided ('processing'). p_expect is the
-- status the admin saw (null: any): a photo found in another status, and not
-- already in the one asked, was decided by someone else meanwhile
-- ('decided_elsewhere', nothing written), so two moderators on the same queue
-- never undo each other's decision. A photo already as asked reads
-- 'unchanged' whatever p_expect (a repeated decision). The existing
-- triggers do the rest: photos_version_upd bumps profiles.version (the card,
-- discovery's approved-photos rule), photos_verification_upd lapses a
-- verification whose reference photo is no longer approved.
-- Returns {outcome: 'decided', photoId, userId, position, blobVer, locale,
-- before: {status, rejectReason}, after: {...}, actionId} or {outcome:
-- 'unchanged' | 'decided_elsewhere', photoId, userId, status, rejectReason,
-- locale} or {outcome: 'missing' | 'processing'}.
CREATE FUNCTION photo_decide(
  p_photo       bigint,
  p_admin       integer,
  p_approve     boolean,
  p_reason      smallint,
  p_action_id   bigint,
  p_reason_text text,
  p_expect      smallint
) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_user       bigint;
  v_status     smallint;
  v_reason     smallint;
  v_position   smallint;
  v_blob       smallint;
  v_locale     text;
  v_new_status smallint;
  v_new_reason smallint;
  v_action     bigint;
BEGIN
  SELECT ph.user_id, ph.status, ph.reject_reason, ph.position, ph.blob_ver, u.locale
    INTO v_user, v_status, v_reason, v_position, v_blob, v_locale
    FROM photos ph JOIN users u ON u.id = ph.user_id
   WHERE ph.id = p_photo AND u.status <> 8
     FOR UPDATE OF ph;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  IF v_status = 1 THEN
    RETURN jsonb_build_object('outcome', 'processing');
  END IF;
  IF NOT p_approve AND p_reason IS NULL THEN
    RAISE EXCEPTION 'photo_decide: a rejection needs a reason' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF (p_approve AND v_status = 3) OR (NOT p_approve AND v_status = 4 AND v_reason = p_reason) THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'outcome', 'unchanged', 'photoId', p_photo::text, 'userId', v_user::text,
      'status', v_status, 'rejectReason', v_reason, 'locale', v_locale));
  END IF;
  IF p_expect IS NOT NULL AND v_status <> p_expect THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'outcome', 'decided_elsewhere', 'photoId', p_photo::text, 'userId', v_user::text,
      'status', v_status, 'rejectReason', v_reason, 'locale', v_locale));
  END IF;

  v_new_status := CASE WHEN p_approve THEN 3 ELSE 4 END;
  v_new_reason := CASE WHEN p_approve THEN NULL ELSE p_reason END;
  UPDATE photos
     SET status = v_new_status, reject_reason = v_new_reason, decided_at = now(), decided_by = p_admin
   WHERE id = p_photo;

  IF NOT p_approve THEN
    INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text, note)
    VALUES (p_action_id, v_user, p_admin, 6, p_reason, p_reason_text, 'photo ' || p_photo);
    v_action := p_action_id;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'decided',
    'photoId', p_photo::text,
    'userId', v_user::text,
    'position', v_position,
    'blobVer', v_blob,
    'locale', v_locale,
    'before', jsonb_strip_nulls(jsonb_build_object('status', v_status, 'rejectReason', v_reason)),
    'after', jsonb_strip_nulls(jsonb_build_object('status', v_new_status, 'rejectReason', v_new_reason)),
    'actionId', v_action::text);
END
$$;

REVOKE ALL ON FUNCTION photo_decide(bigint, integer, boolean, smallint, bigint, text, smallint) FROM PUBLIC;

-- ─── The panel's view of an appeal ────────────────────────────────────────
-- Codes stay codes, times epoch ms, ids text (as the views of 0026): the
-- appeal, the record it is about (admin_action_json), the person and their
-- ten newest other records (moderation_actions_user_idx).
CREATE FUNCTION admin_appeal_json(ap appeals) RETURNS jsonb
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
                                  ORDER BY m.id DESC
                                  LIMIT 10) x), '[]'::jsonb));

-- VOLATILE on purpose (as admin_user_view of 0026): called in the statement
-- that decided the appeal, its query takes a fresh snapshot and sees that
-- decision, so the route answers the state after it without a statement of
-- its own.
CREATE FUNCTION admin_appeal_view(p_appeal bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (SELECT admin_appeal_json(ap) FROM appeals ap WHERE ap.id = p_appeal);
END
$$;

REVOKE ALL ON FUNCTION admin_appeal_json(appeals), admin_appeal_view(bigint) FROM PUBLIC;

-- ─── Grants ───────────────────────────────────────────────────────────────
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION
      photo_decide(bigint, integer, boolean, smallint, bigint, text, smallint),
      admin_appeal_json(appeals), admin_appeal_view(bigint)
    TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grants$;
