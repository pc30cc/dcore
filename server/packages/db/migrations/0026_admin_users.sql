-- 0026 - Admin (W7d, users): name search, user filters, the reason a person
-- reads for a rejected text, the text decision, the moderator's grants.
--
-- The runner wraps the file in one transaction, so the indexes are built in
-- place (no CONCURRENTLY), holding a SHARE lock on their table until COMMIT.
-- On a database whose users and profiles tables are large, build each index
-- by hand first with CREATE INDEX CONCURRENTLY under the same name: every
-- CREATE INDEX here says IF NOT EXISTS and then skips it. The new columns
-- are added bare (no rewrite, no scan) and their CHECKs NOT VALID: the rows
-- that exist hold NULL, and every row written later is checked.

-- ─── Name search ──────────────────────────────────────────────────────────
-- Name search in the panel (POST /v1/admin/users/search): names whose word
-- similarity to the text is at least 0.3, nearest first, from the GIN
-- trigram index (admin_name_search below). A text close to no name reads a
-- handful of index pages, however many profiles there are.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS profiles_name_trgm_idx ON profiles USING gin (display_name gin_trgm_ops);

-- The profiles whose name holds a word close to p_q (strict word similarity
-- at least 0.3: the <<% operator under the threshold set on the function),
-- nearest first. The GIN index finds the candidates by trigram; only they
-- are ranked.
CREATE FUNCTION admin_name_search(p_q text, p_limit integer) RETURNS TABLE (user_id bigint, d real)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
  SET pg_trgm.strict_word_similarity_threshold = 0.3
AS $$
  SELECT p.user_id, p_q <<-> p.display_name
    FROM profiles p
   WHERE p_q <<% p.display_name
   ORDER BY p_q <<-> p.display_name, p.user_id
   LIMIT p_limit
$$;

-- ─── The user list's filters ──────────────────────────────────────────────
-- GET /v1/admin/users?filter=. Small partial indexes: only rows in these
-- states are in them.
CREATE INDEX IF NOT EXISTS users_attention_idx ON users (status, id) WHERE status IN (2, 5, 6);
CREATE INDEX IF NOT EXISTS users_shadowbanned_idx ON users (id) WHERE is_shadowbanned;
CREATE INDEX IF NOT EXISTS users_test_idx ON users (id) WHERE (flags & 1) <> 0;

-- ─── Reasons ──────────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN text_reject_reason smallint;
ALTER TABLE profiles ADD CONSTRAINT profiles_text_reject_reason_check CHECK (text_reject_reason BETWEEN 1 AND 30) NOT VALID;
COMMENT ON COLUMN profiles.text_reject_reason IS
  '1 contact details or links, 2 offensive or hateful language, 3 sexual content, 4 advertising or selling, 5 pretending to be someone else, 6 other. Read only while text_state = 3 (an edit that changes the state leaves the old code unread). Shown to the person as the text text.reject.<code>.';
-- The reason of an admin's rename (PATCH /v1/admin/users/{id}/profile), as
-- the codes of text_reject_reason: shown to the person with their name until
-- they choose another one (writeProfile clears it).
ALTER TABLE profiles ADD COLUMN name_reject_reason smallint;
ALTER TABLE profiles ADD CONSTRAINT profiles_name_reject_reason_check CHECK (name_reject_reason BETWEEN 1 AND 30) NOT VALID;
COMMENT ON COLUMN profiles.name_reject_reason IS
  'The codes of text_reject_reason: why an admin replaced the display name; NULL once the person sets a name themselves.';
ALTER TABLE profile_prompts ADD COLUMN reject_reason smallint;
ALTER TABLE profile_prompts ADD CONSTRAINT profile_prompts_reject_reason_check CHECK (reject_reason BETWEEN 1 AND 30) NOT VALID;
COMMENT ON COLUMN profile_prompts.reject_reason IS 'The codes of profiles.text_reject_reason, set while status = 3.';

COMMENT ON COLUMN moderation_actions.reason_code IS
  '1 fake profile, 2 harassment, 3 inappropriate content, 4 scam or fraud, 5 under 18, 6 threats or violence, 7 spam, 8 child safety, 9 hate speech, 10 ban evasion, 99 other. A lift (kind 5) copies the code of the action it lifts; a photo or text rejection (kinds 6, 7) carries its own code (photos.reject_reason, profiles.text_reject_reason); kinds 9 and 10 use 99.';

