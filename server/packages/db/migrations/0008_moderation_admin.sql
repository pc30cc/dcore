-- 0008 - Trust and safety and the admin panel's records: audit log,
-- moderation actions, appeals, banned terms, device bans, legal holds and
-- filings with authorities, push campaigns, in-app support.

-- ─── audit_log ────────────────────────────────────────────────────────────
-- Every admin change and every view of sensitive data (a reported chat, a
-- verification selfie, a phone number) is one row. Append-only (the app
-- roles have no UPDATE or DELETE on it), monthly partitions kept 24 months.
CREATE TABLE audit_log (
  id           bigint   NOT NULL,
  target_id    bigint,
  session_id   bigint,
  admin_id     integer,
  target_type  smallint NOT NULL CHECK (target_type BETWEEN 0 AND 20),
  ip           inet,
  action       text     NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$' AND char_length(action) <= 64),
  detail       jsonb    CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);

COMMENT ON TABLE audit_log IS
  'target_type: 0 none, 1 user, 2 photo, 3 report, 4 appeal, 5 purchase, 6 config, 7 admin, 8 campaign, 9 ticket, 10 verification, 11 message (via a report), 12 feature flag, 13 i18n string, 14 product, 15 plan, 16 legal hold. action: area.verb (user.ban, report.view_chat, verification.view_selfie, user.view_phone, config.update, hold.create). detail: before/after of changed fields, never a secret. admin_id NULL = the system. Time = id_time(id). No FKs (append-only partitioned log).';

CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, id) WHERE target_id IS NOT NULL;
CREATE INDEX audit_log_admin_idx ON audit_log (admin_id, id) WHERE admin_id IS NOT NULL;

INSERT INTO partitioned_tables (parent, period, premake, retention, reloptions) VALUES
  ('audit_log', 'month', 3, interval '24 months',
   '{autovacuum_freeze_min_age=0,autovacuum_freeze_table_age=0}');

-- ─── moderation_actions ───────────────────────────────────────────────────
-- Every penalty carries the reason the user sees and can be appealed in the
-- app. users.status / is_shadowbanned hold the current effect; this table is
-- the history and the reason.
CREATE TABLE moderation_actions (
  id            bigint      PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users (id),
  report_id     bigint      REFERENCES reports (id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  revoked_at    timestamptz,
  admin_id      integer     REFERENCES admin_users (id),
  revoked_by    integer     REFERENCES admin_users (id),
  kind          smallint    NOT NULL CHECK (kind BETWEEN 1 AND 10),
  reason_code   smallint    NOT NULL CHECK (reason_code BETWEEN 1 AND 99),
  reason_text   text        NOT NULL CHECK (char_length(reason_text) BETWEEN 1 AND 1000),
  note          text        CHECK (char_length(note) <= 2000),
  CONSTRAINT moderation_actions_period CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT moderation_actions_suspension_ends CHECK (kind <> 2 OR ends_at IS NOT NULL)
);

COMMENT ON TABLE moderation_actions IS
  'kind: 1 warning, 2 suspension (ends_at required), 3 ban, 4 shadowban, 5 lift (unban/unsuspend), 6 photo rejected, 7 text rejected, 8 verification revoked by an admin (a lapse after a main-photo change is verifications.status 6), 9 device or phone ban, 10 sessions revoked. reason_text: shown to the user, in their language. admin_id NULL = an automatic rule. A shadowban is never shown to its subject.';

CREATE INDEX moderation_actions_user_idx ON moderation_actions (user_id, id);
-- Safety sweep for suspensions that end (a delayed job lifts each one on time).
CREATE INDEX moderation_actions_ending_idx ON moderation_actions (ends_at)
  WHERE kind = 2 AND revoked_at IS NULL;

CREATE TABLE appeals (
  id             bigint      PRIMARY KEY,
  user_id        bigint      NOT NULL REFERENCES users (id),
  action_id      bigint      NOT NULL REFERENCES moderation_actions (id),
  decided_at     timestamptz,
  decided_by     integer     REFERENCES admin_users (id),
  status         smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 3),
  body           text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  decision_text  text        CHECK (char_length(decision_text) <= 2000),
  CONSTRAINT appeals_decided CHECK ((status = 1) = (decided_at IS NULL))
);

COMMENT ON TABLE appeals IS 'status: 1 open, 2 upheld (the action stays), 3 overturned (the action is lifted).';

CREATE UNIQUE INDEX appeals_one_open_idx ON appeals (action_id) WHERE status = 1;
CREATE INDEX appeals_queue_idx ON appeals (id) WHERE status = 1;
CREATE INDEX appeals_user_idx ON appeals (user_id);

