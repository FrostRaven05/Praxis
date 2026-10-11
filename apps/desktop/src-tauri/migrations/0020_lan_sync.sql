ALTER TABLE captures ADD COLUMN sync_deleted INTEGER NOT NULL DEFAULT 0 CHECK(sync_deleted IN(0,1));
CREATE TABLE lan_binding(owner_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,remote_owner TEXT NOT NULL,device_id TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,last_success TEXT);
CREATE TABLE lan_shadow(id TEXT PRIMARY KEY,version INTEGER NOT NULL,raw_text TEXT NOT NULL,deleted INTEGER NOT NULL);
CREATE TABLE lan_pending(id TEXT PRIMARY KEY,payload TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,remote TEXT);
CREATE TABLE lan_capture_edits(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
