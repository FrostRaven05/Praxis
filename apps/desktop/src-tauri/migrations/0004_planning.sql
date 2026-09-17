ALTER TABLE daily_plan_items ADD COLUMN is_focus INTEGER NOT NULL DEFAULT 0 CHECK(is_focus IN (0,1));
ALTER TABLE daily_plan_items ADD COLUMN focus_rank INTEGER NOT NULL DEFAULT 0 CHECK(focus_rank>=0);
ALTER TABLE daily_plan_items ADD COLUMN estimated_minutes INTEGER CHECK(estimated_minutes BETWEEN 1 AND 1440);
CREATE TABLE day_preferences(owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),date TEXT NOT NULL,minutes INTEGER CHECK(minutes BETWEEN 0 AND 1440),version INTEGER NOT NULL,PRIMARY KEY(owner_id,date));
CREATE TABLE day_events(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),date TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='capacity_changed'),occurred_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
ALTER TABLE domain_events RENAME TO old_domain_events;
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task_captured','task_completed','task_completion_undone','task_edited','task_edit_undone','plan_updated','inbox_captured','task_scheduled')),
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
 kind TEXT NOT NULL CHECK(kind IN ('capture_task','complete_task','undo_completion','edit_task','update_plan','set_capacity','capture_inbox','schedule_task')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM old_sync_outbox;
DROP TABLE old_sync_outbox;