-- ─── banned_terms ─────────────────────────────────────────────────────────
-- Loaded into every API process and refreshed on `cfg:changed`; never read
-- per message.
CREATE TABLE banned_terms (
  id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  integer     REFERENCES admin_users (id),
  match_kind  smallint    NOT NULL CHECK (match_kind BETWEEN 1 AND 3),
  severity    smallint    NOT NULL CHECK (severity BETWEEN 1 AND 3),
  scope       smallint    NOT NULL CHECK (scope BETWEEN 1 AND 31),
  is_active   boolean     NOT NULL DEFAULT true,
  locale      text        CHECK (locale ~ '^[a-z]{2}$'),
  term        text        NOT NULL CHECK (char_length(term) BETWEEN 1 AND 200),
  CONSTRAINT banned_terms_key UNIQUE NULLS NOT DISTINCT (term, match_kind, locale)
);

COMMENT ON TABLE banned_terms IS
  'match_kind: 1 substring, 2 whole word, 3 regular expression (RE2 syntax, checked by the API). severity: 1 ask "are you sure?", 2 allow and flag for review, 3 refuse. scope bitmask: 1 name, 2 about, 4 prompts, 8 messages, 16 job title.';

-- ─── device_bans ──────────────────────────────────────────────────────────
-- Checked at sign-up and sign-in only (a primary-key probe), by keyed hash,
-- so a ban list leaks no phone numbers or device ids. A ban is renewed with
-- INSERT ... ON CONFLICT (kind, value_hash) DO UPDATE SET expires_at, ...,
-- so an expired ban never blocks a new one. An under-age refusal writes a
-- one-year ban of the phone hash (kind 2) and of the device key (kind 1).
CREATE TABLE device_bans (
  id          bigint      PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  created_by  integer     REFERENCES admin_users (id),
  action_id   bigint      REFERENCES moderation_actions (id) ON DELETE SET NULL,
  kind        smallint    NOT NULL CHECK (kind BETWEEN 1 AND 3),
  store       smallint    CHECK (store BETWEEN 1 AND 3),
  value_hash  bytea       NOT NULL CHECK (octet_length(value_hash) = 32),
  reason      text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT device_bans_key UNIQUE (kind, value_hash),
  CONSTRAINT device_bans_device_store CHECK ((kind = 1) = (store IS NOT NULL))
);

COMMENT ON TABLE device_bans IS
  'kind: 1 device key (devices.fingerprint_hash), 2 phone number (the same keyed hash as auth_identities.subject_hash for provider 1), 3 Google account (keyed hash of the Google sub). store: the build a device-key ban covers (kind 1 only): the device key differs per store build, so phone bans are what reaches across builds. Survives the purge of the account it came from.';

-- ─── legal_holds ──────────────────────────────────────────────────────────
-- Preservation of an account or a conversation for an open case (child
-- safety, a threat, a request from an authority). While a hold is active
-- the account purge, the unmatch purge, photo and media deletion and the
-- report-evidence sweep skip what it names (legal_hold_active()), and
-- partition_drop_expired() keeps every messages partition that still holds
-- rows of a held match until the hold's messages were copied into the
-- report evidence (evidence_copied_at). A hold is released, never deleted.
-- A match named by an active hold cannot be deleted (matches_hold_guard);
-- once the hold is released the account purge may delete the match, and
-- the hold's row stays as the record with match_id NULL.
CREATE TABLE legal_holds (
  id                  bigint      PRIMARY KEY,
  user_id             bigint      REFERENCES users (id),
  match_id            bigint      REFERENCES matches (id) ON DELETE SET NULL,
  report_id           bigint      REFERENCES reports (id),
  released_at         timestamptz,
  evidence_copied_at  timestamptz,
  created_by          integer     REFERENCES admin_users (id),
  released_by         integer     REFERENCES admin_users (id),
  kind                smallint    NOT NULL CHECK (kind BETWEEN 1 AND 3),
  authority_ref       text        CHECK (char_length(authority_ref) <= 200),
  CONSTRAINT legal_holds_target CHECK (user_id IS NOT NULL OR match_id IS NOT NULL OR released_at IS NOT NULL),
  CONSTRAINT legal_holds_released CHECK (released_by IS NULL OR released_at IS NOT NULL)
);

COMMENT ON TABLE legal_holds IS
  'kind: 1 child safety, 2 threat or violence, 3 request from an authority. user_id: the account is kept whole (no purge, no media deletion). match_id: the conversation is kept (messages, media, calls). Created at id_time(id); created_by NULL = an automatic rule (a child-safety report).';