COMMENT ON COLUMN photos.reject_reason IS
  '1 no face visible, 2 nudity or sexual content, 3 violence, 4 text or contact details, 5 someone else, 6 blurry or too small, 7 a minor in the photo, 8 unreadable file, 9 other. Shown to the uploader as the text photo.reject.<code>; the worker sets 6 and 8.';

-- ─── account_view ─────────────────────────────────────────────────────────
-- As in 0025, with the rejected text's reason: `textRejectReason` in the
-- profile object (only while text_state = 3), `nameRejectReason` (the reason
-- of an admin's rename, while the name is the admin's) and `rejectReason` in each
-- prompt (only while its status = 3). jsonb_strip_nulls is recursive, so the
-- absent codes leave no keys.
CREATE OR REPLACE FUNCTION account_view(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
AS $$
  WITH cfg AS (
    SELECT (SELECT value FROM app_config WHERE key = 'legal.versions') AS legal,
           coalesce((SELECT value FROM app_config WHERE key = 'retention.deleted_account_days')::text::integer, 30) AS grace_days
  ),
  accepted AS (
    SELECT c.kind, max(c.version) AS version
      FROM user_consents c
     WHERE c.user_id = p_user AND c.withdrawn_at IS NULL
     GROUP BY c.kind
  )
  SELECT CASE
    WHEN u.status = 8 THEN jsonb_build_object('status', u.status)
    WHEN u.status = 7 THEN jsonb_build_object(
      'status', u.status,
      'deletedAtMs', floor(extract(epoch FROM u.deleted_at) * 1000)::bigint,
      'purgeAtMs', floor(extract(epoch FROM u.deleted_at + make_interval(days => cfg.grace_days)) * 1000)::bigint)
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'status', u.status,
      'onboardingStep', u.onboarding_step,
      'flags', u.flags,
      'locale', u.locale,
      'country', u.country,
      'birthDate', u.birth_date,
      'gender', u.gender,
      'verified', u.is_verified,
      'notifyFlags', u.notify_flags,
      'profile', (
        SELECT jsonb_build_object(
                 'v', p.version,
                 'name', p.display_name,
                 'about', p.about,
                 'job', p.job_title,
                 'intention', p.intention,
                 'textState', p.text_state,
                 'textRejectReason', CASE WHEN p.text_state = 3 THEN p.text_reject_reason END,
                 'nameRejectReason', p.name_reject_reason,
                 'completeness', p.completeness,
                 'modeMatch', p.mode_match,
                 'modeSocial', p.mode_social,
                 'incognito', p.incognito,
                 'hideAge', p.hide_age,
                 'hideDistance', p.hide_distance,
                 'showOnline', p.show_online,
                 'acceptCalls', p.accept_calls,
                 'uiTemplate', p.ui_template)
          FROM profiles p WHERE p.user_id = u.id),
      'photos', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', ph.id::text, 'position', ph.position, 'status', ph.status,
                 'rejectReason', ph.reject_reason, 'w', ph.width, 'h', ph.height,
                 'blurhash', ph.blurhash, 'blobVer', ph.blob_ver)
               ORDER BY ph.position)
          FROM photos ph WHERE ph.user_id = u.id), '[]'::jsonb),
      'prompts', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'position', pp.position, 'promptId', pp.prompt_id, 'answer', pp.answer,
                 'audioMs', pp.audio_ms, 'status', pp.status,
                 'rejectReason', CASE WHEN pp.status = 3 THEN pp.reject_reason END)
               ORDER BY pp.position)
          FROM profile_prompts pp WHERE pp.user_id = u.id), '[]'::jsonb),
      'fields', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'fieldId', v.field_id, 'option', v.opt, 'options', v.opts, 'number', v.num, 'text', v.txt)
               ORDER BY v.field_id)
          FROM profile_field_values v WHERE v.user_id = u.id), '[]'::jsonb),
      'preferences', (
        SELECT jsonb_build_object(
                 'interestedIn', pr.interested_in, 'ageMin', pr.age_min, 'ageMax', pr.age_max,
                 'maxDistanceKm', pr.max_distance_km, 'intents', pr.intents, 'flags', pr.flags,
                 'filters', pr.filters)
          FROM preferences pr WHERE pr.user_id = u.id),
      'location', (
        SELECT jsonb_build_object(
                 'cityId', l.home_city_id, 'country', l.country, 'source', l.source,
                 'travel', CASE WHEN l.travel_until > now() THEN jsonb_build_object(
                             'cityId', l.travel_city_id, 'country', l.travel_country,
                             'untilMs', floor(extract(epoch FROM l.travel_until) * 1000)::bigint) END)
          FROM user_locations l WHERE l.user_id = u.id),
      'moderation', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', m.id::text, 'kind', m.kind, 'reasonText', m.reason_text,
                 'startsAtMs', floor(extract(epoch FROM m.starts_at) * 1000)::bigint,
                 'endsAtMs', floor(extract(epoch FROM m.ends_at) * 1000)::bigint,
                 'appeal', a.appeal)
               ORDER BY m.id DESC)
          FROM moderation_actions m
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object('id', ap.id::text, 'status', ap.status, 'decisionText', ap.decision_text) AS appeal
              FROM appeals ap WHERE ap.action_id = m.id
             ORDER BY ap.id DESC LIMIT 1) a ON true
         WHERE m.user_id = u.id
           AND m.kind IN (2, 3)
           AND m.revoked_at IS NULL
           AND m.starts_at <= now()
           AND (m.ends_at IS NULL OR m.ends_at > now())), '[]'::jsonb),
      'consents', coalesce((SELECT jsonb_object_agg(a.kind::text, a.version) FROM accepted a), '{}'::jsonb),
      'consentsDue', coalesce((
        SELECT jsonb_agg(k.kind ORDER BY k.kind)
          FROM (VALUES (1, 'terms'), (2, 'privacy'), (3, 'guidelines')) AS k(kind, name)
          LEFT JOIN accepted a ON a.kind = k.kind
         WHERE (cfg.legal ->> k.name)::integer > coalesce(a.version, 0)), '[]'::jsonb)))
  END
    FROM users u, cfg
   WHERE u.id = p_user
