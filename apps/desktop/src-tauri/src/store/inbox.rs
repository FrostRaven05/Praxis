use super::planning::{replay, validate_operation};
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxCommand {
    pub operation_id: String,
    pub task_id: String,
    pub title: String,
    pub occurred_at: String,
}
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InboxTask {
    pub important: bool,
    pub task_id: String,
    pub title: String,
    pub version: i64,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCommand {
    pub operation_id: String,
    pub task_id: String,
    pub plan_id: String,
    pub expected_version: i64,
    pub execution_date: String,
    pub time_zone: String,
    pub occurred_at: String,
}
impl Store {
    pub async fn accept_suggestion(&self, c: &ScheduleCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        validate_date(&c.execution_date)?;
        Uuid::parse_str(&c.task_id).map_err(|_| "Invalid task identifier")?;
        Uuid::parse_str(&c.plan_id).map_err(|_| "Invalid plan identifier")?;
        c.time_zone.parse::<Tz>().map_err(|_| "Invalid timezone")?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(&mut tx, &self.owner_id, &c.operation_id, "accept_suggestion", &payload).await? {
            let allowed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=? AND t.owner_id=? AND t.version=? AND t.deleted_at IS NULL AND t.status IN('todo','in_progress','blocked','waiting') AND NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id AND child.owner_id=t.owner_id AND child.deleted_at IS NULL) AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM projects pr WHERE pr.id=t.project_id AND pr.owner_id=t.owner_id AND pr.status='active' AND pr.archived_at IS NULL)))")
                .bind(&c.task_id).bind(&self.owner_id).bind(c.expected_version).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
            if !allowed { return Err("任务已变化，请重新读取后转换；仅支持活跃项目中的未完成叶子任务。".into()); }
            let original_plan: Option<String> = sqlx::query_scalar("SELECT plan_value FROM tasks WHERE id=? AND owner_id=?").bind(&c.task_id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at,estimated_minutes,day_period,day_rank) SELECT ?,owner_id,id,?,?,?,default_estimated_minutes,'morning',(SELECT COALESCE(MAX(day_rank),0)+1 FROM daily_plan_items WHERE owner_id=? AND execution_date=? AND day_period='morning' AND removed=0) FROM tasks WHERE id=? AND owner_id=? ON CONFLICT(owner_id,task_id,execution_date) DO UPDATE SET removed=0,is_summary=0,time_zone=excluded.time_zone")
                .bind(&c.plan_id).bind(&c.execution_date).bind(&c.time_zone).bind(&c.occurred_at).bind(&self.owner_id).bind(&c.execution_date).bind(&c.task_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            // The legacy daily-plan trigger updates the independent plan; accepting
            // a suggestion must preserve that explicit choice and only add a day slot.
            sqlx::query("UPDATE tasks SET plan_value=?,version=version+1 WHERE id=? AND owner_id=?").bind(original_plan).bind(&c.task_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO domain_events VALUES(?,?,?,'task_scheduled',?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(&c.task_id).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            self.queue_operation(&mut tx, &c.operation_id, "accept_suggestion", &payload, &c.occurred_at).await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn capture_inbox(&self, c: &InboxCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        Uuid::parse_str(&c.task_id).map_err(|_| "Invalid task ID")?;
        if c.title.trim().is_empty() {
            return Err("Title required".into());
        }
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "capture_inbox",
            &payload,
        )
        .await?
        {
            sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES(?,?,?,'todo','temporary',?)").bind(&c.task_id).bind(&self.owner_id).bind(c.title.trim()).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO domain_events VALUES(?,?,?,'inbox_captured',?,?)")
                .bind(&c.operation_id)
                .bind(&self.owner_id)
                .bind(&c.task_id)
                .bind(&c.occurred_at)
                .bind(&payload)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "capture_inbox",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    pub async fn list_inbox(&self) -> StoreResult<Vec<InboxTask>> {
        sqlx::query_as("SELECT t.id AS task_id,t.title,t.version,t.created_at,t.important FROM tasks t WHERE t.owner_id=? AND t.deleted_at IS NULL AND t.status='todo' AND t.project_id IS NULL AND t.plan_value IS NULL AND NOT EXISTS(SELECT 1 FROM daily_plan_items p WHERE p.owner_id=t.owner_id AND p.task_id=t.id AND p.removed=0 AND p.is_summary=0) ORDER BY t.created_at,t.id")
 .bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())
    }
    pub async fn schedule_task(&self, c: &ScheduleCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        validate_date(&c.execution_date)?;
        for id in [&c.task_id, &c.plan_id] {
            Uuid::parse_str(id).map_err(|_| "Invalid identifier")?;
        }
        c.time_zone.parse::<Tz>().map_err(|_| "Invalid timezone")?;
        if c.expected_version < 0 {
            return Err("Invalid version".into());
        }
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "schedule_task",
            &payload,
        )
        .await?
        {
            let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=? AND t.owner_id=? AND t.version=? AND t.status IN('todo','in_progress','blocked') AND NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id AND child.owner_id=t.owner_id) AND NOT EXISTS(SELECT 1 FROM daily_plan_items p WHERE p.task_id=t.id AND p.owner_id=t.owner_id AND p.is_summary=0 AND p.removed=0))")
 .bind(&c.task_id).bind(&self.owner_id).bind(c.expected_version).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if !allowed {
                return Err("STATE_CONFLICT".into());
            }
            let estimate: Option<i64> = sqlx::query_scalar(
                "SELECT default_estimated_minutes FROM tasks WHERE id=? AND owner_id=?",
            )
            .bind(&c.task_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at,estimated_minutes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,task_id,execution_date) DO UPDATE SET removed=0,is_summary=0,time_zone=excluded.time_zone").bind(&c.plan_id).bind(&self.owner_id).bind(&c.task_id).bind(&c.execution_date).bind(&c.time_zone).bind(&c.occurred_at).bind(estimate).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("UPDATE tasks SET version=version+1 WHERE id=? AND owner_id=?")
                .bind(&c.task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO domain_events VALUES(?,?,?,'task_scheduled',?,?)")
                .bind(&c.operation_id)
                .bind(&self.owner_id)
                .bind(&c.task_id)
                .bind(&c.occurred_at)
                .bind(&payload)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "schedule_task",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
