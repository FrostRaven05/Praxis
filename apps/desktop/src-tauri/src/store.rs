mod projects;
pub use projects::{
    AddProjectTasksCommand, AssignProjectCommand, NewProjectTask, Project, ProjectTask,
    SaveProjectCommand,
};
mod inbox;
pub use inbox::{InboxCommand, InboxTask, ScheduleCommand};
mod planning;
pub use planning::{CapacityCommand, DayLoad, PlanChange, PlanCommand};
mod edit;
pub use edit::EditTaskCommand;
use std::{path::Path, time::Duration};

use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    FromRow, SqlitePool,
};
use uuid::Uuid;

type StoreResult<T> = Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureCommand {
    pub operation_id: String,
    pub task_id: String,
    pub plan_id: String,
    pub title: String,
    pub execution_date: String,
    pub time_zone: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyTask {
    pub task_id: String,
    pub plan_id: String,
    pub title: String,
    pub execution_date: String,
    pub created_at: String,
    pub project_id: Option<String>,
    pub status: String,
    pub version: i64,
    pub active_completion_id: Option<String>,
    pub completion_date: Option<String>,
    pub source: String,
    pub is_focus: bool,
    pub focus_rank: i64,
    pub estimated_minutes: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub operation_id: String,
    pub owner_id: String,
    pub device_id: String,
    pub protocol_version: i64,
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionCommand {
    pub operation_id: String,
    pub task_id: String,
    pub plan_id: String,
    pub action: String,
    pub expected_version: i64,
    pub completion_id: Option<String>,
    pub execution_date: String,
    pub time_zone: String,
    pub occurred_at: String,
}
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFact {
    pub id: String,
    pub task_id: String,
    pub plan_id: String,
    pub execution_date: String,
    pub time_zone: String,
    pub occurred_at: String,
    pub revoked_at: Option<String>,
}

pub struct Store {
    pool: SqlitePool,
    owner_id: String,
    device_id: String,
}

const TASK_PROJECTION: &str = "SELECT t.id AS task_id, p.id AS plan_id, t.title,
    p.execution_date, p.is_focus,p.focus_rank,p.estimated_minutes, t.created_at, t.project_id, t.status, t.source, t.version, t.active_completion_id,
    (SELECT execution_date FROM execution_records e WHERE e.id=t.active_completion_id AND e.revoked_at IS NULL) AS completion_date
    FROM tasks t JOIN daily_plan_items p ON p.task_id = t.id AND p.owner_id = t.owner_id";

impl Store {
    pub async fn open(path: &Path) -> StoreResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT OR IGNORE INTO local_profile(singleton, owner_id, device_id) VALUES (1, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        let (owner_id, device_id): (String, String) =
            sqlx::query_as("SELECT owner_id, device_id FROM local_profile WHERE singleton = 1")
                .fetch_one(&pool)
                .await
                .map_err(|error| error.to_string())?;
        Ok(Self {
            pool,
            owner_id,
            device_id,
        })
    }

    /// All four records are committed on the same SQLite connection.
    pub async fn capture(&self, command: &CaptureCommand) -> StoreResult<DailyTask> {
        validate(command)?;
        let payload = serde_json::to_string(command).map_err(|error| error.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|error| error.to_string())?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT payload FROM sync_outbox WHERE operation_id = ? AND owner_id = ?",
        )
        .bind(&command.operation_id)
        .bind(&self.owner_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        if let Some(original) = existing {
            if original != payload {
                return Err(
                    "An operation identifier cannot be reused for different content".to_owned(),
                );
            }
        } else {
            sqlx::query(
                "INSERT INTO tasks(id, owner_id, title, status, source, created_at)
            VALUES (?, ?, ?, 'todo', 'temporary', ?)",
            )
            .bind(&command.task_id)
            .bind(&self.owner_id)
            .bind(command.title.trim())
            .bind(&command.occurred_at)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            sqlx::query("INSERT INTO daily_plan_items(id, owner_id, task_id, execution_date, time_zone, created_at)
            VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&command.plan_id).bind(&self.owner_id).bind(&command.task_id)
            .bind(&command.execution_date).bind(&command.time_zone).bind(&command.occurred_at)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
            sqlx::query(
                "INSERT INTO domain_events(id, owner_id, task_id, kind, occurred_at, payload)
            VALUES (?, ?, ?, 'task_captured', ?, ?)",
            )
            .bind(&command.operation_id)
            .bind(&self.owner_id)
            .bind(&command.task_id)
            .bind(&command.occurred_at)
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            sqlx::query("INSERT INTO sync_outbox(operation_id, owner_id, device_id, protocol_version, kind, payload, created_at)
            VALUES (?, ?, ?, 1, 'capture_task', ?, ?)")
            .bind(&command.operation_id).bind(&self.owner_id).bind(&self.device_id)
            .bind(&payload).bind(&command.occurred_at)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
        }
        let item = sqlx::query_as::<_, DailyTask>(&format!(
            "{TASK_PROJECTION} WHERE p.id = ? AND p.owner_id = ?"
        ))
        .bind(&command.plan_id)
        .bind(&self.owner_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        tx.commit().await.map_err(|error| error.to_string())?;
        Ok(item)
    }

    pub async fn list_day(&self, date: &str) -> StoreResult<Vec<DailyTask>> {
        validate_date(date)?;
        sqlx::query_as::<_, DailyTask>(&format!(
            "{TASK_PROJECTION} WHERE p.owner_id = ? AND (
                (t.status <> 'completed' AND p.execution_date = ?) OR
                (t.status = 'completed' AND EXISTS (
                  SELECT 1 FROM execution_records e WHERE e.id=t.active_completion_id
                  AND e.plan_id=p.id AND e.execution_date=? AND e.revoked_at IS NULL
                ))) ORDER BY p.created_at, p.id"
        ))
        .bind(&self.owner_id)
        .bind(date)
        .bind(date)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn pending_operations(&self) -> StoreResult<Vec<PendingOperation>> {
        sqlx::query_as(
            "SELECT operation_id, owner_id, device_id, protocol_version, kind, payload
            FROM sync_outbox WHERE owner_id = ? ORDER BY rowid",
        )
        .bind(&self.owner_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn task_history(&self, task_id: &str) -> StoreResult<Vec<HistoryEvent>> {
        sqlx::query_as(
            "SELECT id, task_id, kind, occurred_at, payload
            FROM domain_events WHERE owner_id = ? AND task_id = ? ORDER BY rowid",
        )
        .bind(&self.owner_id)
        .bind(task_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn change_completion(&self, command: &CompletionCommand) -> StoreResult<DailyTask> {
        validate_context(
            [&command.operation_id, &command.task_id, &command.plan_id],
            &command.execution_date,
            &command.time_zone,
            &command.occurred_at,
        )?;
        if command.expected_version < 0 || !["complete", "undo"].contains(&command.action.as_str())
        {
            return Err("Invalid completion command".into());
        }
        let payload = serde_json::to_string(command).map_err(|e| e.to_string())?;
        let kind = if command.action == "complete" {
            "complete_task"
        } else {
            "undo_completion"
        };
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let existing: Option<(String, String)> = sqlx::query_as(
            "SELECT payload,kind FROM sync_outbox WHERE operation_id=? AND owner_id=?",
        )
        .bind(&command.operation_id)
        .bind(&self.owner_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((original, original_kind)) = existing {
            if original != payload || original_kind != kind {
                return Err("Operation reused with different content".into());
            }
        } else {
            let current = sqlx::query_as::<_, DailyTask>(&format!(
                "{TASK_PROJECTION} WHERE p.id=? AND t.id=? AND t.owner_id=?"
            ))
            .bind(&command.plan_id)
            .bind(&command.task_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if current.version != command.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            let (status, active, event) = if command.action == "complete" {
                if current.status != "todo" || command.completion_id.is_some() {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("INSERT INTO execution_records(id,owner_id,task_id,plan_id,execution_date,time_zone,occurred_at) VALUES (?,?,?,?,?,?,?)")
                    .bind(&command.operation_id).bind(&self.owner_id).bind(&command.task_id).bind(&command.plan_id)
                    .bind(&command.execution_date).bind(&command.time_zone).bind(&command.occurred_at)
                    .execute(&mut *tx).await.map_err(|e|e.to_string())?;
                (
                    "completed",
                    Some(command.operation_id.clone()),
                    "task_completed",
                )
            } else {
                if current.status != "completed"
                    || current.active_completion_id.is_none()
                    || current.active_completion_id != command.completion_id
                {
                    return Err("STATE_CONFLICT".into());
                }
                let result=sqlx::query("UPDATE execution_records SET revoked_at=? WHERE id=? AND owner_id=? AND task_id=? AND revoked_at IS NULL")
                    .bind(&command.occurred_at).bind(&command.completion_id).bind(&self.owner_id).bind(&command.task_id)
                    .execute(&mut *tx).await.map_err(|e|e.to_string())?;
                if result.rows_affected() != 1 {
                    return Err("STATE_CONFLICT".into());
                }
                ("todo", None, "task_completion_undone")
            };
            sqlx::query("UPDATE tasks SET status=?,active_completion_id=?,version=version+1 WHERE id=? AND owner_id=?")
                .bind(status).bind(active).bind(&command.task_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES (?,?,?,?,?,?)")
                .bind(&command.operation_id).bind(&self.owner_id).bind(&command.task_id).bind(event).bind(&command.occurred_at).bind(&payload)
                .execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO sync_outbox(operation_id,owner_id,device_id,protocol_version,kind,payload,created_at) VALUES (?,?,?,1,?,?,?)")
                .bind(&command.operation_id).bind(&self.owner_id).bind(&self.device_id).bind(kind).bind(&payload).bind(&command.occurred_at)
                .execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
        let result = sqlx::query_as::<_, DailyTask>(&format!(
            "{TASK_PROJECTION} WHERE p.id=? AND t.owner_id=?"
        ))
        .bind(&command.plan_id)
        .bind(&self.owner_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub async fn execution_history(&self, task_id: &str) -> StoreResult<Vec<ExecutionFact>> {
        sqlx::query_as("SELECT id,task_id,plan_id,execution_date,time_zone,occurred_at,revoked_at FROM execution_records WHERE task_id=? AND owner_id=? ORDER BY rowid")
            .bind(task_id).bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

fn validate_date(date: &str) -> StoreResult<()> {
    let parsed =
        NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "Invalid calendar date")?;
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err("Expected an ISO calendar date".to_owned());
    }
    Ok(())
}

fn validate(command: &CaptureCommand) -> StoreResult<()> {
    if command.title.trim().is_empty() {
        return Err("请填写任务标题".to_owned());
    }
    validate_context(
        [&command.operation_id, &command.task_id, &command.plan_id],
        &command.execution_date,
        &command.time_zone,
        &command.occurred_at,
    )
}
fn validate_context(
    ids: [&str; 3],
    execution_date: &str,
    time_zone: &str,
    occurred_at: &str,
) -> StoreResult<()> {
    for id in ids {
        Uuid::parse_str(id).map_err(|_| "Invalid identifier")?;
    }
    validate_date(execution_date)?;
    let time_zone: Tz = time_zone.parse().map_err(|_| "Invalid time zone")?;
    let instant =
        DateTime::parse_from_rfc3339(occurred_at).map_err(|_| "Invalid event timestamp")?;
    if instant
        .with_timezone(&time_zone)
        .format("%Y-%m-%d")
        .to_string()
        != execution_date
    {
        return Err("Execution date does not match the user's event day".to_owned());
    }
    Ok(())
}