CREATE INDEX legal_holds_user_idx ON legal_holds (user_id) WHERE released_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX legal_holds_match_idx ON legal_holds (match_id) WHERE released_at IS NULL AND match_id IS NOT NULL;
CREATE INDEX legal_holds_report_idx ON legal_holds (report_id) WHERE released_at IS NULL AND report_id IS NOT NULL;

-- The one check every purge and deletion path makes (two partial-index probes).
CREATE FUNCTION legal_hold_active(p_user bigint, p_match bigint) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN EXISTS (SELECT 1 FROM legal_holds h WHERE h.user_id = p_user AND h.released_at IS NULL)
      OR EXISTS (SELECT 1 FROM legal_holds h WHERE h.match_id = p_match AND h.released_at IS NULL);

-- The purge paths check legal_hold_active() first; this makes the database
-- refuse the delete of a held match as well (one partial-index probe per
-- deleted match, and matches are deleted only by the account purge).
CREATE FUNCTION matches_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM legal_holds h WHERE h.match_id = OLD.id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'match % is under an active legal hold', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER matches_hold_guard
  BEFORE DELETE ON matches
  FOR EACH ROW EXECUTE FUNCTION matches_hold_guard();

-- A report filed with an outside authority (a child-safety hotline, the
-- police): the regulatory record of what was sent, where and when.
CREATE TABLE report_filings (
  report_id     bigint      PRIMARY KEY REFERENCES reports (id),
  filed_at      timestamptz NOT NULL DEFAULT now(),
  filed_by      integer     REFERENCES admin_users (id),
  authority     smallint    NOT NULL CHECK (authority BETWEEN 1 AND 9),
  external_ref  text        CHECK (char_length(external_ref) <= 200)
);

COMMENT ON TABLE report_filings IS
  'authority: 1 NCMEC CyberTipline, 2 a national child-safety hotline, 3 police, 9 other. external_ref: the authority''s case or report number. The report''s evidence is kept while its legal hold lasts.';

-- ─── push_campaigns ───────────────────────────────────────────────────────
-- Per-recipient sends are not stored: the worker streams the segment, sends
-- through FCM and counts in Valkey; the totals land in `stats` at the end.
-- Test accounts (users.flags 1) are never in a segment.
CREATE TABLE push_campaigns (
  id            integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  scheduled_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_by    integer     REFERENCES admin_users (id),
  status        smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 6),
  daily_cap     smallint    CHECK (daily_cap BETWEEN 1 AND 10),
  local_time    boolean     NOT NULL DEFAULT true,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  segment       jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(segment) = 'object'),
  message       jsonb       NOT NULL CHECK (jsonb_typeof(message) = 'object'),
  stats         jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stats) = 'object')
);

COMMENT ON TABLE push_campaigns IS
  'status: 1 draft, 2 scheduled, 3 sending, 4 done, 5 cancelled, 6 failed. segment: {"countries", "stores", "genders", "plans", "inactive_days_min", ...}. message: {"<locale>": {"title", "body", "deeplink"}}. stats: {"targeted", "sent", "failed", "opened"}.';

-- ─── support ──────────────────────────────────────────────────────────────
CREATE TABLE support_tickets (
  id               bigint      PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  assigned_to      integer     REFERENCES admin_users (id),
  status           smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 3),
  category         smallint    NOT NULL DEFAULT 1 CHECK (category BETWEEN 1 AND 20),
  unread_by_user   boolean     NOT NULL DEFAULT false,
  unread_by_staff  boolean     NOT NULL DEFAULT true,
  subject          text        CHECK (char_length(subject) <= 200),
  CONSTRAINT support_tickets_closed CHECK ((status = 3) = (closed_at IS NOT NULL))
) WITH (fillfactor = 90);

COMMENT ON TABLE support_tickets IS
  'status: 1 open, 2 waiting for the user, 3 closed. category: 1 account, 2 billing, 3 safety, 4 bug, 5 deletion and data, ... (panel catalog).';

CREATE INDEX support_tickets_inbox_idx ON support_tickets (last_message_at DESC) WHERE status <> 3;
CREATE INDEX support_tickets_user_idx ON support_tickets (user_id, id);

CREATE TABLE support_messages (
  id            bigint   PRIMARY KEY,
  ticket_id     bigint   NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
  author_admin  integer  REFERENCES admin_users (id),
  body          text     NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  attachments   jsonb    CHECK (attachments IS NULL OR jsonb_typeof(attachments) = 'array')
);

COMMENT ON TABLE support_messages IS 'author_admin NULL = written by the ticket''s user. Time = id_time(id).';

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, id);