$$;

COMMENT ON FUNCTION account_view(bigint) IS
  'The own-account view behind GET /v1/me on a cache miss: one statement, codes and epoch-ms times, ids as text. Never another person''s data, a cell, a coordinate, the phone or the shadowban flag.';

-- ─── profile_text_decide ──────────────────────────────────────────────────
-- An admin's decision on a person's texts (the text queue and the user page),
-- in one statement:
--   p_reject_profile    rejects about and job title (text_state 3);
--   p_reject_prompts    rejects the prompt answers at these positions;
--   everything else that waits (state 1) is approved. An approve also moves
--   a profile made with a name only (state 1, no text) to 2. Both NULL (a
--   rejection that names no part): every part that waits is rejected.
-- The caller's version must be the profile's (profiles.version): anything the
-- card carries bumps it, so a decision on texts the admin did not see is
-- refused ('stale'). A rejection writes a kind-7 record with the reason's
-- code. Returns {outcome: 'decided', userId, locale, before, after,
-- version, actionId} or {outcome: 'missing' | 'stale' | 'invalid_part' |
-- 'unchanged', ...}; before and after hold states and codes, never texts.
CREATE FUNCTION profile_text_decide(
  p_user           bigint,
  p_version        integer,
  p_admin          integer,
  p_reject_profile boolean,
  p_reject_prompts smallint[],
  p_reason         smallint,
  p_action_id      bigint,
  p_reason_text    text
) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_version  integer;
  v_state    smallint;
  v_about    text;
  v_job      text;
  v_locale   text;
  v_profile  boolean := coalesce(p_reject_profile, false);
  v_prompts  smallint[] := coalesce(p_reject_prompts, '{}'::smallint[]);
  v_bad      smallint[];
  v_before   jsonb;
  v_after    jsonb;
  v_parts    text[] := '{}';
  v_action   bigint;
