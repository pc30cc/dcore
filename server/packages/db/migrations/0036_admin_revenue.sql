-- 0036 — Admin (revenue): purchases per store, grants ended early, notes on admin wallet rows.
--
-- The tables are small before launch. On a large database build each index by
-- hand first with CREATE INDEX CONCURRENTLY under the same name: every CREATE
-- INDEX here says IF NOT EXISTS, so the file then runs without blocking. The
-- new CHECKs are NOT VALID (every existing row holds NULL in the new columns).
-- No row is written and no audit COMMENT changes (purchases are audit target
-- 5; grants and wallet rows target the person, 1).

-- ─── Purchases ────────────────────────────────────────────────────────────
-- GET /v1/admin/purchases?store=[&state=]: one store's purchases newest first (ids are time-ordered).
CREATE INDEX IF NOT EXISTS store_purchases_store_idx ON store_purchases (store, id);
CREATE INDEX IF NOT EXISTS store_purchases_store_state_idx ON store_purchases (store, state, id);
-- The purchase page's "replaced by": the purchase whose linked token is this one.
CREATE INDEX IF NOT EXISTS store_purchases_linked_idx ON store_purchases (store, linked_token_hash)
  WHERE linked_token_hash IS NOT NULL;

-- ─── Grants ───────────────────────────────────────────────────────────────
ALTER TABLE entitlement_grants ADD COLUMN IF NOT EXISTS revoked_by integer REFERENCES admin_users (id);
ALTER TABLE entitlement_grants ADD COLUMN IF NOT EXISTS revoke_reason text;
ALTER TABLE entitlement_grants DROP CONSTRAINT IF EXISTS entitlement_grants_revoke_reason;
ALTER TABLE entitlement_grants ADD CONSTRAINT entitlement_grants_revoke_reason
  CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500) NOT VALID;
COMMENT ON COLUMN entitlement_grants.revoked_by IS 'The admin who ended the grant early (revoked_at); NULL when nobody did.';
COMMENT ON COLUMN entitlement_grants.revoke_reason IS 'Why an admin ended the grant early; never shown to the person.';
-- A person's grants newest first (replaces the bare (user_id) index of 0007; subscription_recompute reads by user_id too).
CREATE INDEX IF NOT EXISTS entitlement_grants_user_id_idx ON entitlement_grants (user_id, id);
DROP INDEX IF EXISTS entitlement_grants_user_idx;
-- Grants not ended early, by their end: the "active" list (ends_at > now()), soonest end first; and the
-- worker's hourly sweep of grant ends.
CREATE INDEX IF NOT EXISTS entitlement_grants_open_idx ON entitlement_grants (ends_at, id) WHERE revoked_at IS NULL;
-- The hourly sweep of grant starts: a later start's store-0 plan is recomputed by a delayed job, queued again if lost.
CREATE INDEX IF NOT EXISTS entitlement_grants_open_start_idx ON entitlement_grants (starts_at) WHERE revoked_at IS NULL;

-- ─── Wallet ───────────────────────────────────────────────────────────────
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_note;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_note
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500) NOT VALID;
COMMENT ON COLUMN wallet_ledger.note IS 'An admin''s note on a gift (reason 4) or a correction (reason 8); never shown to the person.';
-- Every admin gift and correction, newest first (GET /v1/admin/wallet-adjustments).
CREATE INDEX IF NOT EXISTS wallet_ledger_admin_idx ON wallet_ledger (id) WHERE reason IN (4, 8);

-- No grant to app_ro: 0009 granted the analytics role its columns one by one,
-- so revoked_by, revoke_reason and note stay unreadable to it.
