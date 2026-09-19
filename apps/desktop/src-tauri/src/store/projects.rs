use super::planning::{replay, validate_operation};
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProjectCommand {
    pub operation_id: String,
    pub project_id: String,
    pub expected_version: Option<i64>,
    pub name: String,
    pub outcome: String,
    pub target_date: Option<String>,
    pub priority: i64,
    pub occurred_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewProjectTask {
    pub task_id: String,
    pub title: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddProjectTasksCommand {
    pub operation_id: String,
    pub project_id: String,
    pub tasks: Vec<NewProjectTask>,
    pub occurred_at: String,
}
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub outcome: String,
    pub target_date: Option<String>,
    pub priority: i64,
    pub version: i64,
}
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub important: bool,
    pub task_id: String,
    pub title: String,
    pub version: i64,
    pub created_at: String,
    pub status: String,
    pub execution_date: Option<String>,
    pub completion_date: Option<String>,
}
impl Store {
    pub async fn list_projects(&self) -> StoreResult<Vec<Project>> {
        sqlx::query_as("SELECT id,name,outcome,target_date,priority,version FROM projects WHERE owner_id=? ORDER BY created_at,id").bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())
    }
    pub async fn project_tasks(&self, project_id: &str) -> StoreResult<Vec<ProjectTask>> {
        sqlx::query_as("SELECT t.id AS task_id,t.title,t.important,t.version,t.created_at,t.status,(SELECT p.execution_date FROM daily_plan_items p WHERE p.task_id=t.id AND p.owner_id=t.owner_id ORDER BY p.created_at DESC LIMIT 1) AS execution_date,(SELECT e.execution_date FROM execution_records e WHERE e.id=t.active_completion_id AND e.owner_id=t.owner_id AND e.revoked_at IS NULL) AS completion_date FROM tasks t WHERE t.owner_id=? AND t.project_id=? ORDER BY t.created_at,t.rowid").bind(&self.owner_id).bind(project_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())
    }
    pub async fn save_project(&self, c: &SaveProjectCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        Uuid::parse_str(&c.project_id).map_err(|_| "Invalid project")?;
        if c.name.trim().is_empty()
            || !(0..=2).contains(&c.priority)
            || c.expected_version.is_some_and(|v| v < 0)
        {
            return Err("Invalid project fields".into());
        }
        if let Some(date) = &c.target_date {
            validate_date(date)?;
        }
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "save_project",
            &payload,
        )
        .await?
        {
            let before:Option<Project>=sqlx::query_as("SELECT id,name,outcome,target_date,priority,version FROM projects WHERE id=? AND owner_id=?").bind(&c.project_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
            if before.as_ref().map(|p| p.version) != c.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            if before.is_none() {
                sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,target_date,priority,version,created_at) VALUES(?,?,?,?,?,?,0,?)").bind(&c.project_id).bind(&self.owner_id).bind(c.name.trim()).bind(c.outcome.trim()).bind(&c.target_date).bind(c.priority).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            } else {
                sqlx::query("UPDATE projects SET name=?,outcome=?,target_date=?,priority=?,version=version+1 WHERE id=? AND owner_id=?").bind(c.name.trim()).bind(c.outcome.trim()).bind(&c.target_date).bind(c.priority).bind(&c.project_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            sqlx::query("INSERT INTO project_events(id,owner_id,project_id,kind,occurred_at,payload) VALUES(?,?,?,'project_saved',?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(&c.project_id).bind(&c.occurred_at).bind(serde_json::json!({"before":before,"command":c}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "save_project",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn add_project_tasks(&self, c: &AddProjectTasksCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        if c.tasks.is_empty() {
            return Err("Tasks required".into());
        }
        for t in &c.tasks {
            Uuid::parse_str(&t.task_id).map_err(|_| "Invalid task")?;
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
            "add_project_tasks",
            &payload,
        )
        .await?
        {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_id=?)",
            )
            .bind(&c.project_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if !exists {
                return Err("Project not found".into());
            }
            for t in &c.tasks {
                sqlx::query("INSERT INTO tasks(id,owner_id,title,project_id,status,source,created_at) VALUES(?,?,?,?,'todo','temporary',?)").bind(&t.task_id).bind(&self.owner_id).bind(t.title.trim()).bind(&c.project_id).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'project_task_created',?,?)").bind(Uuid::new_v4().to_string()).bind(&self.owner_id).bind(&t.task_id).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "add_project_tasks",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignProjectCommand {
    pub operation_id: String,
    pub project_id: String,
    pub task_id: String,
    pub expected_version: i64,
    pub occurred_at: String,
}
impl Store {
    pub async fn assign_project(&self, c: &AssignProjectCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "assign_project",
            &payload,
        )
        .await?
        {
            let before: Option<(Option<String>, i64)> =
                sqlx::query_as("SELECT project_id,version FROM tasks WHERE id=? AND owner_id=?")
                    .bind(&c.task_id)
                    .bind(&self.owner_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            let Some((old, version)) = before else {
                return Err("STATE_CONFLICT".into());
            };
            if version != c.expected_version || old.is_some() {
                return Err("STATE_CONFLICT".into());
            }
            sqlx::query(
                "UPDATE tasks SET project_id=?,version=version+1 WHERE id=? AND owner_id=?",
            )
            .bind(&c.project_id)
            .bind(&c.task_id)
            .bind(&self.owner_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'task_project_changed',?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(&c.task_id).bind(&c.occurred_at).bind(serde_json::json!({"beforeProjectId":old,"command":c}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            self.queue_operation(
                &mut tx,
                &c.operation_id,
                "assign_project",
                &payload,
                &c.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
}