BEGIN
  SELECT p.version, p.text_state, p.about, p.job_title, u.locale
    INTO v_version, v_state, v_about, v_job, v_locale
    FROM profiles p JOIN users u ON u.id = p.user_id
   WHERE p.user_id = p_user AND u.status <> 8
     FOR UPDATE OF p;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  IF v_version <> p_version THEN
    RETURN jsonb_build_object('outcome', 'stale', 'version', v_version);
  END IF;
  IF p_reject_profile IS NULL AND p_reject_prompts IS NULL THEN
    v_profile := v_state = 1 AND (v_about IS NOT NULL OR v_job IS NOT NULL);
    v_prompts := ARRAY(SELECT pp.position FROM profile_prompts pp
                        WHERE pp.user_id = p_user AND pp.status = 1 AND pp.answer IS NOT NULL ORDER BY pp.position);
  END IF;
  IF (v_profile OR cardinality(v_prompts) > 0) AND p_reason IS NULL THEN
    RAISE EXCEPTION 'profile_text_decide: a rejection needs a reason' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_profile AND v_about IS NULL AND v_job IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_part', 'part', 'profile');
  END IF;
  SELECT coalesce(array_agg(DISTINCT x.pos ORDER BY x.pos), '{}'::smallint[]) INTO v_bad
    FROM unnest(v_prompts) AS x(pos)
   WHERE NOT EXISTS (SELECT 1 FROM profile_prompts pp
                      WHERE pp.user_id = p_user AND pp.position = x.pos AND pp.answer IS NOT NULL);
  IF cardinality(v_bad) > 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_part', 'part', 'prompts', 'positions', to_jsonb(v_bad));
  END IF;

  SELECT jsonb_build_object(
           'textState', p.text_state,
           'textRejectReason', CASE WHEN p.text_state = 3 THEN p.text_reject_reason END,
           'prompts', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                         'position', pp.position, 'status', pp.status,
                                         'rejectReason', CASE WHEN pp.status = 3 THEN pp.reject_reason END)
                                       ORDER BY pp.position)
                                  FROM profile_prompts pp WHERE pp.user_id = p_user), '[]'::jsonb))
    INTO v_before
    FROM profiles p WHERE p.user_id = p_user;

  -- Only rows whose state or code changes are written: a repeated decision
  -- writes nothing (no version bump, no discovery resync) and reads 'unchanged'.
  UPDATE profiles
     SET text_state = CASE WHEN v_profile THEN 3 WHEN text_state = 1 THEN 2 ELSE text_state END,
         text_reject_reason = CASE WHEN v_profile THEN p_reason ELSE text_reject_reason END
   WHERE user_id = p_user AND (text_state = 1 OR v_profile)
     AND (text_state, text_reject_reason) IS DISTINCT FROM
         (CASE WHEN v_profile THEN 3 WHEN text_state = 1 THEN 2 ELSE text_state END,
          CASE WHEN v_profile THEN p_reason ELSE text_reject_reason END);

  UPDATE profile_prompts
     SET status = CASE WHEN position = ANY (v_prompts) THEN 3 ELSE 2 END,
         reject_reason = CASE WHEN position = ANY (v_prompts) THEN p_reason END
   WHERE user_id = p_user AND (status = 1 OR position = ANY (v_prompts))
     AND (status, reject_reason) IS DISTINCT FROM
         (CASE WHEN position = ANY (v_prompts) THEN 3 ELSE 2 END::smallint,
          CASE WHEN position = ANY (v_prompts) THEN p_reason END);

  SELECT jsonb_build_object(
           'textState', p.text_state,
           'textRejectReason', CASE WHEN p.text_state = 3 THEN p.text_reject_reason END,
           'prompts', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                         'position', pp.position, 'status', pp.status,
                                         'rejectReason', CASE WHEN pp.status = 3 THEN pp.reject_reason END)
                                       ORDER BY pp.position)
                                  FROM profile_prompts pp WHERE pp.user_id = p_user), '[]'::jsonb)),
         p.version
    INTO v_after, v_version
    FROM profiles p WHERE p.user_id = p_user;

  IF v_after = v_before THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'version', v_version, 'locale', v_locale);
  END IF;

  IF v_profile OR cardinality(v_prompts) > 0 THEN
    IF v_profile THEN v_parts := v_parts || 'about/job'::text; END IF;
    SELECT v_parts || coalesce(array_agg('prompt ' || (x.pos + 1) ORDER BY x.pos), '{}'::text[]) INTO v_parts
      FROM (SELECT DISTINCT unnest(v_prompts) AS pos) x;
    INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text, note)
    VALUES (p_action_id, p_user, p_admin, 7, p_reason, p_reason_text, array_to_string(v_parts, ', '));
    v_action := p_action_id;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'decided',
    'userId', p_user::text,
    'locale', v_locale,
    'before', jsonb_strip_nulls(v_before),
    'after', jsonb_strip_nulls(v_after),
    'version', v_version,
    'rejected', jsonb_build_object('profile', v_profile, 'prompts', to_jsonb(v_prompts)),
    'actionId', v_action::text);
