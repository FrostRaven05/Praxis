ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('draft','active','paused','completed','archived'));
ALTER TABLE projects ADD COLUMN focused INTEGER NOT NULL DEFAULT 0 CHECK(focused IN(0,1));
ALTER TABLE projects ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0 CHECK(plan_version>=0);
ALTER TABLE tasks ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN cancelled_from TEXT;
ALTER TABLE tasks ADD COLUMN cancelled_reason TEXT;
ALTER TABLE daily_plan_items ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN(0,1));
CREATE TABLE project_schedules (
 owner_id TEXT NOT NULL,task_id TEXT NOT NULL,start_date TEXT,end_date TEXT,
 PRIMARY KEY(owner_id,task_id),FOREIGN KEY(owner_id,task_id) REFERENCES tasks(owner_id,id),
 CHECK((start_date IS NULL AND end_date IS NULL) OR (start_date IS NOT NULL AND end_date IS NOT NULL AND start_date<=end_date))
);
CREATE TABLE task_dependencies (
 owner_id TEXT NOT NULL,task_id TEXT NOT NULL,predecessor_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,task_id,predecessor_id),
 FOREIGN KEY(owner_id,task_id) REFERENCES tasks(owner_id,id),
 FOREIGN KEY(owner_id,predecessor_id) REFERENCES tasks(owner_id,id),
 CHECK(task_id<>predecessor_id)
);
CREATE TRIGGER dependency_guard BEFORE INSERT ON task_dependencies BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tasks a JOIN tasks b ON a.project_id=b.project_id AND a.owner_id=b.owner_id WHERE a.id=NEW.task_id AND b.id=NEW.predecessor_id AND a.owner_id=NEW.owner_id) THEN RAISE(ABORT,'Invalid dependency project') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE owner_id=NEW.owner_id AND parent_task_id IN(NEW.task_id,NEW.predecessor_id)) THEN RAISE(ABORT,'Dependency requires leaves') END;
 SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id) AS(SELECT NEW.predecessor_id UNION SELECT predecessor_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id WHERE d.owner_id=NEW.owner_id) SELECT 1 FROM ancestors WHERE id=NEW.task_id) THEN RAISE(ABORT,'Dependency cycle') END;
END;
CREATE TRIGGER leaf_parent_insert BEFORE INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM task_dependencies WHERE owner_id=NEW.owner_id AND (task_id=NEW.parent_task_id OR predecessor_id=NEW.parent_task_id)) THEN RAISE(ABORT,'Remove dependencies before splitting') END;
END;
CREATE TRIGGER leaf_parent_update BEFORE UPDATE OF parent_task_id ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM task_dependencies WHERE owner_id=NEW.owner_id AND (task_id=NEW.parent_task_id OR predecessor_id=NEW.parent_task_id)) THEN RAISE(ABORT,'Remove dependencies before splitting') END;
END;
CREATE TRIGGER task_plan_revision_insert AFTER INSERT ON tasks WHEN NEW.project_id IS NOT NULL BEGIN UPDATE projects SET plan_version=plan_version+1 WHERE id=NEW.project_id AND owner_id=NEW.owner_id; END;
CREATE TRIGGER task_plan_revision_update AFTER UPDATE ON tasks WHEN NEW.project_id IS NOT NULL BEGIN UPDATE projects SET plan_version=plan_version+1 WHERE id=NEW.project_id AND owner_id=NEW.owner_id; END;
ALTER TABLE project_events RENAME TO old_project_events;
CREATE TABLE project_events(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('project_saved','project_lifecycle','task_moved','schedule_changed')),occurred_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),FOREIGN KEY(owner_id,project_id) REFERENCES projects(owner_id,id));
INSERT INTO project_events SELECT * FROM old_project_events;
DROP TABLE old_project_events;
ALTER TABLE domain_events RENAME TO old_domain_events;
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task_captured','task_completed','task_completion_undone','task_edited','task_edit_undone','plan_updated','inbox_captured','task_scheduled','project_task_created','task_project_changed','task_details_saved','subtask_created','task_split','task_status_changed')),
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
 kind TEXT NOT NULL CHECK(kind IN ('capture_task','complete_task','undo_completion','edit_task','update_plan','set_capacity','capture_inbox','schedule_task','save_project','add_project_tasks','assign_project','save_task_details','add_subtasks','project_workspace')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL
);
INSERT INTO sync_outbox SELECT * FROM old_sync_outbox;
DROP TABLE old_sync_outbox;
