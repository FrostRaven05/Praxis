ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
ALTER TABLE tasks ADD COLUMN active_completion_id TEXT;
CREATE UNIQUE INDEX plan_owner_task_id ON daily_plan_items(owner_id,task_id,id);
CREATE TABLE execution_records (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 execution_date TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 revoked_at TEXT,
 FOREIGN KEY(owner_id, task_id) REFERENCES tasks(owner_id,id),
 FOREIGN KEY(owner_id,task_id,plan_id) REFERENCES daily_plan_items(owner_id,task_id,id)
);
CREATE UNIQUE INDEX one_active_completion ON execution_records(owner_id,task_id) WHERE revoked_at IS NULL;
ALTER TABLE domain_events RENAME TO old_domain_events;
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task_captured','task_completed','task_completion_undone')),
 occurred_at TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 FOREIGN KEY(owner_id,task_id) REFERENCES tasks(owner_id,id)
);
INSERT INTO domain_events SELECT * FROM old_domain_events;
DROP TABLE old_domain_events;
CREATE INDEX history_by_task ON domain_events(owner_id,task_id);
ALTER TABLE sync_outbox RENAME TO old_sync_outbox;
CREATE TABLE sync_outbox (
 operation_id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 device_id TEXT NOT NULL REFERENCES local_profile(device_id),
 protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
 kind TEXT NOT NULL CHECK(kind IN ('capture_task','complete_task','undo_completion')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM old_sync_outbox;
DROP TABLE old_sync_outbox;