END
$$;

REVOKE ALL ON FUNCTION profile_text_decide(bigint, integer, integer, boolean, smallint[], smallint, bigint, text) FROM PUBLIC;

-- ─── The panel's views of a person ────────────────────────────────────────
-- Codes stay codes, times are epoch ms, ids are text; the API maps them to
-- the wire (names, URLs). A person other than the row's subject is named by
-- id only (the API turns it into a public id).
--
-- admin_user_ref and admin_user_summary take the users row (the lists pass
-- the row they scanned); the main photo is the first approved one
-- (photos_user_position_key).
CREATE FUNCTION admin_user_ref(u users) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  RETURN jsonb_build_object(
    'id', u.id::text,
    'status', u.status,
    'name', (SELECT p.display_name FROM profiles p WHERE p.user_id = u.id),
    'photo', (SELECT jsonb_build_object('id', ph.id::text, 'blobVer', ph.blob_ver)
                FROM photos ph WHERE ph.user_id = u.id AND ph.status = 3
               ORDER BY ph.position LIMIT 1));

CREATE FUNCTION admin_user_summary(u users) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  RETURN admin_user_ref(u) || jsonb_build_object(
    'shadowbanned', u.is_shadowbanned,
    'test', (u.flags & 1) <> 0,
    'verified', u.is_verified,
    'country', u.country,
    'createdAtMs', floor(extract(epoch FROM id_time(u.id)) * 1000)::bigint,
    'lastActiveOn', u.last_active_on);

-- A moderation record as the panel shows it: every kind, the admins by id
-- and name, the newest appeal (appeals_user_idx), and whether it stands now.
CREATE FUNCTION admin_action_json(m moderation_actions) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  RETURN jsonb_build_object(
    'id', m.id::text,
    'kind', m.kind,
    'reasonCode', m.reason_code,
    'reasonText', m.reason_text,
    'note', m.note,
    'startsAtMs', floor(extract(epoch FROM m.starts_at) * 1000)::bigint,
    'endsAtMs', floor(extract(epoch FROM m.ends_at) * 1000)::bigint,
    'revokedAtMs', floor(extract(epoch FROM m.revoked_at) * 1000)::bigint,
    'admin', (SELECT jsonb_build_object('id', a.id::text, 'displayName', a.display_name) FROM admin_users a WHERE a.id = m.admin_id),
    'revokedBy', (SELECT jsonb_build_object('id', a.id::text, 'displayName', a.display_name) FROM admin_users a WHERE a.id = m.revoked_by),
    'reportId', m.report_id::text,
    'standing', (m.kind BETWEEN 1 AND 4 AND m.revoked_at IS NULL AND m.starts_at <= now()
                 AND (m.ends_at IS NULL OR m.ends_at > now())),
    'appeal', (SELECT jsonb_build_object(
                        'id', ap.id::text, 'status', ap.status, 'body', ap.body, 'decisionText', ap.decision_text,
                        'decidedAtMs', floor(extract(epoch FROM ap.decided_at) * 1000)::bigint,
                        'decidedBy', (SELECT jsonb_build_object('id', a.id::text, 'displayName', a.display_name)
                                        FROM admin_users a WHERE a.id = ap.decided_by))
                 FROM appeals ap WHERE ap.user_id = m.user_id AND ap.action_id = m.id
                ORDER BY ap.id DESC LIMIT 1));

-- The views below are VOLATILE on purpose: called in the statement that
-- wrote (after the write, `WITH w AS MATERIALIZED (SELECT <write>) SELECT
-- w.out, admin_user_view(...) FROM w`), each of their queries takes a fresh
-- snapshot and sees that write, so a write route answers the state after it
-- without a statement of its own.

