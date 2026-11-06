-- 0002 - Accounts: users, consent records, sign-in identities, sessions,
-- devices, and the admin panel's own accounts and roles.
--
-- Codes are smallint with CHECK constraints; their meaning is in the table
-- comments and in packages/shared (one constant table per code). Column
-- order is widest first so rows carry no alignment padding.

-- ─── users ────────────────────────────────────────────────────────────────
-- One row per account, never deleted: an account that is purged keeps a
-- tombstone (status 8, every personal column NULL), because financial rows
-- (store_purchases, wallet_ledger) and moderation history must keep pointing
-- at an id. The creation time is id_time(id).
CREATE TABLE users (
  id               bigint      PRIMARY KEY,
  deleted_at       timestamptz,
  birth_date       date,
  last_active_on   date,
  status           smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 8),
  gender           smallint    CHECK (gender BETWEEN 1 AND 3),
  onboarding_step  smallint    NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 50),
  deleted_via      smallint    CHECK (deleted_via BETWEEN 1 AND 4),
  flags            smallint    NOT NULL DEFAULT 0 CHECK (flags BETWEEN 0 AND 255),
  is_verified      boolean     NOT NULL DEFAULT false,
  is_shadowbanned  boolean     NOT NULL DEFAULT false,
  country          char(2)     CHECK (country ~ '^[A-Z]{2}$'),
  locale           text        NOT NULL DEFAULT 'en' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT users_birth_date_sane CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01'),
  -- 18 or older at sign-up. The id carries the sign-up time, so the rule is
  -- a plain row CHECK (the API applies the same rule against today's date).
  CONSTRAINT users_adult CHECK (birth_date IS NULL
                                OR birth_date <= ((id_time(id) AT TIME ZONE 'UTC') - interval '18 years')::date),
  CONSTRAINT users_profile_after_onboarding CHECK (status IN (1, 7, 8) OR (birth_date IS NOT NULL AND gender IS NOT NULL)),
  CONSTRAINT users_deleted CHECK ((status IN (7, 8)) = (deleted_at IS NOT NULL)),
  CONSTRAINT users_tombstone CHECK (status <> 8 OR (birth_date IS NULL AND gender IS NULL AND country IS NULL))
) WITH (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

COMMENT ON TABLE users IS
  'Accounts. id = application id (creation time inside). status: 1 onboarding, 2 pending_review, 3 active, 4 snoozed, 5 suspended, 6 banned, 7 deleted (grace), 8 purged (tombstone; an under-age sign-up goes straight to 8). gender: 1 woman, 2 man, 3 non-binary. deleted_via: 1 app, 2 web page, 3 admin, 4 under-age refusal. flags: 1 test account (store review, QA): sees and is seen only by other test accounts, left out of stats, campaigns and quotas. last_active_on is written at most once a day per user, by the worker, from Valkey.';
COMMENT ON COLUMN users.birth_date IS
  'Set once in onboarding; checked 18+ against the sign-up time (users_adult) and against today by the API. Changed only by support.';

-- Purge sweep: accounts in their deletion grace (status 7). Tiny by construction.
CREATE INDEX users_deleted_idx ON users (deleted_at) WHERE status = 7;

-- ─── user_consents ────────────────────────────────────────────────────────
-- Which version of each legal text or consent a person accepted, when, and
-- in which store build. The versions currently required are app_config
-- `legal.versions`; the API compares them with the cached own-account view,
-- so the request path reads nothing here. Onboarding writes the rows in the
-- same transaction as the basics. A withdrawal sets withdrawn_at (the row
-- stays as proof); withdrawing kind 4 deletes the sensitive field values.
CREATE TABLE user_consents (
  user_id       bigint      NOT NULL REFERENCES users (id),
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  kind          smallint    NOT NULL CHECK (kind BETWEEN 1 AND 10),
  version       smallint    NOT NULL CHECK (version > 0),
  store         smallint    CHECK (store BETWEEN 1 AND 3),
  PRIMARY KEY (user_id, kind, version),
  CONSTRAINT user_consents_withdrawn CHECK (withdrawn_at IS NULL OR withdrawn_at >= accepted_at)
);

COMMENT ON TABLE user_consents IS
  'kind: 1 terms of service, 2 privacy policy, 3 community guidelines, 4 sensitive profile fields (special categories), 5 matching on gender preference, 6 marketing push, 7 selfie biometrics (face verification). version: the text version accepted. store: the build it was accepted in (as devices.store).';

-- ─── auth_identities ──────────────────────────────────────────────────────
-- How an account signs in. The subject (E.164 phone number, Google `sub`) is
-- stored only as a keyed hash (HMAC-SHA256 with a server pepper, key version
-- in hash_kid), which is what sign-in looks up; the phone number itself is
-- kept encrypted (AES-256-GCM, key id inside the ciphertext) for sending the
-- OTP and for an admin with the right permission. A database dump alone
-- yields neither numbers nor a way to test a guessed number.
CREATE TABLE auth_identities (
  id            bigint      PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users (id),
  last_used_at  timestamptz,
  provider      smallint    NOT NULL CHECK (provider BETWEEN 1 AND 3),
  hash_kid      smallint    NOT NULL DEFAULT 1 CHECK (hash_kid > 0),
  subject_hash  bytea       NOT NULL CHECK (octet_length(subject_hash) = 32),
  subject_enc   bytea       CHECK (subject_enc IS NULL OR octet_length(subject_enc) BETWEEN 29 AND 512),
  CONSTRAINT auth_identities_subject_key UNIQUE (provider, subject_hash)
);

COMMENT ON TABLE auth_identities IS
  'provider: 1 phone (OTP), 2 Google, 3 Apple (reserved for iOS). subject_hash = HMAC-SHA256(pepper[hash_kid], provider || '':'' || normalised subject). subject_enc = kid(1) || nonce(12) || AES-256-GCM ciphertext || tag(16) of the phone number (or the Google e-mail when kept). OTP codes never touch PostgreSQL (Valkey, 5 min).';

CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

-- ─── devices ──────────────────────────────────────────────────────────────
-- One row per app installation. Written when the push token, the app
-- version or the integrity verdict changes, never as a heartbeat.
CREATE TABLE devices (
  id               bigint      PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz,
  app_version      integer     NOT NULL CHECK (app_version > 0),
  platform         smallint    NOT NULL CHECK (platform BETWEEN 1 AND 2),
  store            smallint    NOT NULL CHECK (store BETWEEN 1 AND 3),
  integrity        smallint    NOT NULL DEFAULT 0 CHECK (integrity BETWEEN 0 AND 4),
  push_token_hash  bytea       CHECK (octet_length(push_token_hash) = 32),
  fingerprint_hash bytea       CHECK (octet_length(fingerprint_hash) = 32),
  locale           text        CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  push_token       text        CHECK (char_length(push_token) <= 4096),
  CONSTRAINT devices_push_token_pair CHECK ((push_token IS NULL) = (push_token_hash IS NULL))
) WITH (fillfactor = 90);

COMMENT ON TABLE devices IS
  'platform: 1 android, 2 ios (reserved). store: 1 google_play, 2 cafe_bazaar, 3 app_store (reserved). integrity: 0 unknown/unsupported (Bazaar), 1 basic, 2 device, 3 strong, 4 failed (Play Integrity verdict). push_token_hash = SHA-256 of the FCM token: a token seen under another account moves to the new one. fingerprint_hash: keyed hash of the device key; on Android 8+ ANDROID_ID depends on the signing key, so the same phone has a different device key in each store build.';

CREATE INDEX devices_user_idx ON devices (user_id);
CREATE UNIQUE INDEX devices_push_token_key ON devices (push_token_hash) WHERE push_token_hash IS NOT NULL;
-- Multi-account detection and device bans: who else used this device.
CREATE INDEX devices_fingerprint_idx ON devices (fingerprint_hash) WHERE fingerprint_hash IS NOT NULL;

-- ─── sessions ─────────────────────────────────────────────────────────────
-- A refresh-token family per signed-in device. The access token (JWT, 15 min)
-- is verified in memory; only a refresh touches this table: one
-- `UPDATE ... WHERE id = $sid AND refresh_hash = $old RETURNING ...`, a HOT
-- update (no indexed column changes). prev_hash detects reuse of a rotated
-- token (theft): a reuse after the grace window revokes the session.
CREATE TABLE sessions (
  id            bigint      PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users (id),
  device_id     bigint      REFERENCES devices (id),
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  generation    integer     NOT NULL DEFAULT 0 CHECK (generation >= 0),
  app_version   integer     CHECK (app_version > 0),
  store         smallint    NOT NULL CHECK (store BETWEEN 1 AND 3),
  revoke_reason smallint    CHECK (revoke_reason BETWEEN 1 AND 7),
  refresh_hash  bytea       NOT NULL CHECK (octet_length(refresh_hash) = 32),
  prev_hash     bytea       CHECK (octet_length(prev_hash) = 32),
  CONSTRAINT sessions_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);

COMMENT ON TABLE sessions IS
  'Refresh sessions. store: the build the session signed in from (in the play build confirmed by the Play Integrity verdict at sign-in). revoke_reason: 1 logout, 2 logout_all, 3 reuse_detected, 4 admin, 5 ban, 6 account_deleted, 7 idle_expired. Creation time = id_time(id). Revoked or expired rows are deleted after 30 days by a weekly job.';

-- "Sign out everywhere", bans, the admin's session list.
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ─── Admin panel accounts ─────────────────────────────────────────────────
-- Admins are a separate population with their own login (e-mail + password +
-- TOTP or passkey); users never sign in on the web.
CREATE TABLE admin_users (
  id               integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  locked_until     timestamptz,
  disabled_at      timestamptz,
  totp_enabled_at  timestamptz,
  created_by       integer     REFERENCES admin_users (id),
  failed_logins    smallint    NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  email            text        NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name     text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash    text        CHECK (password_hash LIKE '$argon2id$%'),
  totp_secret_enc  bytea,
  CONSTRAINT admin_users_totp CHECK ((totp_enabled_at IS NULL) OR (totp_secret_enc IS NOT NULL))
);

COMMENT ON TABLE admin_users IS
  'Admin panel accounts. Second factor is mandatory (TOTP or a passkey); totp_secret_enc is AES-256-GCM like every stored secret.';

CREATE TABLE admin_passkeys (
  id             integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id       integer     NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  sign_count     bigint      NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  credential_id  bytea       NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  public_key     bytea       NOT NULL,
  name           text        CHECK (char_length(name) <= 80)
);

CREATE INDEX admin_passkeys_admin_idx ON admin_passkeys (admin_id);

CREATE TABLE admin_sessions (
  id            bigint      PRIMARY KEY,
  admin_id      integer     NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  refresh_hash  bytea       NOT NULL CHECK (octet_length(refresh_hash) = 32),
  user_agent    text        CHECK (char_length(user_agent) <= 512)
) WITH (fillfactor = 80);

CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

CREATE TABLE admin_roles (
  id     smallint PRIMARY KEY,
  key    text     NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  names  jsonb    NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(names) = 'object')
);

