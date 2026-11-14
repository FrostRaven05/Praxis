-- AI application receipts stay local to the applying device; normal entities keep their existing sync path.
CREATE TABLE ai_applications (
  owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
  operation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  reward_record_id TEXT,
  PRIMARY KEY(owner_id,operation_id),
  UNIQUE(owner_id,run_id)
);
CREATE TABLE cultivation_credits (
  owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
  task_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  PRIMARY KEY(owner_id,task_id)
);
CREATE TABLE cultivation_state (
  owner_id TEXT PRIMARY KEY REFERENCES local_profile(owner_id),
  version INTEGER NOT NULL DEFAULT 0,
  breakthroughs INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0,
  target INTEGER NOT NULL DEFAULT 3 CHECK(target BETWEEN 1 AND 100),
  milestone TEXT NOT NULL DEFAULT '',
  reward TEXT NOT NULL DEFAULT '',
  achieved_at TEXT,
  claimed_at TEXT
);

CREATE TABLE cultivation_achievements (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),milestone TEXT NOT NULL,reward TEXT NOT NULL,created_at TEXT NOT NULL,claimed_at TEXT);
