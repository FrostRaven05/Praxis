-- Preserve existing foreign keys and original constrained interval columns.
ALTER TABLE recurrence_templates ADD COLUMN interval_days_extended INTEGER CHECK(interval_days_extended BETWEEN 1 AND 3650);
ALTER TABLE recurrence_rules ADD COLUMN interval_days_extended INTEGER CHECK(interval_days_extended BETWEEN 1 AND 3650);
ALTER TABLE recurrence_rules ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1));
ALTER TABLE habit_schedules ADD COLUMN time_zone TEXT;
UPDATE habit_schedules SET time_zone=COALESCE((SELECT w.time_zone FROM habits h JOIN workspace_settings w ON w.owner_id=h.owner_id WHERE h.id=habit_schedules.habit_id),'Asia/Hong_Kong');
