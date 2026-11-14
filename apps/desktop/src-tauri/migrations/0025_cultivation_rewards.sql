-- Local cultivation agreements retain wishes and link completed work to one breakthrough.
ALTER TABLE cultivation_state ADD COLUMN goal_id TEXT;
ALTER TABLE cultivation_state ADD COLUMN source_application_id TEXT;
ALTER TABLE cultivation_state ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cultivation_achievements ADD COLUMN reward_id TEXT;
CREATE TABLE cultivation_reward_agreements (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 milestone TEXT NOT NULL,
 reward TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('wish','locked','available','claimed','paused')),
 binding_mode TEXT NOT NULL CHECK(binding_mode IN ('all','tasks','wish')),
 task_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(task_ids)),
 source_application_id TEXT,
 created_at TEXT NOT NULL,
 unlocked_at TEXT,
 claimed_at TEXT
);
CREATE INDEX cultivation_rewards_owner ON cultivation_reward_agreements(owner_id,created_at);
CREATE TABLE cultivation_goal_tasks (
 owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 task_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,task_id)
);
CREATE TABLE cultivation_goal_baseline_tasks (
 owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 task_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,task_id)
);
CREATE TABLE cultivation_achievement_tasks (
 achievement_id TEXT NOT NULL REFERENCES cultivation_achievements(id),
 owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 task_id TEXT NOT NULL,
 PRIMARY KEY(achievement_id,task_id),
 UNIQUE(owner_id,task_id)
);
-- Preserve historical rewards without inventing links to historical tasks.
UPDATE cultivation_achievements SET reward_id=id;
INSERT INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,task_ids,created_at,unlocked_at,claimed_at)
 SELECT id,owner_id,milestone,reward,CASE WHEN claimed_at IS NULL THEN 'available' ELSE 'claimed' END,'all','[]',created_at,created_at,claimed_at
 FROM cultivation_achievements;
