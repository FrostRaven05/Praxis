CREATE TABLE habits (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 500),
 trigger_context TEXT NOT NULL DEFAULT '', normal_version TEXT NOT NULL DEFAULT '', minimum_version TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', project_id TEXT REFERENCES projects(id),
 start_date TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE habit_schedules (
 habit_id TEXT NOT NULL REFERENCES habits(id), version INTEGER NOT NULL,
 effective_from TEXT NOT NULL, effective_until TEXT,
 frequency TEXT NOT NULL CHECK(frequency IN('daily','weekdays','weekly')),
 weekdays TEXT NOT NULL CHECK(json_valid(weekdays)), weekly_target INTEGER NOT NULL CHECK(weekly_target BETWEEN 1 AND 7),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 PRIMARY KEY(habit_id,version), CHECK(effective_until IS NULL OR effective_until>effective_from)
);
CREATE TRIGGER habit_schedule_overlap_insert BEFORE INSERT ON habit_schedules BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM habit_schedules s WHERE s.habit_id=NEW.habit_id AND s.effective_from<COALESCE(NEW.effective_until,'9999-12-31') AND NEW.effective_from<COALESCE(s.effective_until,'9999-12-31')) THEN RAISE(ABORT,'Habit schedule ranges overlap') END;
END;
CREATE TRIGGER habit_schedule_overlap_update BEFORE UPDATE ON habit_schedules BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM habit_schedules s WHERE s.habit_id=NEW.habit_id AND s.version<>OLD.version AND s.effective_from<COALESCE(NEW.effective_until,'9999-12-31') AND NEW.effective_from<COALESCE(s.effective_until,'9999-12-31')) THEN RAISE(ABORT,'Habit schedule ranges overlap') END;
END;
CREATE TABLE habit_entries (
 habit_id TEXT NOT NULL REFERENCES habits(id), local_date TEXT NOT NULL,
 status TEXT CHECK(status IN('done','skipped')), note TEXT NOT NULL DEFAULT '',
 timezone TEXT NOT NULL, occurred_at TEXT NOT NULL, schedule_version INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(habit_id,local_date), FOREIGN KEY(habit_id,schedule_version) REFERENCES habit_schedules(habit_id,version)
);
CREATE TABLE habit_events (
 id TEXT PRIMARY KEY, habit_id TEXT NOT NULL REFERENCES habits(id), local_date TEXT,
 occurred_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX habit_owner ON habits(owner_id);
