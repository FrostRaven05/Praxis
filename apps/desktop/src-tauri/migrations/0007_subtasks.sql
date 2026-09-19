ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN task_rank INTEGER NOT NULL DEFAULT 0 CHECK(task_rank>=0);
ALTER TABLE daily_plan_items ADD COLUMN is_summary INTEGER NOT NULL DEFAULT 0 CHECK(is_summary IN(0,1));
CREATE INDEX task_parent ON tasks(owner_id,parent_task_id);
CREATE TRIGGER parent_insert BEFORE INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.id=NEW.parent_task_id OR NOT EXISTS(SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.owner_id=NEW.owner_id AND p.project_id=NEW.project_id) THEN RAISE(ABORT,'Invalid parent reference') END;
END;
CREATE TRIGGER parent_update BEFORE UPDATE OF parent_task_id,owner_id,project_id ON tasks BEGIN
 SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND (NEW.id=NEW.parent_task_id OR NOT EXISTS(SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.owner_id=NEW.owner_id AND p.project_id=NEW.project_id)) THEN RAISE(ABORT,'Invalid parent reference') END;
 SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS(SELECT id,parent_task_id FROM tasks WHERE id=NEW.parent_task_id UNION SELECT t.id,t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'Parent cycle') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks c WHERE c.parent_task_id=OLD.id AND (c.owner_id<>NEW.owner_id OR c.project_id IS NOT NEW.project_id)) THEN RAISE(ABORT,'Child project mismatch') END;
END;
CREATE TRIGGER parent_delete BEFORE DELETE ON tasks WHEN EXISTS(SELECT 1 FROM tasks WHERE parent_task_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Parent still has children'); END;
ALTER TABLE domain_events RENAME TO old_domain_events;
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task_captured','task_completed','task_completion_undone','task_edited','task_edit_undone','plan_updated','inbox_captured','task_scheduled','project_task_created','task_project_changed','task_details_saved','subtask_created','task_split')),
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
 kind TEXT NOT NULL CHECK(kind IN ('capture_task','complete_task','undo_completion','edit_task','update_plan','set_capacity','capture_inbox','schedule_task','save_project','add_project_tasks','assign_project','save_task_details','add_subtasks')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM old_sync_outbox;
DROP TABLE old_sync_outbox;
