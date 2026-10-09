use super::planning::{replay, validate_operation};
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetails {
    pub task_id: String,
    pub title: String,
    pub notes: String,
    pub completion_criteria: String,
    pub important: bool,
    pub deadline: Option<String>,
    pub deadline_time_zone: Option<String>,
    pub estimated_minutes: Option<i64>,
    pub version: i64,
    pub status: String,
    pub project_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDetailsCommand {
    pub operation_id: String,
    pub task_id: String,
    pub expected_version: i64,
    pub title: String,
    pub notes: String,
    pub completion_criteria: String,
    pub important: bool,
    pub deadline: Option<String>,
    pub deadline_time_zone: Option<String>,
    pub estimated_minutes: Option<i64>,
    pub occurred_at: String,
}
const DETAILS:&str="SELECT id AS task_id,title,notes,completion_criteria,important,deadline,deadline_time_zone,default_estimated_minutes AS estimated_minutes,version,CASE WHEN waiting=1 THEN 'waiting' ELSE status END AS status,project_id FROM tasks WHERE id=? AND owner_id=?";
impl Store {
    pub async fn task_details(&self, task_id: &str) -> StoreResult<TaskDetails> {
        sqlx::query_as(DETAILS)
            .bind(task_id)
            .bind(&self.owner_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn save_task_details(&self, c: &TaskDetailsCommand) -> StoreResult<TaskDetails> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        Uuid::parse_str(&c.task_id).map_err(|_| "Invalid task ID")?;
        if c.title.trim().is_empty()
            || c.expected_version < 0
            || c.estimated_minutes
                .is_some_and(|m| !(1..=1440).contains(&m))
        {
            return Err("Invalid task details".into());
        }

        let normalized_deadline = match (&c.deadline, &c.deadline_time_zone) {
            (None, None) => None,
            (Some(deadline), Some(zone)) => {
                zone.parse::<Tz>()
                    .map_err(|_| "Invalid deadline time zone")?;
                Some(
                    DateTime::parse_from_rfc3339(deadline)
                        .map_err(|_| "Invalid deadline")?
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
                )
            }
            _ => return Err("Deadline and time zone must be set together".into()),
        };
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "save_task_details",
            &payload,
        )
        .await?
        {
            let before: TaskDetails = sqlx::query_as(DETAILS)
                .bind(&c.task_id)
                .bind(&self.owner_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            if before.version != c.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            sqlx::query("UPDATE tasks SET title=?,notes=?,completion_criteria=?,important=?,deadline=?,deadline_time_zone=?,default_estimated_minutes=?,version=version+1 WHERE id=? AND owner_id=?")
 .bind(c.title.trim()).bind(&c.notes).bind(&c.completion_criteria).bind(c.important).bind(&normalized_deadline).bind(&c.deadline_time_zone).bind(c.estimated_minutes).bind(&c.task_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'task_details_saved',?,?)")
 .bind(&c.operation_id).bind(&self.owner_id).bind(&c.task_id).bind(&c.occurred_at).bind(serde_json::json!({"before":before,"command":c}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "save_task_details",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        let result = sqlx::query_as(DETAILS)
            .bind(&c.task_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
}
