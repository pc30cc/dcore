-- 0005 - Interactions: blocks, matches (which are also the conversations),
-- likes, message requests, messages, reports and finished calls.
--
-- Load rules that shape this file:
--   * Passes are never stored here: they live in per-user Bloom filters in
--     Valkey.
--   * likes and messages are written by the write-behind worker in batches
--     (one multi-row INSERT ... ON CONFLICT DO NOTHING per batch). They carry
--     no foreign keys on purpose: every row would otherwise cost two PK probes
--     and a lock on the referenced rows, and the worker only ever inserts ids
--     the API already checked. Their primary keys include the partition key
--     (id), so a replayed batch is a no-op.
--   * Each of those two tables has exactly one index, its primary key, laid
--     out for the one query that reads it.
--   * A match row is the conversation: no separate conversations table.

-- ─── blocks ───────────────────────────────────────────────────────────────
-- One row per pair (lower id first), whoever blocked: a single probe answers
-- "is either side blocked?" for any pair. An unblock deletes the row; a pair
-- that had matched stays apart through its matches row, a pair that never
-- matched may meet again in the deck.
CREATE TABLE blocks (
  user_lo     bigint      NOT NULL REFERENCES users (id),
  user_hi     bigint      NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  blocked_by  smallint    NOT NULL CHECK (blocked_by BETWEEN 1 AND 3),
  PRIMARY KEY (user_lo, user_hi),
  CONSTRAINT blocks_ordered CHECK (user_lo < user_hi)
);

COMMENT ON TABLE blocks IS
  'blocked_by bitmask: 1 = user_lo blocked user_hi, 2 = user_hi blocked user_lo. Applies both ways everywhere (hidden_peers, can_see in 0006).';

CREATE INDEX blocks_hi_idx ON blocks (user_hi, user_lo);

