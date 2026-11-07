-- 0010 - The own-account view: notification switches on users, the
-- account_view() function behind GET /v1/me on a cache miss, and the
-- app_config keys of sign-in routing, OTP caps and unmatch retention.

-- ─── users.notify_flags ───────────────────────────────────────────────────
-- Which pushes a person gets. A constant default: adding the column rewrites
-- nothing (PostgreSQL 11+ stores the default in the catalog).
ALTER TABLE users
  ADD COLUMN notify_flags smallint NOT NULL DEFAULT 15 CHECK (notify_flags BETWEEN 0 AND 63);

COMMENT ON COLUMN users.notify_flags IS
  'Push switches, bits: 1 messages, 2 matches, 4 likes, 8 calls, 16 offers, 32 previews (message text and first names in notifications; off shows generic texts). Default 15. Campaign pushes also need the marketing_push consent.';

-- The analytics role reads the columns 0009 listed; a new column needs its own grant.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (notify_flags) ON users TO app_ro;
  END IF;
END
$grant$;

-- ─── account_view ─────────────────────────────────────────────────────────
-- Everything GET /v1/me shows about the account itself, in one statement.
-- The API caches the result (kv-cache `me:<uid>:<mev>`) and turns it into the
-- wire shape: it adds the public id, the billing reference, the store of the
-- session, the city names, signed photo URLs and the age, and maps the codes
-- to their names. So this returns codes, raw values and times in epoch
-- milliseconds (independent of the session's TimeZone), and every bigint id
-- as text (JSON numbers above 2^53 lose precision in JavaScript).
--
-- Never returned: the phone, cells, coordinates, the shadowban flag, the
-- moderation note, or anything of another person. `consents` holds the
-- newest accepted, not withdrawn, version of each consent kind;
-- `consentsDue` the legal kinds (1 terms, 2 privacy, 3 guidelines) whose
-- version in app_config legal.versions is newer than that. The API may
-- recompute consentsDue from `consents` with the legal.versions it holds in
-- memory, so a cached view follows a version raised after it was cached.
--
-- A deleted account (status 7) gets the minimal form {status, deletedAtMs,
-- purgeAtMs}; a purged one (8) {status}; an unknown id NULL.
CREATE FUNCTION account_view(p_user bigint) RETURNS jsonb
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
                 'acceptCalls', p.accept_calls)
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

-- ─── New settings ─────────────────────────────────────────────────────────
-- auth.sms_routing: providers per E.164 prefix (longest match wins), in order
-- of preference; numbers no route matches use `default`, and an empty
-- default refuses them (phone_not_allowed). auth.otp_caps: the OTP pumping
-- caps (resend wait, per number per day, per IP per hour, per install per
-- day, verify attempts per IP per hour, sends per prefix per hour), counted
-- in Valkey and failing closed. retention.unmatched_messages_days: an
-- unmatched conversation's messages, media and calls are purged this many
-- days after the unmatch (the matches row stays for good), so a report filed
-- right after an unmatch still has its evidence.
INSERT INTO app_config (key, value) VALUES
  ('retention.unmatched_messages_days', '7'),
  ('auth.sms_routing',
   '{"routes": [{"prefix": "+98", "providers": ["kavenegar", "smsir"]}], "default": ["telnyx"]}'),
  ('auth.otp_caps',
   '{"resend_seconds": 60, "phone_daily": 5, "ip_hourly": 10, "install_daily": 5, "verify_ip_hourly": 30, "prefix_hourly": {"+98": 5000, "+90": 1000, "default": 200}}')
ON CONFLICT (key) DO NOTHING;
