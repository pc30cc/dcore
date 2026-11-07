-- 0016 - Safety writes, each one statement for its caller: a block, a
-- report (with its optional block and the automatic legal hold of a
-- child-safety report), and the moderation actions the server applies
-- (warnings, suspensions, bans, shadowbans), their lifting, the end of their
-- period and the decision on an appeal.
--
-- Every function returns jsonb with what the caller's Valkey and realtime
-- side needs (the conversations that ended, the peers whose lists change,
-- the account's state before and after), so the request paths read nothing
-- else. Ids are text inside the jsonb (63-bit integers lose digits as JSON
-- numbers in JavaScript).

-- ─── Blocks ───────────────────────────────────────────────────────────────
-- The actor blocks the target: the actor's bit is added to the pair's row
-- (0015's trigger keeps each side's time), and the pair's active match ends
-- as "ended by a block" (state 3, ended_by the actor's side). A target that
-- does not exist, is purged or is the actor: {found: false}, nothing
-- written. A block of someone already blocked changes nothing else. The
-- answer names the pair's match whatever its state (`endedNow` when this
-- call ended it), so a caller whose Valkey side failed can repeat it.
CREATE FUNCTION block_apply(p_actor bigint, p_target bigint) RETURNS jsonb
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

COMMENT ON FUNCTION block_apply(bigint, bigint) IS
  'A block by p_actor: blocks row (actor''s bit), the active match ended with state 3. Returns {found, already, endedNow, match: {matchId, lo, hi, state} | null}.';

-- ─── Reports ──────────────────────────────────────────────────────────────
-- How urgent a reason is, for the moderation queue (reports.priority).
CREATE FUNCTION report_weight(p_reason smallint) RETURNS smallint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN (CASE p_reason
            WHEN 8 THEN 100   -- child safety: jumps the queue
            WHEN 5 THEN 90    -- under 18
            WHEN 6 THEN 80    -- threat or danger
            WHEN 2 THEN 60    -- harassment
            WHEN 4 THEN 60    -- scam
            WHEN 3 THEN 50    -- inappropriate content
            WHEN 1 THEN 40    -- fake
            WHEN 7 THEN 30    -- spam
            ELSE 20           -- other
          END)::smallint;

-- The evidence of a report: {"v": 1, "items": [...]}, one item per filing
-- (a second report of the same person by the same reporter adds an item),
-- the newest 20 kept.
CREATE FUNCTION report_evidence_append(p_evidence jsonb, p_items jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN jsonb_build_object(
    'v', 1,
    'items', coalesce((SELECT jsonb_agg(e.value ORDER BY e.n)
                         FROM (SELECT x.value, x.n, count(*) OVER () AS total
                                 FROM jsonb_array_elements(coalesce(p_evidence -> 'items', '[]'::jsonb)
                                                           || coalesce(p_items, '[]'::jsonb)) WITH ORDINALITY AS x(value, n)) e
                        WHERE e.n > e.total - 20), '[]'::jsonb));

-- What the reported person's profile said when the report was filed (it
-- may be edited or deleted before a moderator looks): name, texts with
-- their moderation state, prompt answers, and every photo id.
CREATE FUNCTION report_profile_snapshot(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN (SELECT jsonb_strip_nulls(jsonb_build_object(
                   'name', p.display_name,
                   'about', p.about,
                   'job', p.job_title,
                   'textState', p.text_state,
                   'prompts', (SELECT jsonb_agg(jsonb_build_object('promptId', pp.prompt_id, 'answer', pp.answer, 'status', pp.status)
                                                ORDER BY pp.position)
                                 FROM profile_prompts pp WHERE pp.user_id = p.user_id),
                   'photos', (SELECT jsonb_agg(ph.id::text ORDER BY ph.position) FROM photos ph WHERE ph.user_id = p.user_id)))
            FROM profiles p WHERE p.user_id = p_user);

-- A report from the app, in one transaction:
--   * the target must exist and not be the reporter; a conversation id must
--     be the pair's match, a photo the target's, a finished call the pair's
--     (a call still live has no row yet and is taken as given);
--   * one open report per reporter and target: a second one adds an item to
--     the open one's evidence (the more urgent reason wins);
--   * the evidence is complete at once for profile, photo and call reports
--     (evidence_at); a chat report waits for the chat evidence job, which
--     snapshots the messages once the write-behind stream passed them;
--   * the priority of every open report on the target: the reason's weight,
--     +5 for each further distinct reporter, +5 for each earlier report on
--     them that was actioned (each bonus at most +20), at most 100;
--   * with p_block, the reporter's block (block_apply);
--   * a child-safety report (reason 8) puts the target and the pair's
--     conversation under a legal hold at once (kind 1, created_by NULL), once
--     per report.
-- Returns {outcome: 'filed', reportId, merged, block, holds} or
-- {outcome: 'not_found'}.
CREATE FUNCTION report_file(
  p_id           bigint,
  p_reporter     bigint,
  p_target       bigint,
  p_context      smallint,
  p_reason       smallint,
  p_details      text,
  p_conversation bigint,
  p_messages     bigint[],
  p_photo        bigint,
  p_call         bigint,
  p_block        boolean
) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_match     bigint;
  v_photo     jsonb;
  v_item      jsonb;
  v_report    bigint;
  v_inserted  boolean;
  v_reporters integer;
  v_actioned  integer;
  v_block     jsonb;
  v_holds     integer := 0;
  v_n         integer;
BEGIN
  IF p_reporter = p_target OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_target) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT m.id INTO v_match FROM matches m
   WHERE m.user_lo = least(p_reporter, p_target) AND m.user_hi = greatest(p_reporter, p_target);
  IF p_conversation IS NOT NULL AND p_conversation IS DISTINCT FROM v_match THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF p_photo IS NOT NULL THEN
    SELECT jsonb_build_object('id', ph.id::text, 'blobVer', ph.blob_ver, 'position', ph.position, 'status', ph.status)
      INTO v_photo FROM photos ph WHERE ph.id = p_photo AND ph.user_id = p_target;
    IF v_photo IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  END IF;
  IF p_call IS NOT NULL AND EXISTS (SELECT 1 FROM calls c WHERE c.id = p_call AND c.match_id IS DISTINCT FROM v_match) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  v_item := jsonb_strip_nulls(jsonb_build_object(
    'reportId', p_id::text,
    'atMs', floor(extract(epoch FROM now()) * 1000)::bigint,
    'context', p_context,
    'reason', p_reason,
    'details', p_details,
    'conversationId', p_conversation::text,
    'messageIds', (SELECT jsonb_agg(x::text ORDER BY o) FROM unnest(p_messages) WITH ORDINALITY AS u(x, o)),
    'photo', v_photo,
    'callId', p_call::text,
    'profile', report_profile_snapshot(p_target)));

  INSERT INTO reports AS r (id, target_id, reporter_id, match_id, context, reason, details, evidence, evidence_at, priority)
  VALUES (p_id, p_target, p_reporter, v_match, p_context, p_reason, p_details,
          report_evidence_append('{}'::jsonb, jsonb_build_array(v_item)),
          CASE WHEN p_context = 2 THEN NULL ELSE now() END,
          report_weight(p_reason))
  ON CONFLICT (reporter_id, target_id) WHERE status IN (1, 2) AND reporter_id IS NOT NULL
  DO UPDATE SET
    reason      = CASE WHEN report_weight(EXCLUDED.reason) > report_weight(r.reason) THEN EXCLUDED.reason ELSE r.reason END,
    details     = coalesce(EXCLUDED.details, r.details),
    match_id    = coalesce(r.match_id, EXCLUDED.match_id),
    evidence    = report_evidence_append(r.evidence, EXCLUDED.evidence -> 'items'),
    evidence_at = CASE WHEN EXCLUDED.context = 2 THEN NULL ELSE r.evidence_at END
  RETURNING r.id, (r.xmax = 0) INTO v_report, v_inserted;

  -- Bounded counts: only as many as the bonuses can use.
  SELECT count(*) INTO v_reporters
    FROM (SELECT DISTINCT x.reporter_id FROM reports x
           WHERE x.target_id = p_target AND x.status IN (1, 2) AND x.reporter_id IS NOT NULL LIMIT 5) d;
  SELECT count(*) INTO v_actioned
    FROM (SELECT 1 FROM reports x WHERE x.target_id = p_target AND x.status = 3 LIMIT 4) d;
  UPDATE reports x
     SET priority = least(100, report_weight(x.reason) + least(20, 5 * greatest(v_reporters - 1, 0)) + least(20, 5 * v_actioned))
   WHERE x.target_id = p_target AND x.status IN (1, 2)
     AND x.priority IS DISTINCT FROM least(100, report_weight(x.reason) + least(20, 5 * greatest(v_reporters - 1, 0)) + least(20, 5 * v_actioned));

  IF p_block THEN
    v_block := block_apply(p_reporter, p_target);
  END IF;

  IF p_reason = 8 THEN
    INSERT INTO legal_holds (id, user_id, report_id, kind)
    SELECT id_next(), p_target, v_report, 1
     WHERE NOT EXISTS (SELECT 1 FROM legal_holds h
                        WHERE h.report_id = v_report AND h.user_id = p_target AND h.released_at IS NULL);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_holds := v_holds + v_n;
    IF v_match IS NOT NULL THEN
      INSERT INTO legal_holds (id, match_id, report_id, kind)
      SELECT id_next(), v_match, v_report, 1
       WHERE NOT EXISTS (SELECT 1 FROM legal_holds h
                          WHERE h.report_id = v_report AND h.match_id = v_match AND h.released_at IS NULL);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_holds := v_holds + v_n;
    END IF;
  END IF;

  RETURN jsonb_build_object('outcome', 'filed', 'reportId', v_report::text, 'merged', NOT v_inserted,
                            'block', v_block, 'holds', v_holds);
END
$$;

COMMENT ON FUNCTION report_file(bigint, bigint, bigint, smallint, smallint, text, bigint, bigint[], bigint, bigint, boolean) IS
  'POST /v1/reports in one statement: the report (or an item added to the open one), priorities, the optional block, and the automatic legal hold of a child-safety report.';

-- ─── Moderation actions ───────────────────────────────────────────────────
-- users.status and is_shadowbanned hold the current effect of the
-- penalties; moderation_actions is the record (0015: prior_status,
-- moderation_standing, moderation_resting_status). A deleted account
-- (status 7) keeps its status: a restore applies whatever stands then.

-- The account's own peers in active conversations (their lists change when
-- the account leaves them or comes back).
CREATE FUNCTION moderation_peers(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN coalesce((SELECT jsonb_agg(x.peer::text)
                     FROM (SELECT m.user_hi AS peer FROM matches m WHERE m.user_lo = p_user AND m.state = 1
                           UNION ALL
                           SELECT m.user_lo FROM matches m WHERE m.user_hi = p_user AND m.state = 1) x), '[]'::jsonb);

-- What the person reads of an action (warnings, suspensions, bans; never a
-- shadowban): the shape GET /v1/me/moderation answers, with times in ms.
CREATE FUNCTION moderation_action_view(p_action bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN (SELECT jsonb_strip_nulls(jsonb_build_object(
                   'id', a.id::text,
                   'kind', a.kind,
                   'reasonText', a.reason_text,
                   'startsAtMs', floor(extract(epoch FROM a.starts_at) * 1000)::bigint,
                   'endsAtMs', floor(extract(epoch FROM a.ends_at) * 1000)::bigint,
                   'appeal', (SELECT jsonb_strip_nulls(jsonb_build_object('id', ap.id::text, 'status', ap.status, 'decisionText', ap.decision_text))
                                FROM appeals ap WHERE ap.action_id = a.id ORDER BY ap.id DESC LIMIT 1)))
            FROM moderation_actions a WHERE a.id = p_action AND a.kind IN (1, 2, 3));

-- Puts an account's state in line with the actions that stand now: a
-- suspended or banned account whose penalties no longer stand returns to
-- its resting status, the shadowban follows the standing shadowbans. Used
-- after a lift and when a period ends. Returns {outcome: 'settled',
-- userId, before, after, peers} or {outcome: 'missing'}.
CREATE FUNCTION moderation_settle(p_user bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_status     smallint;
  v_shadow     boolean;
  v_new_status smallint;
  v_new_shadow boolean;
BEGIN
  SELECT u.status, u.is_shadowbanned INTO v_status, v_shadow FROM users u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND OR v_status = 8 THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  v_new_status := CASE WHEN v_status IN (5, 6) THEN moderation_resting_status(p_user, NULL) ELSE v_status END;
  v_new_shadow := moderation_standing(p_user, 4::smallint, NULL);
  IF v_new_status <> v_status OR v_new_shadow <> v_shadow THEN
    UPDATE users SET status = v_new_status, is_shadowbanned = v_new_shadow WHERE id = p_user;
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'settled',
    'userId', p_user::text,
    'before', jsonb_build_object('status', v_status, 'shadowbanned', v_shadow),
    'after', jsonb_build_object('status', v_new_status, 'shadowbanned', v_new_shadow),
    'ended', '[]'::jsonb,
    'peers', moderation_peers(p_user));
END
$$;

-- A penalty the server applies (an admin through the panel, or an
-- automatic rule with p_admin NULL), in one transaction:
--   1 warning      the record only;
--   2 suspension   status 5 (ends_at required), unless a ban stands;
--   3 ban          status 6; the account's active conversations end
--                  (state 4, "ended by a ban or deletion"; a lifted ban does
--                  not bring them back) and its pending message requests
--                  are withdrawn;
--   4 shadowban    is_shadowbanned (never shown to its subject).
-- A suspension or ban records the status it began from (prior_status).
-- Returns {outcome: 'applied', userId, actionId, kind, before, after,
-- ended: [{matchId, lo, hi, peerId}], peers, action} or {outcome: 'missing'}.
CREATE FUNCTION moderation_apply(
  p_id          bigint,
  p_user        bigint,
  p_kind        smallint,
  p_reason_code smallint,
  p_reason_text text,
  p_ends_at     timestamptz,
  p_admin       integer,
  p_report      bigint,
  p_note        text
) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_status     smallint;
  v_shadow     boolean;
  v_restore    smallint;
  v_new_status smallint;
  v_new_shadow boolean;
  v_ended      jsonb := '[]'::jsonb;
BEGIN
  IF p_kind NOT IN (1, 2, 3, 4) THEN
    RAISE EXCEPTION 'moderation_apply: kind % is not a penalty', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT u.status, u.is_shadowbanned, u.restore_status INTO v_status, v_shadow, v_restore
    FROM users u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND OR v_status = 8 THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  v_new_status := v_status;
  v_new_shadow := v_shadow;
  IF p_kind = 3 AND v_status IN (1, 2, 3, 4, 5) THEN
    v_new_status := 6;
  ELSIF p_kind = 2 AND v_status IN (1, 2, 3, 4) THEN
    v_new_status := 5;
  ELSIF p_kind = 4 THEN
    v_new_shadow := true;
  END IF;

  INSERT INTO moderation_actions (id, user_id, report_id, ends_at, admin_id, kind, reason_code, reason_text, note, prior_status)
  VALUES (p_id, p_user, p_report, p_ends_at, p_admin, p_kind, p_reason_code, p_reason_text, p_note,
          CASE WHEN p_kind IN (2, 3) THEN (CASE WHEN v_status = 7 THEN v_restore ELSE v_status END) END);

  IF v_new_status <> v_status OR v_new_shadow <> v_shadow THEN
    UPDATE users SET status = v_new_status, is_shadowbanned = v_new_shadow WHERE id = p_user;
  END IF;

  IF p_kind = 3 THEN
    WITH mine AS (
      SELECT m.id FROM matches m WHERE m.user_lo = p_user AND m.state = 1
      UNION ALL
      SELECT m.id FROM matches m WHERE m.user_hi = p_user AND m.state = 1
    ), ended AS (
      UPDATE matches m SET state = 4, ended_at = now(), ended_by = 3
        FROM mine WHERE m.id = mine.id AND m.state = 1
      RETURNING m.id, m.user_lo, m.user_hi
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'matchId', e.id::text, 'lo', e.user_lo::text, 'hi', e.user_hi::text,
             'peerId', (CASE WHEN e.user_lo = p_user THEN e.user_hi ELSE e.user_lo END)::text)), '[]'::jsonb)
      INTO v_ended FROM ended e;
    UPDATE message_requests SET status = 5, decided_at = now() WHERE from_id = p_user AND status = 1;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'userId', p_user::text,
    'actionId', p_id::text,
    'kind', p_kind,
    'before', jsonb_build_object('status', v_status, 'shadowbanned', v_shadow),
    'after', jsonb_build_object('status', v_new_status, 'shadowbanned', v_new_shadow),
    'ended', v_ended,
    'peers', moderation_peers(p_user),
    'action', moderation_action_view(p_id));
