ALTER TABLE daily_plan_items ADD COLUMN day_period TEXT NOT NULL DEFAULT 'morning' CHECK(day_period IN ('morning','afternoon','evening'));
ALTER TABLE daily_plan_items ADD COLUMN day_rank INTEGER NOT NULL DEFAULT 0 CHECK(day_rank>=0);
