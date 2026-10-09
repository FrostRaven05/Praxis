CREATE TABLE trash_settings (
 owner_id TEXT PRIMARY KEY REFERENCES local_profile(owner_id),
 recovery_days INTEGER NOT NULL DEFAULT 30 CHECK(recovery_days BETWEEN 1 AND 3650),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
-- Recovery uses local trusted time, independently of a caller's event timestamp.
ALTER TABLE trash_batches ADD COLUMN recovery_started_at TEXT;
UPDATE trash_batches SET recovery_started_at=CASE
 WHEN julianday(deleted_at) IS NOT NULL AND julianday(deleted_at)<julianday('now') THEN deleted_at
 ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END;
-- Do not purge entities or deletion_tombstones when the user recovery window ends.
