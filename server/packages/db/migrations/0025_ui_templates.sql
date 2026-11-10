-- 0025 — Visual templates: the person's choice and the panel's default.
--
-- profiles.ui_template holds the template a person chose (a code of the
-- shared table `uiTemplateChoice`; 0 follows the panel's default). It sits
-- with the other switches of PATCH /v1/me/settings, so that write stays one
-- statement; no trigger reads it (the card and discovery do not change).
-- The column has a constant default (no rewrite). Its CHECK is added NOT
-- VALID: every existing row holds the default, so there is nothing to scan
-- for, and every write from now on is checked.
--
-- account_view() returns it as `uiTemplate`: the function of 0010 with one
-- more key, nothing else changed.
--
-- app_config `ui.templates` is what the panel edits: the default template
-- and the ones people may choose (in this build's display order); the
-- default is always offered. Seeded with the template list of this build.
--
-- Every statement can run again without effect.

-- ─── profiles.ui_template ─────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ui_template smallint NOT NULL DEFAULT 0;

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_ui_template') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_ui_template CHECK (ui_template BETWEEN 0 AND 2) NOT VALID;
  END IF;
END
$check$;

COMMENT ON COLUMN profiles.ui_template IS
  'The visual template the person chose: 0 default (follows the default of app_config ui.templates), 1 neon, 2 white. A choice stays stored when the panel stops offering it; the app then shows the default.';

-- ─── account_view ─────────────────────────────────────────────────────────
-- As in 0010, with `uiTemplate` in the profile object.
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
                 'audioMs', pp.audio_ms, 'status', pp.status)
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

-- ─── The panel's setting ──────────────────────────────────────────────────
-- ui.templates: `default` is the template a person on "default" sees,
-- `offered` the templates people may choose (the default among them).
INSERT INTO app_config (key, value) VALUES
  ('ui.templates', '{"default": "neon", "offered": ["neon", "white"]}')
ON CONFLICT (key) DO NOTHING;

-- ─── Grants ───────────────────────────────────────────────────────────────
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (ui_template) ON profiles TO app_ro;
  ELSE
    RAISE NOTICE 'role app_ro does not exist: grants skipped';
  END IF;
END
$grants$;
