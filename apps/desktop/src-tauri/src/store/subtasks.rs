use super::planning::{replay, validate_operation};
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddSubtasksCommand {
    pub operation_id: String,
    pub parent_task_id: String,
    pub expected_version: i64,
    pub confirm_summary_plan: bool,
    pub tasks: Vec<NewProjectTask>,
    pub occurred_at: String,
}
impl Store {
    pub async fn add_subtasks(&self, c: &AddSubtasksCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        if c.tasks.is_empty() {
            return Err("Tasks required".into());
        }
        for t in &c.tasks {
            Uuid::parse_str(&t.task_id).map_err(|_| "Invalid task ID")?;
            if t.title.trim().is_empty() {
                return Err("Title required".into());
            }
        }
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "add_subtasks",
            &payload,
        )
        .await?
        {
            let (project, version, status): (Option<String>, i64, String) = sqlx::query_as(
                "SELECT project_id,version,status FROM tasks WHERE id=? AND owner_id=?",
            )
            .bind(&c.parent_task_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if version != c.expected_version {
                return Err("STATE_CONFLICT".into());
            }

            if status != "todo" {
                return Err("Only pending tasks can be split".into());
            }
            let plans: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM daily_plan_items WHERE task_id=? AND owner_id=? AND is_summary=0 AND removed=0",
            )
            .bind(&c.parent_task_id)
            .bind(&self.owner_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if !plans.is_empty() && !c.confirm_summary_plan {
                return Err("SUMMARY_CONFIRMATION_REQUIRED".into());
            }
            sqlx::query("UPDATE daily_plan_items SET is_summary=1 WHERE task_id=? AND owner_id=?")
                .bind(&c.parent_task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM project_schedules WHERE task_id=? AND owner_id=?")
                .bind(&c.parent_task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            let rank:i64=sqlx::query_scalar("SELECT COALESCE(MAX(task_rank),0) FROM tasks WHERE parent_task_id=? AND owner_id=?").bind(&c.parent_task_id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            for (i, t) in c.tasks.iter().enumerate() {
                sqlx::query("INSERT INTO tasks(id,owner_id,title,project_id,parent_task_id,task_rank,status,source,created_at) VALUES(?,?,?,?,?,?,'todo','temporary',?)").bind(&t.task_id).bind(&self.owner_id).bind(t.title.trim()).bind(&project).bind(&c.parent_task_id).bind(rank+i as i64+1).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'subtask_created',?,?)").bind(Uuid::new_v4().to_string()).bind(&self.owner_id).bind(&t.task_id).bind(&c.occurred_at).bind(serde_json::json!({"operationId":c.operation_id,"parentTaskId":c.parent_task_id,"task":t}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            sqlx::query("UPDATE tasks SET version=version+1 WHERE id=? AND owner_id=?")
                .bind(&c.parent_task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'task_split',?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(&c.parent_task_id).bind(&c.occurred_at).bind(serde_json::json!({"command":c,"summaryPlanIds":plans}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "add_subtasks",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
}