-- Permissions are code-defined strings ('users.ban', 'reports.*', '*'); the
-- catalog lives in packages/shared, this table only assigns them to roles.
CREATE TABLE admin_role_permissions (
  role_id     smallint NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  permission  text     NOT NULL CHECK (permission ~ '^(\*|[a-z_]+\.(\*|[a-z_]+))$'),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE admin_user_roles (
  admin_id  integer  NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role_id   smallint NOT NULL REFERENCES admin_roles (id),
  PRIMARY KEY (admin_id, role_id)
);

-- The admin roles. Names are shown in the panel; the permission sets are
-- defaults the superadmin edits there.
INSERT INTO admin_roles (id, key, names) VALUES
  (1, 'superadmin', '{"en": "Super admin", "fa": "مدیر ارشد", "tr": "Süper yönetici"}'),
  (2, 'admin',      '{"en": "Admin", "fa": "مدیر", "tr": "Yönetici"}'),
  (3, 'moderator',  '{"en": "Moderator", "fa": "ناظر", "tr": "Moderatör"}'),
  (4, 'support',    '{"en": "Support", "fa": "پشتیبانی", "tr": "Destek"}'),
  (5, 'finance',    '{"en": "Finance", "fa": "مالی", "tr": "Finans"}'),
  (6, 'marketing',  '{"en": "Marketing", "fa": "بازاریابی", "tr": "Pazarlama"}'),
  (7, 'analyst',    '{"en": "Analyst (read only)", "fa": "تحلیل‌گر (فقط خواندن)", "tr": "Analist (salt okunur)"}');

INSERT INTO admin_role_permissions (role_id, permission) VALUES
  (1, '*'),
  (2, 'users.*'), (2, 'moderation.*'), (2, 'reports.*'), (2, 'appeals.*'), (2, 'content.*'),
  (2, 'billing.read'), (2, 'config.*'), (2, 'campaigns.*'), (2, 'support.*'), (2, 'dashboard.read'), (2, 'audit.read'),
  (3, 'users.read'), (3, 'moderation.*'), (3, 'reports.*'), (3, 'appeals.*'), (3, 'dashboard.read'),
  (4, 'users.read'), (4, 'support.*'), (4, 'dashboard.read'),
  (5, 'users.read'), (5, 'billing.*'), (5, 'dashboard.read'),
  (6, 'campaigns.*'), (6, 'content.read'), (6, 'dashboard.read'),
  (7, 'dashboard.read');