-- ─── matches ──────────────────────────────────────────────────────────────
-- One row per pair, ever (UNIQUE): after an unmatch the two never meet again,
-- so the same row also excludes them from each other's deck. The row is kept
-- for good: the unmatch purge deletes the conversation's messages, media and
-- calls, never the match; only the account purge deletes matches rows.
-- Hot columns: the two read cursors, flushed from Valkey at most once a
-- minute per conversation. They are not indexed, so the update is HOT
-- (fillfactor 80 leaves room on the page).
CREATE TABLE matches (
  id           bigint      PRIMARY KEY,
  user_lo      bigint      NOT NULL REFERENCES users (id),
  user_hi      bigint      NOT NULL REFERENCES users (id),
  lo_read_id   bigint      NOT NULL DEFAULT 0,
  hi_read_id   bigint      NOT NULL DEFAULT 0,
  ended_at     timestamptz,
  state        smallint    NOT NULL DEFAULT 1 CHECK (state BETWEEN 1 AND 5),
  source       smallint    NOT NULL CHECK (source BETWEEN 1 AND 4),
  ended_by     smallint    CHECK (ended_by BETWEEN 1 AND 3),
  flags        smallint    NOT NULL DEFAULT 0 CHECK (flags BETWEEN 0 AND 15),
  CONSTRAINT matches_pair_key UNIQUE (user_lo, user_hi),
  CONSTRAINT matches_ordered CHECK (user_lo < user_hi),
  CONSTRAINT matches_ended CHECK ((state = 1) = (ended_at IS NULL) AND (state = 1) = (ended_by IS NULL))
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

COMMENT ON TABLE matches IS
  'A match is the conversation. state: 1 active, 2 unmatched, 3 ended by a block, 4 ended by a ban or deletion, 5 ended by an admin. source: 1 mutual like, 2 super like, 3 message request accepted, 4 like on a photo or prompt. ended_by: 1 user_lo, 2 user_hi, 3 system. flags: 1 user_lo allows calls, 2 user_hi allows calls, 4 user_lo muted, 8 user_hi muted; a new match takes the call bits from both profiles.accept_calls, and turning accept_calls off clears that person''s bit in every active match. lo_read_id/hi_read_id: the newest message id each side has read. Created by the API (fast path) or by the wb:match stream worker, both with INSERT ... ON CONFLICT (user_lo, user_hi) DO NOTHING and the same pre-minted id. Creation time = id_time(id).';

-- A user's matches when the user is user_hi (user_lo is served by matches_pair_key).
CREATE INDEX matches_hi_idx ON matches (user_hi, user_lo);

-- ─── likes ────────────────────────────────────────────────────────────────
-- Likes and super likes (not passes). Kept only as long as they can still
-- turn into a match: "who liked me" and mutual detection look 30 days back
-- (app_config likes.window_days), so weekly partitions are dropped 37 days
-- after their last row. A match keeps what it needs from its like (source,
-- the comment becomes the first message), so nothing is lost by the drop.
-- PK (target_id, actor_id, id): "who liked user X" is a prefix scan, "did A
-- like B" a point lookup; the trailing id makes the key valid on a
-- partitioned table and makes a replayed batch a no-op. A like paid from the
-- wallet is inserted by the API in the wallet transaction (same id), so the
-- later batch insert of its stream entry does nothing.
CREATE TABLE likes (
  target_id  bigint   NOT NULL,
  actor_id   bigint   NOT NULL,
  id         bigint   NOT NULL,
  item_ref   bigint,
  kind       smallint NOT NULL CHECK (kind BETWEEN 1 AND 2),
  item_kind  smallint NOT NULL DEFAULT 0 CHECK (item_kind BETWEEN 0 AND 2),
  comment    text     CHECK (char_length(comment) BETWEEN 1 AND 300),
  PRIMARY KEY (target_id, actor_id, id),
  CONSTRAINT likes_not_self CHECK (actor_id <> target_id),
  CONSTRAINT likes_item CHECK ((item_kind = 0) = (item_ref IS NULL))
) PARTITION BY RANGE (id);

COMMENT ON TABLE likes IS
  'Write-behind (Valkey stream wb:like). kind: 1 like, 2 super like. item_kind: 0 the profile, 1 a photo (item_ref = photo id), 2 a prompt (item_ref = prompt_defs id). No FKs and no other index by design. Created at id_time(id).';

-- Rows are gone long before an anti-wraparound vacuum would be due, so the
-- partitions are not frozen early (contrast messages).
INSERT INTO partitioned_tables (parent, period, premake, retention, reloptions) VALUES
  ('likes', 'week', 4, interval '37 days',
   '{autovacuum_vacuum_insert_scale_factor=0.1,autovacuum_analyze_scale_factor=0.02}');

-- ─── message_requests ─────────────────────────────────────────────────────
-- A direct message to someone who has not matched (quota: plan feature
-- daily_dm). Accepting creates the match and copies the body as its first
-- message; the sender is never told about a decline. One pending request
-- per pair; a new one may follow once the last one expired or was withdrawn,
-- and after a decline only when that decision is older than app_config
-- requests.resend_after_days (the API checks the sender's rows). Decided
-- requests, body included, are deleted retention.message_requests_days after
-- the decision (daily sweep); the account purge deletes a person's requests
-- in both directions.
CREATE TABLE message_requests (
  id          bigint      PRIMARY KEY,
  from_id     bigint      NOT NULL REFERENCES users (id),
  to_id       bigint      NOT NULL REFERENCES users (id),
  decided_at  timestamptz,
  match_id    bigint      REFERENCES matches (id) ON DELETE SET NULL,
  status      smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 5),
  body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT message_requests_not_self CHECK (from_id <> to_id),
  CONSTRAINT message_requests_decided CHECK ((status = 1) = (decided_at IS NULL))
);

COMMENT ON TABLE message_requests IS
  'status: 1 pending, 2 accepted (match_id set), 3 declined, 4 expired (14 days), 5 withdrawn or the sender left.';

-- At most one pending request per pair.
CREATE UNIQUE INDEX message_requests_pending_key ON message_requests (from_id, to_id) WHERE status = 1;
-- The recipient's pending requests, newest first.
CREATE INDEX message_requests_inbox_idx ON message_requests (to_id, id) WHERE status = 1;
-- The sender's box, the resend check and the purge by sender.
CREATE INDEX message_requests_from_idx ON message_requests (from_id, id);
-- The purge by recipient (every status).
CREATE INDEX message_requests_to_idx ON message_requests (to_id);
-- The retention sweep of decided requests.
CREATE INDEX message_requests_decided_idx ON message_requests (decided_at) WHERE status <> 1;

-- ─── messages ─────────────────────────────────────────────────────────────
-- Append-only: reactions and "unsend" are messages of their own kind that
-- point at their target (ref_id), so delta sync never re-reads a row. Two
-- rare updates exist: a moderation hide sets flag 2 on the target, and the
-- body of an unsent message is cleared (flag 8, body NULL) by the worker
-- retention.unsent_body_hours after the unsend, which leaves report
-- evidence time to copy it. Pages stay full (fillfactor 100) and are frozen
-- while their month fills (autovacuum_freeze_min_age 0 on the partitions).
-- Seven columns, so a row with NULLs keeps the 24-byte header (the null
-- bitmap fits in the header's spare byte up to 8 columns).
-- PK (match_id, id) is the conversation's keyset index (both directions)
-- and the write-behind idempotency key; the recipient is the match's other
-- member, so it is not stored. Created at id_time(id).
CREATE TABLE messages (
  match_id   bigint   NOT NULL,
  id         bigint   NOT NULL,
  sender_id  bigint   NOT NULL,
  ref_id     bigint,
  kind       smallint NOT NULL CHECK (kind BETWEEN 1 AND 8),
  flags      smallint NOT NULL DEFAULT 0 CHECK (flags BETWEEN 0 AND 255),
  body       text     CHECK (char_length(body) <= 4000),
  PRIMARY KEY (match_id, id),
  CONSTRAINT messages_ref CHECK (kind NOT IN (2, 3, 5, 7, 8) OR ref_id IS NOT NULL),
  CONSTRAINT messages_body CHECK (kind NOT IN (1, 4, 6, 7) OR body IS NOT NULL OR (flags & 8) <> 0)
) PARTITION BY RANGE (id);

COMMENT ON TABLE messages IS
  'Write-behind (Valkey stream wb:msg); retention by dropping monthly partitions (partitioned_tables.retention). kind: 1 text (ref_id = replied message, optional), 2 image (ref_id = media id), 3 voice (ref_id = media id), 4 GIF (body = provider id), 5 call line (ref_id = calls.id, body = summary JSON), 6 like note (the like''s comment, first line after a match; ref_id = liked item), 7 reaction (ref_id = target message, body = emoji, empty = removed), 8 unsend (ref_id = target message). flags: 1 risky pattern (link, money, phone number), 2 hidden by moderation, 4 sent after an "are you sure?" warning, 8 body removed after an unsend.';

-- Retention of whole months: 12 by default. partitioned_tables.retention is
-- the only place that rule lives; the panel edits it there.
INSERT INTO partitioned_tables (parent, period, premake, retention, reloptions) VALUES
  ('messages', 'month', 3, interval '12 months',
   '{autovacuum_vacuum_insert_scale_factor=0.1,autovacuum_analyze_scale_factor=0.02,autovacuum_freeze_min_age=0,autovacuum_freeze_table_age=0}');

-- ─── reports ──────────────────────────────────────────────────────────────
-- Evidence is a snapshot (the reported messages, photo ids, profile text),
-- so admins read chat only through a report and a dropped message partition
-- never empties an open case. The row is written when the report is filed;
-- the chat part of the evidence is added by a job once the write-behind
-- stream has flushed past the report (evidence_at), so messages sent seconds
-- before it are included. One open report per reporter and target: a second
-- one adds to the open one's evidence. At resolution evidence_purge_at is
-- set (retention.report_evidence_days) and a daily sweep empties the
-- evidence then, unless a legal hold names the report.
CREATE TABLE reports (
  id                 bigint      PRIMARY KEY,
  target_id          bigint      NOT NULL REFERENCES users (id),
  reporter_id        bigint      REFERENCES users (id),
  match_id           bigint      REFERENCES matches (id) ON DELETE SET NULL,
  resolved_at        timestamptz,
  evidence_at        timestamptz,
  evidence_purge_at  timestamptz,
  assigned_to        integer     REFERENCES admin_users (id),
  resolved_by        integer     REFERENCES admin_users (id),
  context            smallint    NOT NULL CHECK (context BETWEEN 1 AND 5),
  reason             smallint    NOT NULL CHECK (reason BETWEEN 1 AND 99),
  status             smallint    NOT NULL DEFAULT 1 CHECK (status BETWEEN 1 AND 5),
  priority           smallint    NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  resolution         smallint    CHECK (resolution BETWEEN 1 AND 20),
  reporter_notified  boolean     NOT NULL DEFAULT false,
  details            text        CHECK (char_length(details) <= 2000),
  evidence           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT reports_not_self CHECK (reporter_id IS NULL OR reporter_id <> target_id),
  CONSTRAINT reports_resolved CHECK ((status IN (3, 4, 5)) = (resolved_at IS NOT NULL)),
  CONSTRAINT reports_evidence_purge CHECK (evidence_purge_at IS NULL OR resolved_at IS NOT NULL)
);

COMMENT ON TABLE reports IS
  'context: 1 profile, 2 chat, 3 photo, 4 call, 5 social (P1). reason: 1 fake, 2 harassment, 3 inappropriate content, 4 scam, 5 under 18, 6 threat or danger, 7 spam, 8 child safety (jumps the queue; may need a report_filings row), 99 other. status: 1 open, 2 in review, 3 actioned, 4 dismissed, 5 duplicate. reporter_id NULL = raised by an automatic detector. priority: computed from severity, the number of distinct reporters and history. evidence_at: when the chat evidence was complete (NULL while the job waits for the stream).';

-- The moderation queue (open and in review only).
CREATE INDEX reports_queue_idx ON reports (priority DESC, id) WHERE status IN (1, 2);
-- A user's page in the panel: reports received and filed.
CREATE INDEX reports_target_idx ON reports (target_id, id);
CREATE INDEX reports_reporter_idx ON reports (reporter_id, id) WHERE reporter_id IS NOT NULL;
-- One open report per reporter and target (INSERT ... ON CONFLICT adds evidence).
CREATE UNIQUE INDEX reports_one_open_per_pair ON reports (reporter_id, target_id)
  WHERE status IN (1, 2) AND reporter_id IS NOT NULL;
-- The evidence retention sweep.
CREATE INDEX reports_evidence_purge_idx ON reports (evidence_purge_at) WHERE evidence_purge_at IS NOT NULL;

-- ─── calls ────────────────────────────────────────────────────────────────
-- One row per finished call of a match. The live call (ringing, answer, room
-- presence) lives in Valkey only; this row is written once, when the call is
-- over, in the same transaction as its line in the chat (messages kind 5).
-- Never updated, so a finished call can never move back to a live state.
-- Placed at id_time(id). The unmatch purge deletes a match's calls with its
-- messages; the account purge deletes matches, and their calls cascade.
CREATE TABLE calls (
  id           bigint      PRIMARY KEY,
  match_id     bigint      NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  caller_id    bigint      NOT NULL REFERENCES users (id),
  callee_id    bigint      NOT NULL REFERENCES users (id),
  rang_at      timestamptz,
  answered_at  timestamptz,
  ended_at     timestamptz NOT NULL,
  duration_s   integer     NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  kind         smallint    NOT NULL CHECK (kind BETWEEN 1 AND 2),
  outcome      smallint    NOT NULL CHECK (outcome BETWEEN 1 AND 5),
  ended_by     smallint    NOT NULL CHECK (ended_by BETWEEN 1 AND 3),
  end_reason   smallint    NOT NULL CHECK (end_reason BETWEEN 1 AND 10),
  relayed      boolean     NOT NULL DEFAULT false,
  CONSTRAINT calls_two_people CHECK (caller_id <> callee_id),
  CONSTRAINT calls_order CHECK (ended_at >= id_time(id) - interval '5 seconds'
                                AND (answered_at IS NULL OR answered_at <= ended_at)),
  CONSTRAINT calls_answered CHECK ((outcome = 1) = (answered_at IS NOT NULL)),
  CONSTRAINT calls_duration CHECK (outcome = 1 OR duration_s = 0),
  CONSTRAINT calls_busy_is_missed CHECK (end_reason <> 10 OR outcome = 4)
);

COMMENT ON TABLE calls IS
  'Finished calls only. kind: 1 audio, 2 video. outcome: 1 completed, 2 declined, 3 cancelled, 4 missed, 5 failed. ended_by: 1 caller, 2 callee, 3 system. end_reason: 1 hangup, 2 declined, 3 cancelled, 4 ring timeout, 5 peer left, 6 room gone, 7 connect timeout, 8 room failed, 9 expired, 10 callee busy (internal: both people see a missed call, the caller is never told the callee was in another call). relayed: either side was handed the in-country TURN relay.';

-- A match's calls (report context, purge).
CREATE INDEX calls_match_idx ON calls (match_id, id);
