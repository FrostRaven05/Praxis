use super::planning::{replay, validate_operation};
use super::*;
use std::collections::{HashMap, HashSet};
type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommand {
    pub operation_id: String,
    pub occurred_at: String,
    #[serde(flatten)]
    pub action: WorkspaceAction,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceAction {
    Lifecycle {
        project_id: String,
        expected_version: i64,
        status: String,
        focused: bool,
        arrangements: String,
        date: String,
    },
    Move {
        project_id: String,
        expected_plan_version: i64,
        task_id: String,
        parent_task_id: Option<String>,
        before_task_id: Option<String>,
        confirm_summary_plan: bool,
    },
    Status {
        task_id: String,
        expected_version: i64,
        status: String,
        reason: String,
        date: String,
        time_zone: String,
    },
    Schedule {
        project_id: String,
        expected_plan_version: i64,
        entries: Vec<ScheduleEntry>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleEntry {
    pub task_id: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub dependencies: Vec<String>,
}
fn user(message: &str) -> String {
    format!("USER:{message}")
}
fn db_message(error: sqlx::Error) -> String {
    let text = error.to_string();
    text.rsplit(") ")
        .next()
        .filter(|message| message.starts_with('请'))
        .map(user)
        .unwrap_or(text)
}
impl Store {
    pub async fn project_workspace(&self, c: &WorkspaceCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "project_workspace",
            &payload,
        )
        .await?
        {
            return tx.commit().await.map_err(|e| e.to_string());
        }
        let project_event = match &c.action {
            WorkspaceAction::Lifecycle {
                project_id,
                expected_version,
                status,
                focused,
                arrangements,
                date,
            } => {
                validate_date(date)?;
                if !["draft", "active", "paused", "completed", "archived"]
                    .contains(&status.as_str())
                    || !["keep", "remove"].contains(&arrangements.as_str())
                {
                    return Err(user("项目状态或安排选择无效"));
                }
                let current: Option<i64> =
                    sqlx::query_scalar("SELECT version FROM projects WHERE id=? AND owner_id=?")
                        .bind(project_id)
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if current != Some(*expected_version) {
                    return Err("STATE_CONFLICT".into());
                }
                if arrangements == "remove" {
                    if !["paused", "archived"].contains(&status.as_str()) {
                        return Err(user("只有暂停或归档时可批量移出安排"));
                    }
                    // Completed facts and past commitments are immutable here.
                    sqlx::query("UPDATE tasks SET version=version+1 WHERE owner_id=? AND project_id=? AND status NOT IN('completed','cancelled') AND EXISTS(SELECT 1 FROM daily_plan_items p WHERE p.task_id=tasks.id AND p.owner_id=tasks.owner_id AND p.execution_date>=? AND p.is_summary=0 AND p.removed=0)").bind(&self.owner_id).bind(project_id).bind(date).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    sqlx::query("UPDATE daily_plan_items SET removed=1 WHERE owner_id=? AND is_summary=0 AND execution_date>=? AND task_id IN(SELECT id FROM tasks WHERE project_id=? AND owner_id=? AND status NOT IN('completed','cancelled'))").bind(&self.owner_id).bind(date).bind(project_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                sqlx::query("UPDATE projects SET status=?,focused=?,version=version+1,plan_version=plan_version+1 WHERE id=? AND owner_id=?").bind(status).bind(focused).bind(project_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                Some((project_id, "project_lifecycle"))
            }
            WorkspaceAction::Move {
                project_id,
                expected_plan_version,
                task_id,
                parent_task_id,
                before_task_id,
                confirm_summary_plan,
            } => {
                self.check_plan_version(&mut tx, project_id, *expected_plan_version)
                    .await?;
                let old: Option<Option<String>> = sqlx::query_scalar(
                    "SELECT parent_task_id FROM tasks WHERE id=? AND owner_id=? AND project_id=?",
                )
                .bind(task_id)
                .bind(&self.owner_id)
                .bind(project_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                let Some(old_parent) = old else {
                    return Err("STATE_CONFLICT".into());
                };
                if let Some(parent) = parent_task_id {
                    let target: Option<String> = sqlx::query_scalar(
                        "SELECT status FROM tasks WHERE id=? AND owner_id=? AND project_id=?",
                    )
                    .bind(parent)
                    .bind(&self.owner_id)
                    .bind(project_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if !target.is_some_and(|s| s == "todo" || s == "in_progress" || s == "blocked")
                    {
                        return Err(user("请选择同项目中未完成的父任务"));
                    }
                    let cycle:bool=sqlx::query_scalar("WITH RECURSIVE descendants(id) AS(SELECT ? UNION SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id=d.id WHERE t.owner_id=?) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=?)").bind(task_id).bind(&self.owner_id).bind(parent).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if cycle {
                        return Err(user("不能移入自己或自己的子任务"));
                    }
                    let dependency:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_dependencies WHERE owner_id=? AND (task_id=? OR predecessor_id=?))").bind(&self.owner_id).bind(parent).bind(parent).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if dependency {
                        return Err(user("目标父任务存在依赖，请先在甘特图移除其依赖关系"));
                    }
                    let planned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM daily_plan_items WHERE owner_id=? AND task_id=? AND is_summary=0 AND removed=0)").bind(&self.owner_id).bind(parent).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if planned && !*confirm_summary_plan {
                        return Err(user("请确认将目标父任务的已有安排转换为汇总记录"));
                    }
                    sqlx::query(
                        "UPDATE daily_plan_items SET is_summary=1 WHERE owner_id=? AND task_id=?",
                    )
                    .bind(&self.owner_id)
                    .bind(parent)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    sqlx::query("DELETE FROM project_schedules WHERE owner_id=? AND task_id=?")
                        .bind(&self.owner_id)
                        .bind(parent)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    sqlx::query("UPDATE tasks SET version=version+1 WHERE owner_id=? AND id=?")
                        .bind(&self.owner_id)
                        .bind(parent)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                let mut siblings:Vec<String>=sqlx::query_scalar("SELECT id FROM tasks WHERE owner_id=? AND project_id=? AND parent_task_id IS ? AND id<>? ORDER BY task_rank,created_at,rowid").bind(&self.owner_id).bind(project_id).bind(parent_task_id).bind(task_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                let index = match before_task_id {
                    Some(id) => siblings
                        .iter()
                        .position(|x| x == id)
                        .ok_or("STATE_CONFLICT")?,
                    None => siblings.len(),
                };
                siblings.insert(index, task_id.clone());
                sqlx::query(
                    "UPDATE tasks SET parent_task_id=?,version=version+1 WHERE id=? AND owner_id=?",
                )
                .bind(parent_task_id)
                .bind(task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                for (rank, id) in siblings.iter().enumerate() {
                    sqlx::query(
                        "UPDATE tasks SET task_rank=?,version=version+1 WHERE id=? AND owner_id=?",
                    )
                    .bind(rank as i64)
                    .bind(id)
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                if old_parent != *parent_task_id {
                    if let Some(old) = old_parent {
                        // A former summary becomes an unscheduled leaf. Historical summary plans stay historical.
                        sqlx::query("UPDATE tasks SET version=version+1 WHERE id=? AND owner_id=?")
                            .bind(old)
                            .bind(&self.owner_id)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                Some((project_id, "task_moved"))
            }
            WorkspaceAction::Status {
                task_id,
                expected_version,
                status,
                reason,
                date,
                time_zone,
            } => {
                validate_context(
                    [&c.operation_id, task_id, &c.operation_id],
                    date,
                    time_zone,
                    &c.occurred_at,
                )?;
                let current:Option<(i64,String,Option<String>,Option<String>,String)>=sqlx::query_as("SELECT version,CASE WHEN waiting=1 THEN 'waiting' ELSE status END,cancelled_from,cancelled_reason,status_reason FROM tasks WHERE id=? AND owner_id=?").bind(task_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                let Some((version, old, previous, previous_reason, old_reason)) = current else {
                    return Err("STATE_CONFLICT".into());
                };
                if version != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                let (target, reason) = if status == "restore" {
                    if old != "cancelled" {
                        return Err("STATE_CONFLICT".into());
                    }
                    (
                        previous.unwrap_or("todo".into()),
                        previous_reason.unwrap_or_default(),
                    )
                } else {
                    (status.clone(), reason.trim().to_string())
                };
                if ![
                    "todo",
                    "in_progress",
                    "blocked",
                    "waiting",
                    "completed",
                    "cancelled",
                ]
                .contains(&target.as_str())
                {
                    return Err(user("任务状态无效"));
                }
                if ["blocked", "cancelled"].contains(&target.as_str()) && reason.is_empty() {
                    return Err(user("请填写阻塞或取消原因"));
                }
                if old == target {
                    return Err(user("任务已处于该状态"));
                }
                if target == "cancelled" && old == "completed" {
                    return Err(user("请先撤销完成，再取消任务"));
                }
                self.apply_task_status(
                    &mut tx,
                    task_id,
                    if target == "waiting" { "todo" } else { &target },
                    &reason,
                    &c.operation_id,
                    date,
                    time_zone,
                    &c.occurred_at,
                    None,
                    true,
                )
                .await?;
                sqlx::query("UPDATE tasks SET waiting=? WHERE id=? AND owner_id=?")
                    .bind(target == "waiting")
                    .bind(task_id)
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                if target == "cancelled" {
                    sqlx::query("UPDATE tasks SET cancelled_from=?,cancelled_reason=? WHERE id=? AND owner_id=?").bind(&old).bind(&old_reason).bind(task_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                let event = if target == "completed" {
                    "task_completed"
                } else if old == "completed" {
                    "task_completion_undone"
                } else {
                    "task_status_changed"
                };
                sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,?,?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(task_id).bind(event).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                None
            }
            WorkspaceAction::Schedule {
                project_id,
                expected_plan_version,
                entries,
            } => {
                self.check_plan_version(&mut tx, project_id, *expected_plan_version)
                    .await?;
                let leaves:Vec<String>=sqlx::query_scalar("SELECT id FROM tasks t WHERE owner_id=? AND project_id=? AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.owner_id=t.owner_id AND c.parent_task_id=t.id)").bind(&self.owner_id).bind(project_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                let ids: HashSet<&String> = entries.iter().map(|e| &e.task_id).collect();
                if ids.len() != entries.len()
                    || ids.len() != leaves.len()
                    || leaves.iter().any(|id| !ids.contains(id))
                {
                    return Err("STATE_CONFLICT".into());
                }
                let by_id: HashMap<&str, &ScheduleEntry> =
                    entries.iter().map(|e| (e.task_id.as_str(), e)).collect();
                let mut visited = HashSet::new();
                let mut visiting = HashSet::new();
                for e in entries {
                    match (&e.start, &e.end) {
                        (Some(s), Some(end)) => {
                            validate_date(s)?;
                            validate_date(end)?;
                            if s > end {
                                return Err(user("结束日期不能早于开始日期"));
                            }
                        }
                        (None, None) => (),
                        _ => return Err(user("请同时设置开始和结束日期")),
                    }
                    check_dependencies(e, &by_id, &mut visited, &mut visiting)?;
                }
                // Replace the complete project graph atomically; failure restores the old graph.
                sqlx::query("DELETE FROM task_dependencies WHERE owner_id=? AND task_id IN(SELECT id FROM tasks WHERE project_id=? AND owner_id=?)").bind(&self.owner_id).bind(project_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("DELETE FROM project_schedules WHERE owner_id=? AND task_id IN(SELECT id FROM tasks WHERE project_id=? AND owner_id=?)").bind(&self.owner_id).bind(project_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                for e in entries {
                    sqlx::query("INSERT INTO project_schedules(owner_id,task_id,start_date,end_date) VALUES(?,?,?,?)").bind(&self.owner_id).bind(&e.task_id).bind(&e.start).bind(&e.end).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    for dependency in &e.dependencies {
                        sqlx::query("INSERT INTO task_dependencies(owner_id,task_id,predecessor_id) VALUES(?,?,?)").bind(&self.owner_id).bind(&e.task_id).bind(dependency).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    }
                }
                sqlx::query(
                    "UPDATE projects SET plan_version=plan_version+1 WHERE id=? AND owner_id=?",
                )
                .bind(project_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                Some((project_id, "schedule_changed"))
            }
        };
        if let Some((id, kind)) = project_event {
            sqlx::query("INSERT INTO project_events(id,owner_id,project_id,kind,occurred_at,payload) VALUES(?,?,?,?,?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(id).bind(kind).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
        self.queue_operation(
            &mut tx,
            &c.operation_id,
            "project_workspace",
            &payload,
            &c.occurred_at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    async fn check_plan_version(
        &self,
        tx: &mut Tx<'_>,
        project: &str,
        version: i64,
    ) -> StoreResult<()> {
        let actual: Option<i64> =
            sqlx::query_scalar("SELECT plan_version FROM projects WHERE id=? AND owner_id=?")
                .bind(project)
                .bind(&self.owner_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        if actual != Some(version) {
            return Err("STATE_CONFLICT".into());
        }
        Ok(())
    }
    // Daily completion and board transitions share this writer.
    // A parent can change board columns; that move does not create its own execution fact.
    pub(super) async fn apply_task_status(
        &self,
        tx: &mut Tx<'_>,
        task: &str,
        target: &str,
        reason: &str,
        operation: &str,
        date: &str,
        zone: &str,
        at: &str,
        preferred_plan: Option<&str>,
        allow_summary: bool,
    ) -> StoreResult<()> {
        let saved_plan: Option<String> =
            sqlx::query_scalar("SELECT plan_value FROM tasks WHERE id=? AND owner_id=?")
                .bind(task)
                .bind(&self.owner_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        let summary: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE owner_id=? AND parent_task_id=? AND deleted_at IS NULL AND status NOT IN ('completed','cancelled'))",
        )
        .bind(&self.owner_id)
        .bind(task)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if summary && !allow_summary {
            return Err("SUMMARY_TASK".into());
        }
        if summary {
            if ["in_progress", "completed"].contains(&target) {
                let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.predecessor_id AND p.owner_id=d.owner_id WHERE d.task_id=? AND d.owner_id=? AND p.status<>'completed')").bind(task).bind(&self.owner_id).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
                if blocked {
                    return Err(user("前置任务尚未完成，请先完成前置任务"));
                }
            }
            sqlx::query("UPDATE tasks SET status=?,status_reason=?,version=version+1 WHERE id=? AND owner_id=?").bind(target).bind(if target=="blocked"||target=="cancelled"{reason}else{""}).bind(task).bind(&self.owner_id).execute(&mut **tx).await.map_err(db_message)?;
            sqlx::query("UPDATE tasks SET plan_value=?,completed_at=? WHERE id=? AND owner_id=?")
                .bind(saved_plan)
                .bind(if target == "completed" {
                    Some(at)
                } else {
                    None
                })
                .bind(task)
                .bind(&self.owner_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        if ["in_progress", "completed"].contains(&target) {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.predecessor_id AND p.owner_id=d.owner_id WHERE d.task_id=? AND d.owner_id=? AND p.status<>'completed')").bind(task).bind(&self.owner_id).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
            if blocked {
                return Err(user("前置任务尚未完成，请先完成前置任务"));
            }
        }
        let active: Option<String> =
            sqlx::query_scalar("SELECT active_completion_id FROM tasks WHERE id=? AND owner_id=?")
                .bind(task)
                .bind(&self.owner_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        if let Some(id) = active {
            if target == "completed" {
                return Err("STATE_CONFLICT".into());
            }
            sqlx::query("UPDATE execution_records SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL").bind(at).bind(id).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        }
        let completion = if target == "completed" {
            let plan:Option<String>=sqlx::query_scalar("SELECT id FROM daily_plan_items WHERE task_id=? AND owner_id=? AND is_summary=0 AND removed=0 AND (? IS NULL OR id=?) ORDER BY created_at DESC LIMIT 1").bind(task).bind(&self.owner_id).bind(preferred_plan).bind(preferred_plan).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())?;
            let plan = match plan {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().to_string();
                    sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at,estimated_minutes) VALUES(?,?,?,?,?,?,(SELECT default_estimated_minutes FROM tasks WHERE id=? AND owner_id=?)) ON CONFLICT(owner_id,task_id,execution_date) DO UPDATE SET removed=0,is_summary=0").bind(&id).bind(&self.owner_id).bind(task).bind(date).bind(zone).bind(at).bind(task).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e|e.to_string())?;
                    let id: String = sqlx::query_scalar("SELECT id FROM daily_plan_items WHERE owner_id=? AND task_id=? AND execution_date=?").bind(&self.owner_id).bind(task).bind(date).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
                    // An undated Inbox task needs a history anchor, not a calendar arrangement.
                    if saved_plan.is_none() {
                        sqlx::query("UPDATE daily_plan_items SET removed=1 WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=daily_plan_items.task_id AND t.owner_id=daily_plan_items.owner_id AND t.project_id IS NULL)")
                            .bind(&id).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e|e.to_string())?;
                    }
                    id
                }
            };
            sqlx::query("INSERT INTO execution_records(id,owner_id,task_id,plan_id,execution_date,time_zone,occurred_at) VALUES(?,?,?,?,?,?,?)").bind(operation).bind(&self.owner_id).bind(task).bind(plan).bind(date).bind(zone).bind(at).execute(&mut **tx).await.map_err(|e|e.to_string())?;
            Some(operation)
        } else {
            None
        };
        sqlx::query("UPDATE tasks SET status=?,status_reason=?,active_completion_id=?,version=version+1 WHERE id=? AND owner_id=?").bind(target).bind(if target=="blocked"||target=="cancelled"{reason}else{""}).bind(completion).bind(task).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        sqlx::query("UPDATE tasks SET plan_value=?,completed_at=? WHERE id=? AND owner_id=?")
            .bind(saved_plan)
            .bind(if target == "completed" {
                Some(at)
            } else {
                None
            })
            .bind(task)
            .bind(&self.owner_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn check_dependencies<'a>(
    e: &'a ScheduleEntry,
    entries: &HashMap<&'a str, &'a ScheduleEntry>,
    done: &mut HashSet<&'a str>,
    visiting: &mut HashSet<&'a str>,
) -> StoreResult<()> {
    if done.contains(e.task_id.as_str()) {
        return Ok(());
    }
    if !visiting.insert(&e.task_id) {
        return Err(user("前置依赖不能形成循环"));
    }
    let mut unique = HashSet::new();
    for id in &e.dependencies {
        if !unique.insert(id) {
            return Err(user("前置依赖不能重复"));
        }
        let p = entries
            .get(id.as_str())
            .ok_or_else(|| user("依赖必须是同项目叶子任务"))?;
        check_dependencies(p, entries, done, visiting)?;
        if let (Some(start), Some(end)) = (&e.start, &p.end) {
            if start <= end {
                return Err(user("排期早于前置任务完成日期，请重新预览顺延方案"));
            }
        }
    }
    visiting.remove(e.task_id.as_str());
    done.insert(e.task_id.as_str());
    Ok(())
}
