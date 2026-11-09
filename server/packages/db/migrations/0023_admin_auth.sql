-- 0023 — admin sign-in: refresh rotation, revocation reasons, TOTP replay.
--
-- admin_sessions gets what a rotated refresh token needs: the time of the
-- last rotation (the idle expiry counts from it), the hash it replaced (a
-- second use of a rotated token after the grace revokes the session) and
-- why a session ended. admin_users gets the last TOTP time step that signed
-- in, so the same code (or an older one) is refused afterwards.
--
-- The tables are tiny and only the panel writes them, so the new columns are
-- plain additions (no table rewrite: every default is a constant or NULL).
-- app_ro reads no admin_sessions column and none of the new admin_users
-- column: its grants were made per column in 0009.

ALTER TABLE admin_sessions
  ADD COLUMN refreshed_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoke_reason smallint    CHECK (revoke_reason BETWEEN 1 AND 7),
  ADD COLUMN prev_hash     bytea       CHECK (octet_length(prev_hash) = 32),
  ADD CONSTRAINT admin_sessions_revoked CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL);

COMMENT ON TABLE admin_sessions IS
  'Admin panel sessions (the refresh cookie). refresh_hash: SHA-256 of the current refresh token; prev_hash: the one it replaced; expires_at: the idle expiry (refreshed_at + the idle window, never past created_at + the absolute limit). revoke_reason: 1 logout, 2 logout_all, 3 reuse_detected, 4 owner, 5 disabled, 6 password_changed, 7 totp_reset. Creation time = id_time(id).';

ALTER TABLE admin_users
  ADD COLUMN totp_last_step bigint CHECK (totp_last_step >= 0);

COMMENT ON COLUMN admin_users.totp_last_step IS
  'The RFC 6238 time step (unix seconds / 30) of the last code that signed in; a code of this step or an earlier one is refused (replay). NULL until the first sign-in.';
