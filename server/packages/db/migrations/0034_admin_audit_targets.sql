-- 0034 - Admin (W7e scaffold): the audit log's target kinds of the coming
-- admin areas (19 profile field, 20 prompt, 21 support reply, 22 support
-- tag), with room up to 63 so a later kind needs no new CHECK. No row is
-- written or changed.
--
-- The CHECK is replaced on the partitioned parent, under the same name, in
-- one statement: the drop removes it from every partition (they inherit it)
-- and the add puts the new one on every partition, validated by a scan of
-- each while audit_log is locked. Partitions made later copy it
-- (partition_create: LIKE ... INCLUDING CONSTRAINTS, then ATTACH).
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_target_type_check,
  ADD CONSTRAINT audit_log_target_type_check CHECK (target_type BETWEEN 0 AND 63);

COMMENT ON COLUMN audit_log.target_type IS
  '0 none, 1 user, 2 photo, 3 report, 4 appeal, 5 purchase, 6 config, 7 admin, 8 campaign, 9 ticket, 10 verification, 11 message (via a report), 12 feature flag, 13 i18n string, 14 product, 15 plan, 16 legal hold, 17 banned term, 18 device ban, 19 profile field, 20 prompt, 21 support reply, 22 support tag.';
