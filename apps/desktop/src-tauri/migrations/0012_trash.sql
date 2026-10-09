ALTER TABLE projects ADD COLUMN deleted_at TEXT;
CREATE TABLE trash_batches(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), target_type TEXT NOT NULL, target_id TEXT NOT NULL, title TEXT NOT NULL, deleted_at TEXT NOT NULL, restored_at TEXT, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX trash_owner ON trash_batches(owner_id,restored_at);
-- Local recovery has no expiry in v0.1. Tombstones are separate, retained until
-- the future sync protocol proves every replica has acknowledged deletion.
CREATE TABLE deletion_tombstones(entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation_id TEXT NOT NULL, deleted_at TEXT NOT NULL, restored_at TEXT, PRIMARY KEY(entity_type,entity_id));
DROP TRIGGER prevent_deleted_edit;
CREATE TRIGGER prevent_deleted_edit BEFORE UPDATE ON tasks WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Deleted task'); END;
CREATE TRIGGER prevent_deleted_project_edit BEFORE UPDATE ON projects WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Deleted project'); END;
CREATE TRIGGER new_deleted_project BEFORE INSERT ON tasks WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Deleted project'); END;
CREATE TRIGGER move_deleted_project BEFORE UPDATE OF project_id ON tasks WHEN NEW.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Deleted project'); END;
CREATE TRIGGER trash_project_next AFTER UPDATE OF deleted_at ON projects WHEN NEW.deleted_at IS NOT NULL BEGIN UPDATE project_context SET next_action_task_id=NULL,next_action_cleared=1,version=version+1 WHERE project_id=NEW.id; END;