-- The user page's header and profile; NULL for no account or a purged one.
CREATE FUNCTION admin_user_view(p_user bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT admin_user_summary(u) || jsonb_build_object(
             'locale', u.locale,
             'gender', u.gender,
             'birthDate', u.birth_date,
             'deletedAtMs', floor(extract(epoch FROM u.deleted_at) * 1000)::bigint,
             'purgeAtMs', floor(extract(epoch FROM account_purge_at(u.deleted_at)) * 1000)::bigint,
             'deletedVia', u.deleted_via,
             'restoreStatus', u.restore_status,
             'onboardingStep', u.onboarding_step,
             'phoneOnFile', EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id = u.id AND ai.provider = 1),
             'googleOnFile', EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id = u.id AND ai.provider = 2),
             'heldNow', legal_hold_active(u.id, NULL),
             'profile', (
               SELECT jsonb_build_object(
                        'name', p.display_name, 'about', p.about, 'job', p.job_title,
                        'textState', p.text_state,
                        'textRejectReason', CASE WHEN p.text_state = 3 THEN p.text_reject_reason END,
                        'intention', p.intention, 'completeness', p.completeness, 'version', p.version,
                        'prompts', coalesce((
                          SELECT jsonb_agg(jsonb_build_object(
                                   'position', pp.position, 'promptId', pp.prompt_id, 'answer', pp.answer, 'status', pp.status,
                                   'rejectReason', CASE WHEN pp.status = 3 THEN pp.reject_reason END)
                                 ORDER BY pp.position)
                            FROM profile_prompts pp WHERE pp.user_id = u.id), '[]'::jsonb))
                 FROM profiles p WHERE p.user_id = u.id),
             'standing', coalesce((
               SELECT jsonb_agg(admin_action_json(m) ORDER BY m.id DESC)
                 FROM moderation_actions m
                WHERE m.user_id = u.id AND m.kind BETWEEN 1 AND 4 AND m.revoked_at IS NULL
                  AND m.starts_at <= now() AND (m.ends_at IS NULL OR m.ends_at > now())), '[]'::jsonb),
             'openReports', cardinality(ARRAY(
               SELECT r.id FROM reports r WHERE r.target_id = u.id AND r.status IN (1, 2) LIMIT 21)))
      FROM users u
     WHERE u.id = p_user AND u.status <> 8);
END
$$;

-- One moderation record, fresh (the lift's answer).
CREATE FUNCTION admin_action_view(p_action bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (SELECT admin_action_json(m) FROM moderation_actions m WHERE m.id = p_action);
END
$$;

-- A person's texts as a decision sees them (the text decisions' answer and
-- the text queue); NULL without a profile or for a purged account.
CREATE FUNCTION admin_text_view(p_user bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
             'user', admin_user_ref(u),
             'version', p.version,
             'about', p.about,
             'job', p.job_title,
             'textState', p.text_state,
             'textRejectReason', CASE WHEN p.text_state = 3 THEN p.text_reject_reason END,
             'prompts', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'position', pp.position, 'promptId', pp.prompt_id, 'answer', pp.answer, 'status', pp.status,
                        'rejectReason', CASE WHEN pp.status = 3 THEN pp.reject_reason END)
                      ORDER BY pp.position)
                 FROM profile_prompts pp WHERE pp.user_id = u.id), '[]'::jsonb))
      FROM users u JOIN profiles p ON p.user_id = u.id
     WHERE u.id = p_user AND u.status <> 8);
END
$$;

REVOKE ALL ON FUNCTION admin_user_ref(users), admin_user_summary(users), admin_action_json(moderation_actions),
  admin_user_view(bigint), admin_action_view(bigint), admin_text_view(bigint), admin_name_search(text, integer) FROM PUBLIC;

-- ─── Grants ───────────────────────────────────────────────────────────────
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION
      profile_text_decide(bigint, integer, integer, boolean, smallint[], smallint, bigint, text),
      admin_user_ref(users), admin_user_summary(users), admin_action_json(moderation_actions),
      admin_user_view(bigint), admin_action_view(bigint), admin_text_view(bigint), admin_name_search(text, integer)
    TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (text_reject_reason) ON profiles TO app_ro;
    GRANT SELECT (reject_reason) ON profile_prompts TO app_ro;
  ELSE
    RAISE NOTICE 'role app_ro does not exist: grants skipped';
  END IF;
END
$grants$;

-- ─── The moderator role ───────────────────────────────────────────────────
-- Moderators warn, suspend, ban, shadowban, lift and sign people out (they
-- already hold appeals.*, which can lift a ban through an overturn). The
-- phone, deletion, rename, test accounts and the audit log stay with the
-- admin and owner roles.
INSERT INTO admin_role_permissions (role_id, permission) VALUES
  (3, 'users.warn'), (3, 'users.suspend'), (3, 'users.ban'), (3, 'users.shadowban'), (3, 'users.lift'),
  (3, 'users.revoke_sessions')
ON CONFLICT DO NOTHING;
