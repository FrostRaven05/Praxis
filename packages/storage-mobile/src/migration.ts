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

// Additive migration: existing capture history and queues stay intact.
export const workspaceStatements = [
  `CREATE TABLE mobile_workspaces(id TEXT PRIMARY KEY,title TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)))`,
  `CREATE UNIQUE INDEX mobile_one_active_workspace ON mobile_workspaces(active) WHERE active=1`,
  `INSERT INTO mobile_workspaces VALUES('local','本机工作空间',1)`,
  `CREATE TABLE mobile_entities(workspace_id TEXT NOT NULL REFERENCES mobile_workspaces(id),id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id))`,
  `CREATE TABLE mobile_operations(operation_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES mobile_workspaces(id),payload TEXT NOT NULL CHECK(json_valid(payload)),occurred_at TEXT NOT NULL)`,
  `CREATE TABLE mobile_import_history(workspace_id TEXT NOT NULL REFERENCES mobile_workspaces(id),operation_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),occurred_at TEXT NOT NULL,PRIMARY KEY(workspace_id,operation_id))`,
  `CREATE TABLE mobile_import_receipts(operation_id TEXT PRIMARY KEY,json TEXT NOT NULL)`,
  `INSERT INTO mobile_entities SELECT 'local',t.id,'task',1,json_object('title',t.title,'status',t.status,'executionDate',(SELECT MIN(execution_date) FROM daily_plan_items p WHERE p.task_id=t.id),'projectId',NULL,'priority',0,'tags',json('[]')),0,t.created_at,t.created_at FROM tasks t`,
  `INSERT INTO mobile_entities SELECT 'local',id,'capture',version,json_object('rawText',raw_text,'status','inbox'),0,created_at,updated_at FROM captures`,
  `INSERT INTO mobile_entities SELECT 'local',MIN(id),'plan',1,json_object('date',execution_date,'taskIds',json_group_array(task_id),'timeZone',MIN(time_zone)),0,MIN(created_at),MAX(created_at) FROM daily_plan_items GROUP BY execution_date`,
  `INSERT OR IGNORE INTO mobile_import_history SELECT 'local',id,payload,occurred_at FROM domain_events`,
  `INSERT OR IGNORE INTO mobile_import_history SELECT 'local',operation_id,payload,occurred_at FROM capture_events`,
];

export const lanStatements = [
  `CREATE TABLE mobile_lan_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL REFERENCES mobile_workspaces(id),base_url TEXT NOT NULL,owner_id TEXT NOT NULL,device_id TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,last_success TEXT)`,
  `CREATE TABLE mobile_lan_shadow(id TEXT PRIMARY KEY,remote TEXT,conflict INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE mobile_lan_pending(id TEXT PRIMARY KEY,payload TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0)`,
];
