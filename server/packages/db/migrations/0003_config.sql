-- 0003 - Run-time configuration edited in the admin panel: brands, app
-- settings, feature flags, app strings.
--
-- Every row here is read by the API once per process and cached in memory
-- (and in Valkey, kv-cache `cfg:*`); a save in the panel bumps the version
-- and publishes `cfg:changed`, so request paths never read these tables.

-- ─── brands ───────────────────────────────────────────────────────────────
-- The app has no name in code. A brand row carries the run-time
-- part of brands/<key>/brand.json: display names, colours, legal links,
-- support address, plan names. Exactly one brand is active. Row 0 is not a
-- brand: it holds the strings shared by every brand.
CREATE TABLE brands (
  id          smallint    PRIMARY KEY CHECK (id >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer     REFERENCES admin_users (id),
  is_active   boolean     NOT NULL DEFAULT false,
  key         text        NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_][a-z0-9_-]{0,31}$'),
  config      jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT brands_zero_is_shared CHECK (id <> 0 OR (key = 'shared' AND NOT is_active))
);

CREATE UNIQUE INDEX brands_one_active ON brands ((true)) WHERE is_active;

INSERT INTO brands (id, key, is_active, config) VALUES (0, 'shared', false, '{}');

-- ─── app_config ───────────────────────────────────────────────────────────
-- Typed by key in packages/shared (zod); the database only keeps the JSON.
CREATE TABLE app_config (
  key         text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer     REFERENCES admin_users (id),
  value       jsonb       NOT NULL
);

COMMENT ON TABLE app_config IS
  'Panel-editable settings (quotas live in plan_features). Cached in process memory; never read on a request path.';

-- deck.refill.idle_steps: the deck worker first asks for people active in
-- the last idle_steps[0] days and widens step by step up to max_idle_days
-- while fewer than fetch_limit come back, so a dense area never sorts its
-- whole pool. auth.review_accounts: [{"phone_hash", "otp_hash"}] of test
-- accounts (users.flags 1) that sign in with a fixed code; hashes only.
-- legal.versions: the text versions a person must have accepted
-- (user_consents); a higher version asks everyone again.
INSERT INTO app_config (key, value) VALUES
  ('app.maintenance',               '{"enabled": false, "message": {}}'),
  ('app.min_version',               '{"cafe_bazaar": {"required": 1, "recommended": 1}, "google_play": {"required": 1, "recommended": 1}}'),
  ('auth.otp',                      '{"length": 6, "ttl_seconds": 300, "max_attempts": 5}'),
  ('auth.access_token_ttl_seconds', '900'),
  ('auth.session_idle_days',        '90'),
  ('auth.review_accounts',          '[]'),
  ('onboarding.waitlist',           '{"enabled": false}'),
  ('legal.versions',                '{"terms": 1, "privacy": 1, "guidelines": 1}'),
  ('deck.weights',                  '{"dist": 1.0, "active": 1.0, "comp": 0.5, "recip": 1.0, "pref": 0.5, "new": 0.3, "verif": 0.3, "load": 0.5}'),
  ('deck.refill',                   '{"queue_size": 200, "refill_below": 30, "fetch_limit": 600, "max_idle_days": 45, "idle_steps": [3, 14]}'),
  ('deck.pass_return_days',         '30'),
  ('likes.window_days',             '30'),
  ('likes.bucket_cap',              '3000'),
  ('chat.max_body_chars',           '2000'),
  ('requests.resend_after_days',    '30'),
  ('retention.deleted_account_days','30'),
  ('retention.verification_media_days', '30'),
  ('retention.message_requests_days', '30'),
  ('retention.unsent_body_hours',   '24'),
  ('retention.report_evidence_days','365'),
  ('safety.child_safety_contact',   '{"name": null, "email": null}'),
  ('calls.enabled',                 '{"audio": true, "video": true}'),
  ('billing.cross_store_entitlements', 'false');

-- ─── feature_flags ────────────────────────────────────────────────────────
CREATE TABLE feature_flags (
  key          text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   integer     REFERENCES admin_users (id),
  rollout_pct  smallint    NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  is_enabled   boolean     NOT NULL DEFAULT false,
  rules        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(rules) = 'object')
);

COMMENT ON TABLE feature_flags IS
  'rules: {"countries": [...], "stores": [1, 2], "platforms": [1], "min_version": n, "plans": ["plus"]}. A user is in the rollout when hash(flag key, user id) mod 100 < rollout_pct; evaluated in the API, not in SQL.';

-- ─── i18n_strings ─────────────────────────────────────────────────────────
-- App and push texts the panel may override per brand and locale (brand 0 =
-- every brand). History of edits is the audit log (before/after).
CREATE TABLE i18n_strings (
  brand_id    smallint    NOT NULL DEFAULT 0 REFERENCES brands (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer     REFERENCES admin_users (id),
  locale      text        NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  key         text        NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9_.]{1,127}$'),
  value       text        NOT NULL CHECK (char_length(value) <= 4000),
  PRIMARY KEY (brand_id, locale, key)
);