END
$$;

-- Lifts an action before its end (an admin, or an appeal that overturned
-- it): revoked_at and revoked_by, a lift record (kind 5) for suspensions,
-- bans and shadowbans, then the account settled. An action already revoked
-- is settled again and answered 'revoked' with already = true.
CREATE FUNCTION moderation_revoke(p_action bigint, p_admin integer, p_lift_id bigint, p_reason_text text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_user    bigint;
  v_kind    smallint;
  v_code    smallint;
  v_revoked timestamptz;
  v_settled jsonb;
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
  END IF;
  v_settled := moderation_settle(v_user);
  RETURN v_settled || jsonb_build_object('outcome', 'revoked', 'already', v_revoked IS NOT NULL, 'actionId', p_action::text,
                                         'kind', v_kind, 'action', moderation_action_view(p_action));
END
$$;

-- The decision on an open appeal: upheld (the action stays) or overturned
-- (the action is lifted in the same transaction). Returns {outcome:
-- 'upheld' | 'overturned', appealId, actionId, userId, ...settle} or
-- {outcome: 'missing' | 'decided'}.
CREATE FUNCTION appeal_decide(p_appeal bigint, p_admin integer, p_overturn boolean, p_text text, p_lift_id bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_action bigint;
  v_user   bigint;
  v_status smallint;
  v_out    jsonb;
BEGIN
  SELECT ap.action_id, ap.user_id, ap.status INTO v_action, v_user, v_status FROM appeals ap WHERE ap.id = p_appeal FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'missing'); END IF;
  IF v_status <> 1 THEN RETURN jsonb_build_object('outcome', 'decided'); END IF;
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

-- Actions whose period ends (suspensions, timed bans and shadowbans): the
-- worker's sweep finds those that ended without their account being settled.
CREATE INDEX moderation_actions_period_idx ON moderation_actions (ends_at)
  WHERE kind IN (2, 3, 4) AND revoked_at IS NULL AND ends_at IS NOT NULL;

-- Writes: only the application's roles.
REVOKE ALL ON FUNCTION block_apply(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION report_file(bigint, bigint, bigint, smallint, smallint, text, bigint, bigint[], bigint, bigint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation_settle(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation_apply(bigint, bigint, smallint, smallint, text, timestamptz, integer, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation_revoke(bigint, integer, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION appeal_decide(bigint, integer, boolean, text, bigint) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION
      block_apply(bigint, bigint),
      report_file(bigint, bigint, bigint, smallint, smallint, text, bigint, bigint[], bigint, bigint, boolean),
      moderation_settle(bigint),
      moderation_apply(bigint, bigint, smallint, smallint, text, timestamptz, integer, bigint, text),
      moderation_revoke(bigint, integer, bigint, text),
      appeal_decide(bigint, integer, boolean, text, bigint)
    TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grant$;
