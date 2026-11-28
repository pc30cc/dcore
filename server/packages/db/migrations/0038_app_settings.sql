-- App settings: the new-profile review queue, sign-up per country and the
-- per-person rate limits.
--
-- profile_reviews: one row per account waiting in pending_review (status 2),
-- kept by triggers on users (made when the account enters 2, removed when it
-- moves to 1, 3 or 8), so the queue is an index range of this small table
-- instead of a walk of users. The panel's decisions write it: needs changes
-- and rejected carry the message the person reads (their language, written
-- by the admin); the person's resubmission after changes puts the row back
-- to waiting. Approving moves the account to 3 (the trigger removes the row;
-- discovery follows through users_discovery_sync). A suspension, ban or
-- deletion of a waiting account keeps its row (a lift or a restore brings it
-- back as it was) but takes it off the queue (`listed`), so banned waves are
-- never walked by the queue's index.
--
-- Nothing is granted to app_ro (0009 granted its columns one by one): the
-- message stays out of the analytics role, and the table with it.

CREATE TABLE IF NOT EXISTS profile_reviews (
  user_id        bigint      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  state          smallint    NOT NULL DEFAULT 1 CHECK (state IN (1, 2, 3)),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  rounds         smallint    NOT NULL DEFAULT 0 CHECK (rounds >= 0),
  reason_text    text        CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 1 AND 1000),
  decided_at     timestamptz,
  decided_by     integer     REFERENCES admin_users (id) ON DELETE SET NULL,
  last_decision  smallint    CHECK (last_decision IN (2, 3)),
  listed         boolean     NOT NULL DEFAULT true,
  CONSTRAINT profile_reviews_decided CHECK (state = 1 OR (reason_text IS NOT NULL AND decided_at IS NOT NULL AND last_decision = state)),
  CONSTRAINT profile_reviews_decision_kept CHECK ((decided_at IS NULL) = (last_decision IS NULL))
);

COMMENT ON TABLE profile_reviews IS
  'The review of a new profile while its account waits in pending_review (users.status 2), one row per account, kept by users_profile_review and users_profile_review_new. reason_text is the last decision''s message to the person, in their language; rounds counts decisions; listed is false while the account is suspended, banned or deleted (the row is kept for a lift or a restore).';
COMMENT ON COLUMN profile_reviews.state IS
  '1 waiting (first time, or sent again after changes), 2 needs_changes (the person edits and sends it again), 3 rejected.';
COMMENT ON COLUMN profile_reviews.last_decision IS
  'The state the last decision set (2 needs_changes or 3 rejected), kept when the person sends the profile again; null before the first decision.';

-- The queue per state, oldest account first; accounts taken off the queue are not in it.
CREATE INDEX IF NOT EXISTS profile_reviews_state_idx ON profile_reviews (state, user_id) WHERE listed;

CREATE OR REPLACE FUNCTION profile_reviews_follow() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 2 THEN
    -- Sign-up finished into the review, or a lift or restore back into it.
    INSERT INTO profile_reviews (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO UPDATE SET listed = true WHERE NOT profile_reviews.listed;
  ELSIF NEW.status IN (1, 3, 8) THEN
    DELETE FROM profile_reviews WHERE user_id = NEW.id;
  ELSE
    -- Suspended, banned, snoozed or deleted while waiting: kept, off the queue.
    UPDATE profile_reviews SET listed = false WHERE user_id = NEW.id AND listed;
  END IF;
  RETURN NULL;
END;
$$;

-- One probe of profile_reviews' primary key on the status changes that concern it, and on nothing else.
DROP TRIGGER IF EXISTS users_profile_review ON users;
CREATE TRIGGER users_profile_review
  AFTER UPDATE OF status ON users
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 2 OR NEW.status IN (1, 2, 3, 8)))
  EXECUTE FUNCTION profile_reviews_follow();
DROP TRIGGER IF EXISTS users_profile_review_new ON users;
CREATE TRIGGER users_profile_review_new
  AFTER INSERT ON users
  FOR EACH ROW WHEN (NEW.status = 2)
  EXECUTE FUNCTION profile_reviews_follow();

-- Accounts already waiting (a suspended or deleted one gets its row when it comes back).
INSERT INTO profile_reviews (user_id)
SELECT u.id FROM users u WHERE u.status = 2
ON CONFLICT (user_id) DO NOTHING;

-- ─── Settings ─────────────────────────────────────────────────────────────

INSERT INTO app_config (key, value) VALUES
  ('signup.countries', '{"default": {"allowed": true}, "countries": []}'),
  ('limits.rates', '{"swipes_per_hour": 600, "messages_per_minute": 60, "messages_per_conversation": 20, "reports_per_day": 10}')
ON CONFLICT (key) DO NOTHING;

-- ─── account_view ─────────────────────────────────────────────────────────
-- As in 0026, with `review` while the account waits (status 2): the state
-- code, the team's message (needs changes, rejected) and when it was decided.
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
         WHERE (cfg.legal ->> k.name)::integer > coalesce(a.version, 0)), '[]'::jsonb),
      'review', CASE WHEN u.status = 2 THEN (
        SELECT jsonb_build_object(
                 'state', r.state,
                 'message', CASE WHEN r.state IN (2, 3) THEN r.reason_text END,
                 'decidedAtMs', CASE WHEN r.state IN (2, 3) THEN floor(extract(epoch FROM r.decided_at) * 1000)::bigint END)
          FROM profile_reviews r WHERE r.user_id = u.id) END))
  END
    FROM users u, cfg
   WHERE u.id = p_user
$$;

COMMENT ON FUNCTION account_view(bigint) IS
  'The own-account view behind GET /v1/me on a cache miss: one statement, codes and epoch-ms times, ids as text. Never another person''s data, a cell, a coordinate, the phone or the shadowban flag.';
