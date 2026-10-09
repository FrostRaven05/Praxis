CREATE TABLE review_settings (
 owner_id TEXT PRIMARY KEY REFERENCES local_profile(owner_id),
 stale_days INTEGER NOT NULL CHECK(stale_days BETWEEN 1 AND 365),
 version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE weekly_reviews (
 record_id TEXT PRIMARY KEY REFERENCES records(id),
 period_start TEXT NOT NULL, period_end TEXT NOT NULL,
 achievements TEXT NOT NULL, blockers TEXT NOT NULL,
 stop_pause TEXT NOT NULL, next_focus TEXT NOT NULL
);
-- A structured review has one canonical body; use its dedicated editor.
CREATE TRIGGER protect_weekly_review BEFORE UPDATE OF body,record_type ON records
WHEN EXISTS(SELECT 1 FROM weekly_reviews w WHERE w.record_id=OLD.id AND
 (NEW.record_type<>'review' OR NEW.body<>'期间：'||w.period_start||' — '||w.period_end||char(10)||char(10)||'推进成果'||char(10)||w.achievements||char(10)||char(10)||'阻塞'||char(10)||w.blockers||char(10)||char(10)||'停止 / 暂停'||char(10)||w.stop_pause||char(10)||char(10)||'下周重点'||char(10)||w.next_focus))
BEGIN SELECT RAISE(ABORT,'Edit structured weekly review in review view'); END;
