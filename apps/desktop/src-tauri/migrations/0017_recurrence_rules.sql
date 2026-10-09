CREATE TABLE recurrence_rules(template_id TEXT NOT NULL REFERENCES recurrence_templates(id), effective_date TEXT NOT NULL, title TEXT NOT NULL, interval_days INTEGER NOT NULL, weekdays TEXT NOT NULL, time_zone TEXT NOT NULL, anchor_date TEXT NOT NULL, PRIMARY KEY(template_id,effective_date));
INSERT INTO recurrence_rules SELECT id,start_date,title,interval_days,weekdays,time_zone,start_date FROM recurrence_templates;

