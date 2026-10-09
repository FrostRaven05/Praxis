import schema from "../../../apps/desktop/src-tauri/migrations/0001_capture.sql?raw";
// Version 1 contains no triggers or semicolons inside literals; each plugin entry is one statement.
export const initialStatements = schema
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

export const captureStatements = [
  `CREATE TABLE captures (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), raw_text TEXT NOT NULL CHECK(length(trim(raw_text))>0), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE capture_events (operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, capture_id TEXT NOT NULL REFERENCES captures(id), kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), occurred_at TEXT NOT NULL)`,
  `ALTER TABLE sync_outbox RENAME TO sync_outbox_v1`,
  `CREATE TABLE sync_outbox (operation_id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id), device_id TEXT NOT NULL REFERENCES local_profile(device_id), protocol_version INTEGER NOT NULL CHECK(protocol_version=1), kind TEXT NOT NULL CHECK(kind IN ('capture_task','save_capture')), payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL)`,
  `INSERT INTO sync_outbox SELECT * FROM sync_outbox_v1`,
  `DROP TABLE sync_outbox_v1`,
];
