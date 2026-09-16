CREATE TABLE local_profile (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL UNIQUE
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    project_id TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'completed', 'cancelled')),
    source TEXT NOT NULL CHECK (source = 'temporary'),
    created_at TEXT NOT NULL,
    UNIQUE (owner_id, id)
);

CREATE TABLE daily_plan_items (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    execution_date TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id),
    UNIQUE (owner_id, task_id, execution_date)
);
CREATE INDEX daily_plan_by_date ON daily_plan_items(owner_id, execution_date);

CREATE TABLE domain_events (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'task_captured'),
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, id)
);
CREATE INDEX history_by_task ON domain_events(owner_id, task_id);

CREATE TABLE sync_outbox (
    operation_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
    kind TEXT NOT NULL CHECK (kind = 'capture_task'),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES local_profile(owner_id),
    FOREIGN KEY (device_id) REFERENCES local_profile(device_id)
);
