CREATE TABLE habit_daily_plans (
 habit_id TEXT NOT NULL REFERENCES habits(id),
 local_date TEXT NOT NULL,
 day_period TEXT NOT NULL CHECK(day_period IN ('morning','afternoon','evening')),
 day_rank INTEGER NOT NULL CHECK(day_rank>=0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(habit_id,local_date)
);
