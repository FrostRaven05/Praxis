CREATE TABLE projects(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),name TEXT NOT NULL CHECK(length(trim(name))>0),outcome TEXT NOT NULL,target_date TEXT,priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2),version INTEGER NOT NULL CHECK(version>=0),created_at TEXT NOT NULL,UNIQUE(owner_id,id));
CREATE TABLE project_events(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='project_saved'),occurred_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),FOREIGN KEY(owner_id,project_id) REFERENCES projects(owner_id,id));
CREATE TRIGGER task_project_insert BEFORE INSERT ON tasks WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND owner_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'Invalid project reference'); END;
CREATE TRIGGER task_project_update BEFORE UPDATE OF project_id,owner_id ON tasks WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND owner_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'Invalid project reference'); END;
CREATE TRIGGER project_restrict_delete BEFORE DELETE ON projects WHEN EXISTS(SELECT 1 FROM tasks WHERE project_id=OLD.id AND owner_id=OLD.owner_id) BEGIN SELECT RAISE(ABORT,'Project still has tasks'); END;
CREATE INDEX tasks_by_project ON tasks(owner_id,project_id);
ALTER TABLE domain_events RENAME TO old_domain_events;
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task_captured','task_completed','task_completion_undone','task_edited','task_edit_undone','plan_updated','inbox_captured','task_scheduled','project_task_created','task_project_changed')),
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
 kind TEXT NOT NULL CHECK(kind IN ('capture_task','complete_task','undo_completion','edit_task','update_plan','set_capacity','capture_inbox','schedule_task','save_project','add_project_tasks','assign_project')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM old_sync_outbox;
DROP TABLE old_sync_outbox;
