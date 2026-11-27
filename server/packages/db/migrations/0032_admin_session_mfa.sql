-- 0032 — admin sessions record whether a second factor opened them.
--
-- With ADMIN_TOTP_REQUIRED=false the password alone opens an admin session.
-- Such a session is marked (mfa false), so it is visible, and so it ends once
-- TOTP is required again: the refresh that presents it ends it, and its
-- access tokens are refused. Every session that exists now was opened after
-- a TOTP code, which is what the default says. A constant default rewrites
-- nothing (the table is tiny and only the panel writes it); app_ro reads no
-- admin_sessions column (0009).

ALTER TABLE admin_sessions ADD COLUMN mfa boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN admin_sessions.mfa IS
  'A TOTP code opened the session; false: the password alone (ADMIN_TOTP_REQUIRED=false). While TOTP is required such a session cannot refresh: the refresh that presents it sets expires_at to now().';
