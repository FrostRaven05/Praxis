CREATE TABLE captures (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), raw_text TEXT NOT NULL CHECK(length(trim(raw_text))>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processed')), version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, resolution_id TEXT, retained_outputs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE records (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), title TEXT NOT NULL, body TEXT NOT NULL,
 record_type TEXT NOT NULL CHECK(record_type IN('note','idea','question','evidence','decision','progress','review')),
 source_capture_id TEXT REFERENCES captures(id), version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 deleted_at TEXT, CHECK(length(trim(title))>0 OR length(trim(body))>0)
);
CREATE TABLE record_links (
 record_id TEXT NOT NULL REFERENCES records(id), target_type TEXT NOT NULL CHECK(target_type IN('project','task')), target_id TEXT NOT NULL,
 PRIMARY KEY(record_id,target_type,target_id)
);
CREATE TABLE resolutions (
 id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES captures(id), outputs TEXT NOT NULL CHECK(json_valid(outputs)),
 created_at TEXT NOT NULL, undone_at TEXT, kept INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE content_events (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), entity_id TEXT NOT NULL, kind TEXT NOT NULL,
 occurred_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE project_context (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), definition_of_done TEXT NOT NULL DEFAULT '', blocker_text TEXT NOT NULL DEFAULT '',
 review_date TEXT, next_action_task_id TEXT REFERENCES tasks(id), last_context TEXT NOT NULL DEFAULT '', restart_hint TEXT NOT NULL DEFAULT '',
 waiting_note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, next_action_cleared INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE tasks ADD COLUMN source_capture_id TEXT REFERENCES captures(id);
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
CREATE TRIGGER clear_next_action AFTER UPDATE OF status,project_id,deleted_at ON tasks
WHEN NEW.status NOT IN('todo','in_progress') OR NEW.project_id IS NOT OLD.project_id OR NEW.deleted_at IS NOT NULL
BEGIN
 UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE next_action_task_id=NEW.id;
END;
CREATE TRIGGER clear_summary_next AFTER INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL
BEGIN
 UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1 WHERE next_action_task_id=NEW.parent_task_id;
END;
CREATE TRIGGER prevent_deleted_edit BEFORE UPDATE ON tasks WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Deleted task'); END;
CREATE TRIGGER clear_dependency_next AFTER INSERT ON task_dependencies
WHEN EXISTS(SELECT 1 FROM tasks WHERE id=NEW.predecessor_id AND status<>'completed')
BEGIN UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1 WHERE next_action_task_id=NEW.task_id; END;
CREATE TRIGGER clear_unready_next AFTER UPDATE OF status ON tasks WHEN NEW.status<>'completed'
BEGIN UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1 WHERE next_action_task_id IN(SELECT task_id FROM task_dependencies WHERE predecessor_id=NEW.id); END;
CREATE TRIGGER clear_moved_parent_next AFTER UPDATE OF parent_task_id ON tasks WHEN NEW.parent_task_id IS NOT NULL
BEGIN UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1 WHERE next_action_task_id=NEW.parent_task_id; END;
ALTER TABLE sync_outbox RENAME TO content_old_outbox;
CREATE TABLE sync_outbox (
 operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), device_id TEXT NOT NULL REFERENCES local_profile(device_id),
 protocol_version INTEGER NOT NULL CHECK(protocol_version=1), kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM content_old_outbox;
DROP TABLE content_old_outbox;
