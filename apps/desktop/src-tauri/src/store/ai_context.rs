use super::*;
use serde_json::{json, Value};

#[derive(FromRow)]
struct RecoveryRow {
    version: i64,
    updated_at: String,
    definition_of_done: String,
    blocker_text: String,
    last_context: String,
    restart_hint: String,
    waiting_note: String,
    review_date: Option<String>,
    next_action_task_id: Option<String>,
    next_action_cleared: bool,
}
#[derive(FromRow)]
struct RecordRow {
    id: String,
    version: i64,
    title: String,
    body: String,
    record_type: String,
    updated_at: String,
}
#[derive(FromRow)]
struct ContextTask {
    id: String,
    title: String,
    status: String,
    version: i64,
    parent_task_id: Option<String>,
    estimated_minutes: Option<i64>,
    completion_criteria: String,
    status_reason: String,
    planned_start: Option<String>,
    planned_end: Option<String>,
    execution_date: Option<String>,
    plan_value: Option<String>,
}
fn excerpt(value: &str, limit: usize) -> (String, bool) {
    let mut chars = value.chars();
    let result: String = chars.by_ref().take(limit).collect();
    (result, chars.next().is_some())
}
async fn recovery_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
    project: &str,
) -> StoreResult<Option<RecoveryRow>> {
    sqlx::query_as("SELECT c.version,c.updated_at,c.definition_of_done,c.blocker_text,c.last_context,c.restart_hint,c.waiting_note,c.review_date,c.next_action_task_id,c.next_action_cleared FROM project_context c JOIN projects p ON p.id=c.project_id WHERE p.id=? AND p.owner_id=? AND p.deleted_at IS NULL")
        .bind(project).bind(owner).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())
}
async fn record_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
    project: &str,
) -> StoreResult<Vec<RecordRow>> {
    // A record may follow project tasks, but all of its links must stay in this scope.
    sqlx::query_as("WITH scoped_targets(target_type,target_id) AS (SELECT 'project',? UNION ALL SELECT 'task',id FROM tasks WHERE owner_id=? AND project_id=?) SELECT r.id,r.version,r.title,r.body,r.record_type,r.updated_at FROM records r WHERE r.owner_id=? AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM record_links l JOIN scoped_targets s ON s.target_type=l.target_type AND s.target_id=l.target_id WHERE l.record_id=r.id) AND NOT EXISTS(SELECT 1 FROM record_links l LEFT JOIN scoped_targets s ON s.target_type=l.target_type AND s.target_id=l.target_id WHERE l.record_id=r.id AND s.target_id IS NULL) ORDER BY r.updated_at DESC,r.id LIMIT 5")
        .bind(project).bind(owner).bind(project).bind(owner).fetch_all(&mut **tx).await.map_err(|e|e.to_string())
}
pub(super) async fn recovery_basis(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
    project: &str,
) -> StoreResult<(Option<i64>, Vec<super::ai::AiBasis>)> {
    let recovery = recovery_row(tx, owner, project).await?;
    let records = record_rows(tx, owner, project).await?;
    Ok((
        recovery.map(|r| r.version),
        records
            .into_iter()
            .map(|r| super::ai::AiBasis {
                id: r.id,
                version: r.version,
            })
            .collect(),
    ))
}
fn execution_date(
    plan: &Option<String>,
    fallback: Option<String>,
    tz: chrono_tz::Tz,
) -> Option<String> {
    let parsed = plan
        .as_ref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    match parsed.as_ref().and_then(|v| v["kind"].as_str()) {
        Some("date") => parsed
            .as_ref()
            .and_then(|v| v["date"].as_str())
            .map(str::to_owned),
        Some("instant") => parsed
            .as_ref()
            .and_then(|v| v["atUtc"].as_str())
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|d| d.with_timezone(&tz).date_naive().to_string()),
        _ => fallback,
    }
}
impl Store {
    pub async fn ai_project_snapshot(&self, project_id: &str) -> StoreResult<Value> {
        Uuid::parse_str(project_id).map_err(|_| "AI_STALE_PROJECT")?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let project:Option<(String,String,i64,i64)>=sqlx::query_as("SELECT name,outcome,version,plan_version FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL AND archived_at IS NULL AND canceled=0 AND status='active'")
            .bind(project_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        let (name, outcome, version, plan_version) = project.ok_or("AI_STALE_PROJECT")?;
        let tasks:Vec<ContextTask>=sqlx::query_as("SELECT t.id,t.title,CASE WHEN t.waiting=1 THEN 'waiting' ELSE t.status END AS status,t.version,t.parent_task_id,COALESCE((SELECT estimated_minutes FROM daily_plan_items WHERE task_id=t.id AND owner_id=t.owner_id AND removed=0 AND is_summary=0 ORDER BY created_at DESC,rowid DESC LIMIT 1),t.default_estimated_minutes) AS estimated_minutes,t.completion_criteria,CASE WHEN t.waiting=1 THEN t.waiting_for||' '||t.waiting_note ELSE t.status_reason END AS status_reason,(SELECT start_date FROM project_schedules WHERE task_id=t.id AND owner_id=t.owner_id) AS planned_start,(SELECT end_date FROM project_schedules WHERE task_id=t.id AND owner_id=t.owner_id) AS planned_end,(SELECT execution_date FROM daily_plan_items WHERE task_id=t.id AND owner_id=t.owner_id AND removed=0 AND is_summary=0 ORDER BY created_at DESC,rowid DESC LIMIT 1) AS execution_date,t.plan_value FROM tasks t WHERE t.project_id=? AND t.owner_id=? AND t.deleted_at IS NULL ORDER BY t.created_at,t.id LIMIT 101")
            .bind(project_id).bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        if tasks.len() > 100 {
            return Err("AI_PROJECT_TOO_LARGE".into());
        }
        let edges:Vec<(String,String)>=sqlx::query_as("SELECT d.task_id,d.predecessor_id FROM task_dependencies d JOIN tasks t ON t.id=d.task_id AND t.owner_id=d.owner_id WHERE d.owner_id=? AND t.project_id=? AND t.deleted_at IS NULL ORDER BY d.predecessor_id")
            .bind(&self.owner_id).bind(project_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let zone: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        let zone = zone.unwrap_or_else(|| "UTC".into());
        let tz: chrono_tz::Tz = zone.parse().map_err(|_| "项目时区无效，请先检查设置。")?;
        let date = chrono::Utc::now()
            .with_timezone(&tz)
            .date_naive()
            .to_string();
        let mut truncated = false;
        let (name, name_cut) = excerpt(&name, 250);
        let (outcome, outcome_cut) = excerpt(&outcome, 2000);
        truncated |= name_cut || outcome_cut;
        let task_values:Vec<Value>=tasks.into_iter().map(|t|{
            let(title,title_cut)=excerpt(&t.title,250);let(criteria,criteria_cut)=excerpt(&t.completion_criteria,200);let(reason,reason_cut)=excerpt(&t.status_reason,300);truncated|=title_cut||criteria_cut||reason_cut;
            let deps:Vec<&str>=edges.iter().filter(|(id,_)|id==&t.id).map(|(_,d)|d.as_str()).collect();
            json!({"id":t.id,"title":title,"status":t.status,"version":t.version,"parentId":t.parent_task_id,"dependencies":deps,"estimatedMinutes":t.estimated_minutes,"completionCriteria":criteria,"statusReason":reason,"plannedStart":t.planned_start,"plannedEnd":t.planned_end,"executionDate":execution_date(&t.plan_value,t.execution_date,tz)})
        }).collect();
        let recovery = if let Some(r) = recovery_row(&mut tx, &self.owner_id, project_id).await? {
            let (definition, a) = excerpt(&r.definition_of_done, 1000);
            let (blocker, b) = excerpt(&r.blocker_text, 1000);
            let (last, c) = excerpt(&r.last_context, 1000);
            let (hint, d) = excerpt(&r.restart_hint, 1000);
            let (waiting, e) = excerpt(&r.waiting_note, 1000);
            truncated |= a || b || c || d || e;
            json!({"version":r.version,"updatedAt":r.updated_at,"definitionOfDone":definition,"blockerText":blocker,"lastContext":last,"restartHint":hint,"waitingNote":waiting,"reviewDate":r.review_date,"nextActionTaskId":r.next_action_task_id,"nextActionCleared":r.next_action_cleared})
        } else {
            Value::Null
        };
        let records:Vec<Value>=record_rows(&mut tx,&self.owner_id,project_id).await?.into_iter().map(|r|{
            let(title,a)=excerpt(&r.title,120);let(body,b)=excerpt(&r.body,500);truncated|=a||b;
            json!({"id":r.id,"version":r.version,"title":title,"recordType":r.record_type,"bodyExcerpt":body,"updatedAt":r.updated_at,"truncated":a||b})
        }).collect();
        let result = json!({"date":date,"timeZone":zone,"project":{"id":project_id,"name":name,"outcome":outcome,"version":version,"planVersion":plan_version},"tasks":task_values,"source":null,"recovery":recovery,"recentRecords":records,"truncated":truncated});
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        Uuid::new_v4().to_string()
    }
    async fn project(s: &Store, name: &str) -> String {
        let id = id();
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,?,'完成作品',1,0,'2026-10-25T00:00:00Z')").bind(&id).bind(&s.owner_id).bind(name).execute(&s.pool).await.unwrap();
        id
    }
    async fn task(s: &Store, p: &str) -> String {
        let id = id();
        sqlx::query("INSERT INTO tasks(id,owner_id,project_id,title,status,source,created_at,default_estimated_minutes,completion_criteria,plan_value) VALUES(?,?,?,'整理照片','todo','temporary','2026-10-25T00:00:00Z',30,'十张照片放入同一文件夹',?)").bind(&id).bind(&s.owner_id).bind(p).bind(json!({"kind":"date","date":"2999-01-01"}).to_string()).execute(&s.pool).await.unwrap();
        id
    }
    async fn record(s: &Store, p: &str, title: &str, body: &str) -> String {
        let id = id();
        sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,created_at,updated_at) VALUES(?,?,?,?,'progress','2026-10-25T00:00:00Z','2026-10-25T01:00:00Z')").bind(&id).bind(&s.owner_id).bind(title).bind(body).execute(&s.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO record_links(record_id,target_type,target_id) VALUES(?,'project',?)",
        )
        .bind(&id)
        .bind(p)
        .execute(&s.pool)
        .await
        .unwrap();
        id
    }
    async fn command(s: &Store, p: &str) -> super::super::ai::AiApplyCommand {
        let snapshot = s.ai_project_snapshot(p).await.unwrap();
        serde_json::from_value(json!({"operationId":id(),"runId":id(),"input":"继续作品集","source":null,"project":{"id":p,"version":snapshot["project"]["version"],"planVersion":snapshot["project"]["planVersion"]},"newProject":null,"basisTasks":snapshot["tasks"].as_array().unwrap().iter().map(|t|json!({"id":t["id"],"version":t["version"]})).collect::<Vec<_>>(),"tasks":[{"id":id(),"key":"s1","title":"补充一个作品说明","criteria":"写完一段说明","estimatedMinutes":15,"dependsOn":[]}],"reward":null,"basisRecovery":{"version":snapshot["recovery"].get("version").cloned().unwrap_or(Value::Null),"records":snapshot["recentRecords"].as_array().unwrap().iter().map(|r|json!({"id":r["id"],"version":r["version"]})).collect::<Vec<_>>()}})).unwrap()
    }
    #[tokio::test]
    async fn snapshot_contains_real_estimate_schedule_recovery_and_exclusive_record_excerpts() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let a = project(&s, "摄影").await;
        let b = project(&s, "另一个项目").await;
        let t = task(&s, &a).await;
        sqlx::query("INSERT INTO workspace_settings(owner_id,time_zone) VALUES(?,'Asia/Hong_Kong') ON CONFLICT(owner_id) DO UPDATE SET time_zone='Asia/Hong_Kong'").bind(&s.owner_id).execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO project_context(project_id,definition_of_done,blocker_text,last_context,restart_hint,waiting_note,version,updated_at) VALUES(?,'发布十张照片','等候反馈','上次已选出五张','先补选五张','尚待确认',4,'2026-10-25T00:00:00Z')").bind(&a).execute(&s.pool).await.unwrap();
        let own = record(&s, &a, "选片进展", &"进".repeat(501)).await;
        let shared = record(&s, &a, "跨项目回顾", "不应发送给当前项目").await;
        sqlx::query(
            "INSERT INTO record_links(record_id,target_type,target_id) VALUES(?,'project',?)",
        )
        .bind(&shared)
        .bind(&b)
        .execute(&s.pool)
        .await
        .unwrap();
        record(&s, &b, "其他项目私有记录", "不相关").await;
        let snapshot = s.ai_project_snapshot(&a).await.unwrap();
        assert_eq!(snapshot["timeZone"], "Asia/Hong_Kong");
        assert_eq!(snapshot["recovery"]["version"], 4);
        assert_eq!(snapshot["recovery"]["lastContext"], "上次已选出五张");
        assert_eq!(snapshot["tasks"][0]["id"], t);
        assert_eq!(snapshot["tasks"][0]["estimatedMinutes"], 30);
        assert_eq!(snapshot["tasks"][0]["executionDate"], "2999-01-01");
        assert_eq!(
            snapshot["tasks"][0]["completionCriteria"],
            "十张照片放入同一文件夹"
        );
        assert_eq!(snapshot["recentRecords"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["recentRecords"][0]["id"], own);
        assert_eq!(
            snapshot["recentRecords"][0]["bodyExcerpt"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            500
        );
        assert_eq!(snapshot["recentRecords"][0]["truncated"], true);
        assert_eq!(snapshot["truncated"], true);
    }
    #[tokio::test]
    async fn changes_to_recovery_and_records_reject_adoption_without_partial_capture() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let p = project(&s, "作品集").await;
        task(&s, &p).await;
        let c = command(&s, &p).await;
        sqlx::query("INSERT INTO project_context(project_id,version,updated_at) VALUES(?,0,'2026-10-25T00:00:00Z')").bind(&p).execute(&s.pool).await.unwrap();
        assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_PROJECT");
        let r = record(&s, &p, "恢复进展", "第一段").await;
        let c = command(&s, &p).await;
        sqlx::query("UPDATE records SET body='第二段',version=version+1 WHERE id=?")
            .bind(&r)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_PROJECT");
        let c = command(&s, &p).await;
        record(&s, &p, "新的重要决定", "不要按原计划推进").await;
        assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_PROJECT");
        let c = command(&s, &p).await;
        sqlx::query("UPDATE records SET deleted_at='2026-10-25T02:00:00Z' WHERE id=?")
            .bind(&r)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_PROJECT");
        assert!(s.content_snapshot().await.unwrap()["captures"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn unchanged_recovery_applies_and_replay_ignores_later_source_edits() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let p = project(&s, "作品").await;
        let other = project(&s, "无关").await;
        task(&s, &p).await;
        record(&s, &p, "进展", "原始记录").await;
        let c = command(&s, &p).await;
        record(&s, &other, "无关进展", "不能影响当前范围").await;
        let first = s.ai_apply(&c).await.unwrap();
        record(&s, &p, "后续记录", "采用后新增").await;
        let replay = s.ai_apply(&c).await.unwrap();
        assert_eq!(first.task_ids, replay.task_ids);
        assert_eq!(
            s.content_snapshot().await.unwrap()["captures"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn records_are_bounded_and_inactive_or_missing_projects_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let p = project(&s, "项目").await;
        for i in 0..7 {
            record(&s, &p, &format!("进展{i}"), "内容").await;
        }
        assert_eq!(
            s.ai_project_snapshot(&p).await.unwrap()["recentRecords"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        sqlx::query("UPDATE projects SET status='paused' WHERE id=?")
            .bind(&p)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            s.ai_project_snapshot(&p).await.unwrap_err(),
            "AI_STALE_PROJECT"
        );
        assert_eq!(
            s.ai_project_snapshot(&id()).await.unwrap_err(),
            "AI_STALE_PROJECT"
        );
    }

    #[tokio::test]
    async fn explicit_arrangement_estimate_and_instant_date_use_workspace_timezone() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let p = project(&s, "项目").await;
        let t = task(&s, &p).await;
        sqlx::query("INSERT INTO workspace_settings(owner_id,time_zone) VALUES(?,'Asia/Hong_Kong') ON CONFLICT(owner_id) DO UPDATE SET time_zone='Asia/Hong_Kong'").bind(&s.owner_id).execute(&s.pool).await.unwrap();
        sqlx::query("UPDATE tasks SET plan_value=?,completion_criteria=? WHERE id=?").bind(json!({"kind":"instant","atUtc":"2026-10-25T18:00:00Z","displayTimezone":"Asia/Hong_Kong"}).to_string()).bind("😀".repeat(201)).bind(&t).execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at,estimated_minutes) VALUES(?,?,?,'2026-10-26','Asia/Hong_Kong','2026-10-25T00:00:00Z',10)").bind(id()).bind(&s.owner_id).bind(&t).execute(&s.pool).await.unwrap();
        let snapshot = s.ai_project_snapshot(&p).await.unwrap();
        assert_eq!(snapshot["tasks"][0]["executionDate"], "2026-10-26");
        assert_eq!(snapshot["tasks"][0]["estimatedMinutes"], 10);
        assert_eq!(
            snapshot["tasks"][0]["completionCriteria"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            400
        );
        assert_eq!(snapshot["truncated"], true);
    }
}
