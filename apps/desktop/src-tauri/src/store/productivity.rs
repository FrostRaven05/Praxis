use super::planning::{replay, validate_operation};
use super::*;
use serde_json::{json, Value};
type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeValue {
    Date {
        date: String,
    },
    Instant {
        at_utc: String,
        display_timezone: String,
    },
}
impl TimeValue {
    fn validate(&self) -> StoreResult<()> {
        match self {
            Self::Date { date } => validate_date(date),
            Self::Instant {
                at_utc,
                display_timezone,
            } => {
                DateTime::parse_from_rfc3339(at_utc).map_err(|_| "USER:无效时刻")?;
                display_timezone
                    .parse::<Tz>()
                    .map_err(|_| "USER:无效 IANA 时区")?;
                Ok(())
            }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductivityCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: ProductivityAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProductivityAction {
    Rollover {
        date: String,
        time_zone: String,
    },
    Zone {
        time_zone: String,
        expected_version: Option<i64>,
        expected_templates: Option<Vec<(String, i64)>>,
    },
    Task {
        id: String,
        expected_version: Option<i64>,
        title: String,
        notes: String,
        project_id: Option<String>,
        plan: Option<TimeValue>,
        deadline: Option<TimeValue>,
        follow_up: Option<TimeValue>,
        priority: i64,
        waiting_for: String,
        waiting_note: String,
        labels: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arrange_on_create: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    Label {
        id: String,
        name: String,
        expected_version: Option<i64>,
    },
    Day {
        date: String,
        outcome: String,
        closing: String,
        focus_ids: Vec<String>,
        expected_version: Option<i64>,
    },
    Status {
        id: String,
        expected_version: i64,
        status: String,
        confirm_related: bool,
        expected_tasks: Vec<(String, i64)>,
    },
    UndoStatus { id:String, expected_version:i64, original_operation_id:String, expected_tasks:Vec<(String,i64)> },
    Section {
        id: String,
        project_id: String,
        name: String,
        rank: i64,
        delete: bool,
        expected_version: Option<i64>,
    },
    Move {
        id: String,
        expected_version: i64,
        project_id: Option<String>,
        parent_id: Option<String>,
        section_id: Option<String>,
        confirm_count: i64,
        expected_tasks: Vec<(String, i64)>,
    },
    Reorder {
        parent_id: String,
        ordered_ids: Vec<String>,
    },
    Project {
        id: String,
        expected_version: i64,
        status: String,
        archive: bool,
        focused: bool,
        cancel_remaining: bool,
        expected_plan_version: i64,
    },
}
fn encoded(v: &Option<TimeValue>) -> Option<String> {
    v.as_ref().map(|v| match v { TimeValue::Instant{at_utc,display_timezone} => json!({"kind":"instant","atUtc":DateTime::parse_from_rfc3339(at_utc).unwrap().with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::AutoSi,true),"displayTimezone":display_timezone}).to_string(), _=>serde_json::to_string(v).unwrap() })
}
fn limited(s: &str, n: usize) -> StoreResult<()> {
    if s.chars().count() > n {
        Err("USER:内容超出长度限制".into())
    } else {
        Ok(())
    }
}
async fn version(tx: &mut Tx<'_>, sql: &str, id: &str, expected: Option<i64>) -> StoreResult<()> {
    let v: Option<i64> = sqlx::query_scalar(sql)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if v != expected {
        return Err("STATE_CONFLICT".into());
    }
    Ok(())
}
impl Store {
    /// Set a first-use default atomically; never change an existing workspace or its rules.
    pub async fn initialize_workspace_zone(&self, time_zone: &str) -> StoreResult<()> {
        time_zone.parse::<Tz>().map_err(|_| "USER:无法识别设备时区")?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let inserted = sqlx::query("INSERT INTO workspace_settings(owner_id,time_zone) VALUES(?,?) ON CONFLICT(owner_id) DO NOTHING")
            .bind(&self.owner_id).bind(time_zone).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
        if inserted == 1 {
            let c = ProductivityCommand {
                operation_id: Uuid::new_v4().to_string(),
                occurred_at: chrono::Utc::now().to_rfc3339(),
                action: ProductivityAction::Zone {
                    time_zone: time_zone.into(), expected_version: None, expected_templates: None,
                },
            };
            let payload = serde_json::to_string(&c).map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO content_events(id,owner_id,entity_id,kind,occurred_at,payload) VALUES(?,?,?,'productivity',?,?)")
                .bind(&c.operation_id).bind(&self.owner_id).bind(&self.owner_id).bind(&c.occurred_at).bind(&payload)
                .execute(&mut *tx).await.map_err(|e| e.to_string())?;
            self.queue_operation(&mut tx, &c.operation_id, "productivity", &payload, &c.occurred_at).await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }

    pub async fn productivity_snapshot(&self) -> StoreResult<Value> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let specs=[
        ("settings","SELECT json_object('timeZone',time_zone,'version',version) FROM workspace_settings WHERE owner_id=?"),
        ("tasks","SELECT json_object('id',t.id,'title',title,'notes',notes,'completionCriteria',completion_criteria,'projectId',project_id,'parentId',parent_task_id,'sectionId',section_id,'rawStatus',status,'waiting',json(CASE WHEN waiting=1 THEN 'true' ELSE 'false' END),'statusReason',status_reason,'status',CASE WHEN waiting=1 AND status NOT IN('completed','cancelled') THEN 'waiting' ELSE status END,'version',version,'plan',json(plan_value),'deadline',json(deadline_value),'followUp',json(follow_up_value),'priority',priority_level,'important',important,'waitingFor',waiting_for,'waitingNote',waiting_note,'completedAt',completed_at,'createdAt',created_at,'rank',task_rank,'labels',json((SELECT json_group_array(label_id) FROM task_labels WHERE task_id=t.id))) FROM tasks t WHERE owner_id=? AND deleted_at IS NULL ORDER BY task_rank,created_at,id"),
        ("projects","SELECT json_object('id',p.id,'name',p.name,'outcome',p.outcome,'targetDate',p.target_date,'createdAt',p.created_at,'updatedAt',(SELECT at FROM (SELECT p.created_at AS at UNION ALL SELECT occurred_at FROM project_events WHERE owner_id=p.owner_id AND project_id=p.id UNION ALL SELECT occurred_at FROM content_events WHERE owner_id=p.owner_id AND entity_id=p.id UNION ALL SELECT updated_at FROM lan_entities WHERE id=p.id AND kind='project') ORDER BY julianday(at) DESC LIMIT 1),'status',CASE WHEN p.canceled=1 THEN 'cancelled' ELSE p.status END,'version',p.version,'planVersion',p.plan_version,'focused',p.focused,'archivedAt',p.archived_at) FROM projects p WHERE p.owner_id=? AND p.deleted_at IS NULL ORDER BY p.created_at,p.id"),
        ("sections","SELECT json_object('id',s.id,'projectId',project_id,'name',s.name,'rank',rank,'version',s.version) FROM sections s JOIN projects p ON p.id=s.project_id WHERE p.owner_id=? AND p.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY rank,s.id"),
        ("labels","SELECT json_object('id',id,'name',name,'version',version) FROM labels WHERE owner_id=? ORDER BY name,id"),
        ("days","SELECT json_object('date',date,'outcome',outcome,'closing',closing,'focusIds',json(focus_ids),'version',version) FROM day_notes WHERE owner_id=?"),
        ("legacyPlans","SELECT json_object('taskId',task_id,'date',execution_date,'focus',is_focus,'rank',focus_rank) FROM daily_plan_items WHERE owner_id=? AND removed=0 AND is_summary=0"),
        ("events","SELECT json_object('id',id,'entityId',entity_id,'occurredAt',occurred_at,'payload',json(payload)) FROM content_events WHERE owner_id=? AND kind='productivity' ORDER BY rowid DESC")];
        let mut result = json!({});
        for (key, sql) in specs {
            let rows: Vec<String> = sqlx::query_scalar(sql)
                .bind(&self.owner_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            result[key] = Value::Array(
                rows.into_iter()
                    .map(|s| serde_json::from_str(&s).unwrap())
                    .collect(),
            );
        }
        result["migrationReport"] = json!(sqlx::query_scalar::<_, String>(
            "SELECT report FROM migration_reports WHERE version=11"
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?);
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub async fn productivity_command(&self, c: &ProductivityCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "productivity",
            &payload,
        )
        .await?
        {
            return Ok(());
        }
        let entity: String;
        let mut event_payload:Value=serde_json::from_str(&payload).map_err(|e|e.to_string())?;
        match &c.action {
            ProductivityAction::Rollover { date, time_zone } => {
                if self
                    .apply_rollover(&mut tx, date, time_zone, &c.occurred_at)
                    .await?
                    == 0
                {
                    return tx.commit().await.map_err(|e| e.to_string());
                }
                entity = self.owner_id.clone();
            }
            ProductivityAction::Zone {
                time_zone,
                expected_version,
                expected_templates,
            } => {
                time_zone
                    .parse::<Tz>()
                    .map_err(|_| "USER:请输入有效 IANA 时区，例如 Asia/Shanghai")?;
                version(
                    &mut tx,
                    "SELECT version FROM workspace_settings WHERE owner_id=?",
                    &self.owner_id,
                    *expected_version,
                )
                .await?;
                super::recurrence::change_zone(
                    &mut tx,
                    &self.owner_id,
                    time_zone,
                    &c.occurred_at,
                    expected_templates,
                )
                .await?;
                sqlx::query("INSERT INTO workspace_settings(owner_id,time_zone) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET time_zone=excluded.time_zone,version=workspace_settings.version+1").bind(&self.owner_id).bind(time_zone).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = self.owner_id.clone();
            }
            ProductivityAction::Task {
                id,
                expected_version,
                title,
                notes,
                project_id,
                plan,
                deadline,
                follow_up,
                priority,
                waiting_for,
                waiting_note,
                labels,
                arrange_on_create,
                parent_id,
            } => {
                Uuid::parse_str(id).map_err(|_| "Invalid task ID")?;
                limited(title, 500)?;
                limited(notes, 100000)?;
                limited(waiting_for, 500)?;
                limited(waiting_note, 100000)?;
                if title.trim().is_empty() || !(1..=4).contains(priority) || labels.len() > 100 {
                    return Err("USER:请检查标题、优先级与标签".into());
                }
                for v in [plan, deadline, follow_up].into_iter().flatten() {
                    v.validate()?;
                }
                version(
                    &mut tx,
                    "SELECT version FROM tasks WHERE id=? AND deleted_at IS NULL",
                    id,
                    *expected_version,
                )
                .await?;
                if let Some(p) = project_id {
                    self.productivity_project_exists(&mut tx, p).await?;
                }
                if expected_version.is_none() {
                    if let Some(project) = project_id {
                        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_id=? AND status='active' AND canceled=0 AND archived_at IS NULL AND deleted_at IS NULL)")
                            .bind(project).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                        if !active { return Err("USER:请先恢复项目，再添加任务".into()); }
                    }
                    sqlx::query("INSERT INTO tasks(id,owner_id,title,notes,project_id,source,created_at) VALUES(?,?,?,?,?,'temporary',?)").bind(id).bind(&self.owner_id).bind(title.trim()).bind(notes).bind(project_id).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    if let Some(parent) = parent_id {
                        if parent == id {
                            return Err("USER:不能把任务设为自己的子任务".into());
                        }
                        let found: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as("SELECT project_id, section_id, parent_task_id FROM tasks WHERE id=? AND owner_id=? AND deleted_at IS NULL").bind(parent).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                        let Some((parent_project, parent_section, parent_parent)) = found else {
                            return Err("USER:父任务不存在".into());
                        };
                        if parent_parent.is_some() {
                            return Err("USER:子任务不能再拆子任务".into());
                        }
                        if parent_project != *project_id {
                            return Err("USER:子任务必须与父任务属于同一项目".into());
                        }
                        let next_rank: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(task_rank),-1)+1 FROM tasks WHERE owner_id=? AND parent_task_id=? AND deleted_at IS NULL AND id<>?").bind(&self.owner_id).bind(parent).bind(id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                        sqlx::query("UPDATE tasks SET parent_task_id=?, section_id=?, task_rank=? WHERE id=? AND owner_id=?").bind(parent).bind(parent_section).bind(next_rank).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                    }
                } else {
                    let old: Option<String> = sqlx::query_scalar(
                        "SELECT project_id FROM tasks WHERE id=? AND owner_id=?",
                    )
                    .bind(id)
                    .bind(&self.owner_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if old != *project_id {
                        return Err("USER:请使用移动操作预览父子任务影响".into());
                    }
                }
                for label in labels {
                    let exists: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM labels WHERE id=? AND owner_id=?)",
                    )
                    .bind(label)
                    .bind(&self.owner_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if !exists {
                        return Err("USER:标签已失效".into());
                    }
                }
                // Write legacy instant first; the compatibility trigger runs before the typed value is restored.
                let (legacy, zone) = match deadline {
                    Some(TimeValue::Instant {
                        at_utc,
                        display_timezone,
                    }) => (Some(at_utc), Some(display_timezone)),
                    _ => (None, None),
                };
                sqlx::query(
                    "UPDATE tasks SET deadline=?,deadline_time_zone=? WHERE id=? AND owner_id=?",
                )
                .bind(legacy)
                .bind(zone)
                .bind(id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                sqlx::query("UPDATE tasks SET title=?,notes=?,plan_value=?,deadline_value=?,follow_up_value=?,priority_level=?,waiting_for=?,waiting_note=?,version=version+1 WHERE id=? AND owner_id=?").bind(title.trim()).bind(notes).bind(encoded(plan)).bind(encoded(deadline)).bind(encoded(follow_up)).bind(priority).bind(waiting_for).bind(waiting_note).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("DELETE FROM task_labels WHERE task_id=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                for label in labels {
                    sqlx::query("INSERT OR IGNORE INTO task_labels VALUES(?,?)")
                        .bind(id)
                        .bind(label)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                if expected_version.is_none() && *arrange_on_create == Some(true) {
                    if let Some(plan) = plan {
                        let zone: String = sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                            .bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                        let date = match plan {
                            TimeValue::Date { date } => date.clone(),
                            TimeValue::Instant { at_utc, .. } => DateTime::parse_from_rfc3339(at_utc).map_err(|e| e.to_string())?
                                .with_timezone(&zone.parse::<Tz>().map_err(|e| e.to_string())?).date_naive().to_string(),
                        };
                        sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES(?,?,?,?,?,?)")
                            .bind(Uuid::new_v4().to_string()).bind(&self.owner_id).bind(id).bind(date).bind(zone).bind(&c.occurred_at)
                            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
                        sqlx::query("UPDATE tasks SET plan_value=? WHERE id=? AND owner_id=?")
                            .bind(encoded(&Some(plan.clone()))).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                    }
                }
                entity = id.clone();
            }
            ProductivityAction::Label {
                id,
                name,
                expected_version,
            } => {
                limited(name, 100)?;
                if name.trim().is_empty() {
                    return Err("USER:请输入标签名称".into());
                }
                version(
                    &mut tx,
                    "SELECT version FROM labels WHERE id=?",
                    id,
                    *expected_version,
                )
                .await?;
                sqlx::query("INSERT INTO labels(id,owner_id,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=labels.version+1").bind(id).bind(&self.owner_id).bind(name.trim()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = id.clone();
            }
            ProductivityAction::Day {
                date,
                outcome,
                closing,
                focus_ids,
                expected_version,
            } => {
                validate_date(date)?;
                limited(outcome, 100000)?;
                limited(closing, 100000)?;
                if focus_ids.len() > 1000 {
                    return Err("USER:重点数量过多".into());
                }
                let v: Option<i64> =
                    sqlx::query_scalar("SELECT version FROM day_notes WHERE owner_id=? AND date=?")
                        .bind(&self.owner_id)
                        .bind(date)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if v != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                let mut seen = std::collections::HashSet::new();
                for id in focus_ids {
                    if !seen.insert(id) {
                        return Err("USER:重复重点引用".into());
                    }
                    self.productivity_task_exists(&mut tx, id).await?;
                }
                sqlx::query("INSERT INTO day_notes(owner_id,date,outcome,closing,focus_ids) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,date) DO UPDATE SET outcome=excluded.outcome,closing=excluded.closing,focus_ids=excluded.focus_ids,version=day_notes.version+1").bind(&self.owner_id).bind(date).bind(outcome).bind(closing).bind(serde_json::to_string(focus_ids).unwrap()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = date.clone();
            }
            ProductivityAction::Status {
                id,
                expected_version,
                status,
                confirm_related,
                expected_tasks,
            } => {
                let before:Option<String>=sqlx::query_scalar("SELECT json_object('status',status,'waiting',waiting,'statusReason',status_reason,'completedAt',completed_at,'completionId',active_completion_id) FROM tasks WHERE id=? AND owner_id=? AND deleted_at IS NULL").bind(id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                self.productivity_check_tasks(&mut tx, expected_tasks)
                    .await?;
                version(
                    &mut tx,
                    "SELECT version FROM tasks WHERE id=? AND deleted_at IS NULL",
                    id,
                    Some(*expected_version),
                )
                .await?;
                if ![
                    "todo",
                    "in_progress",
                    "blocked",
                    "waiting",
                    "completed",
                    "cancelled",
                ]
                .contains(&status.as_str())
                {
                    return Err("USER:无效状态".into());
                }
                let terminal = ["completed", "cancelled"].contains(&status.as_str());
                let descendants:Vec<String>=sqlx::query_scalar("WITH RECURSIVE tree(id,depth) AS(SELECT id,0 FROM tasks WHERE id=? UNION ALL SELECT t.id,tree.depth+1 FROM tasks t JOIN tree ON t.parent_task_id=tree.id WHERE t.deleted_at IS NULL) SELECT id FROM tree ORDER BY depth DESC").bind(id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                if terminal {
                    for child in &descendants {
                        if child == id {
                            continue;
                        }
                        let state: String =
                            sqlx::query_scalar("SELECT status FROM tasks WHERE id=?")
                                .bind(child)
                                .fetch_one(&mut *tx)
                                .await
                                .map_err(|e| e.to_string())?;
                        if !["completed", "cancelled"].contains(&state.as_str()) {
                            if !confirm_related {
                                return Err("USER:请预览并确认处理未结束子任务".into());
                            }
                            self.productivity_status(&mut tx, child, status, c).await?;
                        }
                    }
                } else {
                    let project: Option<String> =
                        sqlx::query_scalar("SELECT project_id FROM tasks WHERE id=?")
                            .bind(id)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    if let Some(p) = project {
                        let ended:bool=sqlx::query_scalar("SELECT status IN('completed','archived') OR canceled=1 OR archived_at IS NOT NULL FROM projects WHERE id=?").bind(&p).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                        if ended {
                            if !confirm_related {
                                return Err("USER:请确认重开项目并取消归档".into());
                            }
                            sqlx::query("UPDATE projects SET status='active',canceled=0,archived_at=NULL,version=version+1 WHERE id=?").bind(p).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                        }
                    }
                    let ancestors:Vec<String>=sqlx::query_scalar("WITH RECURSIVE a(id,parent,depth) AS(SELECT id,parent_task_id,0 FROM tasks WHERE id=(SELECT parent_task_id FROM tasks WHERE id=?) UNION ALL SELECT t.id,t.parent_task_id,a.depth+1 FROM tasks t JOIN a ON t.id=a.parent) SELECT id FROM a ORDER BY depth DESC").bind(id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                    for parent in ancestors {
                        let ended: bool = sqlx::query_scalar(
                            "SELECT status IN('completed','cancelled') FROM tasks WHERE id=?",
                        )
                        .bind(&parent)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                        if ended {
                            if !confirm_related {
                                return Err("USER:请确认一并重开父任务".into());
                            }
                            self.productivity_status(&mut tx, &parent, "todo", c)
                                .await?;
                        }
                    }
                }
                self.productivity_status(&mut tx, id, status, c).await?;
                let after:i64=sqlx::query_scalar("SELECT version FROM tasks WHERE id=? AND owner_id=?").bind(id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                event_payload["personalUndo"]=json!({"before":serde_json::from_str::<Value>(&before.ok_or("USER:任务不存在")?).map_err(|e|e.to_string())?,"afterVersion":after});
                entity = id.clone();
            }
            ProductivityAction::UndoStatus{id,expected_version,original_operation_id,expected_tasks}=>{
                self.productivity_check_tasks(&mut tx,expected_tasks).await?;
                version(&mut tx,"SELECT version FROM tasks WHERE id=? AND deleted_at IS NULL",id,Some(*expected_version)).await?;
                let original:Option<String>=sqlx::query_scalar("SELECT payload FROM content_events WHERE id=? AND owner_id=? AND entity_id=? AND kind='productivity'").bind(original_operation_id).bind(&self.owner_id).bind(id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                let original:Value=serde_json::from_str(&original.ok_or("USER:撤销凭据不存在，请使用任务状态操作")?).map_err(|e|e.to_string())?;
                if original["action"]["type"]!="status" || original["personalUndo"]["afterVersion"]!=json!(expected_version){return Err("STATE_CONFLICT:任务已有后续编辑，不能撤销".into());}
                let before=&original["personalUndo"]["before"];
                let current:Option<String>=sqlx::query_scalar("SELECT active_completion_id FROM tasks WHERE id=? AND owner_id=?").bind(id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                if let Some(completion)=current {sqlx::query("UPDATE execution_records SET revoked_at=? WHERE id=? AND owner_id=?").bind(&c.occurred_at).bind(completion).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;}
                if let Some(completion)=before["completionId"].as_str(){
                    let restored=sqlx::query("UPDATE execution_records SET revoked_at=NULL WHERE id=? AND task_id=? AND owner_id=?").bind(completion).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                    if restored!=1{return Err("STATE_CONFLICT:原完成记录已变化".into());}
                }
                sqlx::query("UPDATE tasks SET status=?,waiting=?,status_reason=?,completed_at=?,active_completion_id=?,version=version+1 WHERE id=? AND owner_id=?")
                    .bind(before["status"].as_str().ok_or("Invalid undo state")?).bind(before["waiting"].as_i64().unwrap_or(0)).bind(before["statusReason"].as_str().unwrap_or(""))
                    .bind(before["completedAt"].as_str()).bind(before["completionId"].as_str()).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                // Status compatibility triggers may fill a missing terminal time. Undo restores the original fact afterward.
                sqlx::query("UPDATE tasks SET completed_at=?,waiting=? WHERE id=? AND owner_id=?").bind(before["completedAt"].as_str()).bind(before["waiting"].as_i64().unwrap_or(0)).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity=id.clone();
            }
            ProductivityAction::Section {
                id,
                project_id,
                name,
                rank,
                delete,
                expected_version,
            } => {
                self.productivity_project_exists(&mut tx, project_id)
                    .await?;
                version(
                    &mut tx,
                    "SELECT version FROM sections WHERE id=?",
                    id,
                    *expected_version,
                )
                .await?;
                limited(name, 500)?;
                let current_project: Option<String> =
                    sqlx::query_scalar("SELECT project_id FROM sections WHERE id=?")
                        .bind(id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if current_project.as_ref().is_some_and(|p| p != project_id) {
                    return Err("USER:分区不属于该项目".into());
                }
                if *delete {
                    sqlx::query(
                        "UPDATE tasks SET section_id=NULL,version=version+1 WHERE section_id=?",
                    )
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    sqlx::query("DELETE FROM sections WHERE id=? AND project_id=?")
                        .bind(id)
                        .bind(project_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    if name.trim().is_empty() || *rank < 0 {
                        return Err("USER:请检查分区名称和顺序".into());
                    }
                    sqlx::query("INSERT INTO sections(id,project_id,name,rank) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,rank=excluded.rank,version=sections.version+1 WHERE project_id=excluded.project_id").bind(id).bind(project_id).bind(name.trim()).bind(rank).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                entity = id.clone();
            }
            ProductivityAction::Move {
                id,
                expected_version,
                project_id,
                parent_id,
                section_id,
                confirm_count,
                expected_tasks,
            } => {
                self.productivity_check_tasks(&mut tx, expected_tasks)
                    .await?;
                version(
                    &mut tx,
                    "SELECT version FROM tasks WHERE id=? AND deleted_at IS NULL",
                    id,
                    Some(*expected_version),
                )
                .await?;
                if let Some(p) = project_id {
                    self.productivity_project_exists(&mut tx, p).await?;
                    let ended:bool=sqlx::query_scalar("SELECT status IN('completed','archived') OR canceled=1 OR archived_at IS NOT NULL FROM projects WHERE id=?").bind(p).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if ended {
                        return Err("USER:目标项目必须先重开".into());
                    }
                }
                let tree:Vec<(String,Option<String>)>=sqlx::query_as("WITH RECURSIVE tree(id,parent,depth) AS(SELECT id,parent_task_id,0 FROM tasks WHERE id=? UNION ALL SELECT t.id,t.parent_task_id,tree.depth+1 FROM tasks t JOIN tree ON t.parent_task_id=tree.id) SELECT id,parent FROM tree ORDER BY depth").bind(id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                if tree.len() as i64 != *confirm_count {
                    return Err("USER:任务数量已改变，请重新预览".into());
                }
                let mut section = section_id.clone();
                if let Some(parent) = parent_id {
                    if tree.iter().any(|(i, _)| i == parent) {
                        return Err("USER:不能循环引用".into());
                    }
                    self.productivity_task_exists(&mut tx, parent).await?;
                    let (p, s, state): (Option<String>, Option<String>, String) =
                        sqlx::query_as("SELECT project_id,section_id,status FROM tasks WHERE id=?")
                            .bind(parent)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    if p != *project_id || ["completed", "cancelled"].contains(&state.as_str()) {
                        return Err("USER:父任务须属于相同项目且尚未结束".into());
                    }
                    section = s;
                }
                if let Some(s) = &section {
                    let p: Option<String> =
                        sqlx::query_scalar("SELECT project_id FROM sections WHERE id=?")
                            .bind(s)
                            .fetch_optional(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    if p != *project_id || p.is_none() {
                        return Err("USER:分区不属于目标项目".into());
                    }
                }
                // Detach bottom-up, then rebuild top-down so every intermediate row satisfies existing FK guards.
                for (i, _) in tree.iter().rev() {
                    sqlx::query("UPDATE tasks SET parent_task_id=NULL WHERE id=?")
                        .bind(i)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                for (i, old_parent) in &tree {
                    let old: Option<String> =
                        sqlx::query_scalar("SELECT project_id FROM tasks WHERE id=?")
                            .bind(i)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    if old != *project_id {
                        let deps:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=? OR predecessor_id=?)").bind(i).bind(i).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                        if deps {
                            return Err("USER:跨项目移动前请解除甘特依赖".into());
                        }
                    }
                    sqlx::query("UPDATE tasks SET project_id=?,parent_task_id=?,section_id=?,version=version+1 WHERE id=?").bind(project_id).bind(if i==id{parent_id}else{old_parent}).bind(&section).bind(i).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                entity = id.clone();
            }
            ProductivityAction::Reorder {
                parent_id,
                ordered_ids,
            } => {
                if ordered_ids.is_empty() || ordered_ids.len() > 100 {
                    return Err("USER:子任务数量无效".into());
                }
                let mut unique = ordered_ids.clone();
                unique.sort();
                unique.dedup();
                if unique.len() != ordered_ids.len() {
                    return Err("USER:子任务顺序重复".into());
                }
                let parent_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND owner_id=? AND deleted_at IS NULL AND parent_task_id IS NULL)").bind(parent_id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                if !parent_ok {
                    return Err("USER:父任务不存在".into());
                }
                let mut current: Vec<String> = sqlx::query_scalar("SELECT id FROM tasks WHERE owner_id=? AND parent_task_id=? AND deleted_at IS NULL AND status<>'cancelled' ORDER BY task_rank,created_at,id").bind(&self.owner_id).bind(parent_id).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
                current.sort();
                if current != unique {
                    return Err("STATE_CONFLICT".into());
                }
                for (rank, child) in ordered_ids.iter().enumerate() {
                    sqlx::query("UPDATE tasks SET task_rank=?,version=version+1 WHERE id=? AND owner_id=?").bind(rank as i64).bind(child).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                }
                entity = parent_id.clone();
            }
            ProductivityAction::Project {
                id,
                expected_version,
                status,
                archive,
                focused,
                cancel_remaining,
                expected_plan_version,
            } => {
                self.productivity_project_exists(&mut tx, id).await?;
                version(
                    &mut tx,
                    "SELECT version FROM projects WHERE id=?",
                    id,
                    Some(*expected_version),
                )
                .await?;
                version(
                    &mut tx,
                    "SELECT plan_version FROM projects WHERE id=?",
                    id,
                    Some(*expected_plan_version),
                )
                .await?;
                if !["active", "paused", "completed", "cancelled"].contains(&status.as_str()) {
                    return Err("USER:无效项目状态".into());
                }
                let ended = ["completed", "cancelled"].contains(&status.as_str());
                if *archive && !ended {
                    return Err("USER:仅结束项目可归档".into());
                }
                if ended {
                    let remaining:Vec<String>=sqlx::query_scalar("WITH RECURSIVE tree(id,depth) AS(SELECT id,0 FROM tasks WHERE project_id=? AND parent_task_id IS NULL UNION ALL SELECT t.id,tree.depth+1 FROM tasks t JOIN tree ON t.parent_task_id=tree.id) SELECT t.id FROM tree JOIN tasks t ON t.id=tree.id WHERE t.deleted_at IS NULL AND t.status NOT IN('completed','cancelled') ORDER BY depth DESC").bind(id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                    if !remaining.is_empty() && !*cancel_remaining {
                        return Err("USER:请先移动剩余任务或明确确认批量取消".into());
                    }
                    for task in remaining {
                        self.productivity_status(&mut tx, &task, "cancelled", c)
                            .await?;
                    }
                }
                sqlx::query("UPDATE projects SET status=?,canceled=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,focused=?,version=version+1 WHERE id=?").bind(if status=="cancelled"{"completed"}else{status}).bind(status=="cancelled").bind(archive).bind(&c.occurred_at).bind(focused).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = id.clone();
            }
        }
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(entity)
            .bind("productivity")
            .bind(&c.occurred_at)
            .bind(event_payload.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_operation(
            &mut tx,
            &c.operation_id,
            "productivity",
            &payload,
            &c.occurred_at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    async fn productivity_check_tasks(
        &self,
        tx: &mut Tx<'_>,
        expected: &[(String, i64)],
    ) -> StoreResult<()> {
        let actual: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id,version FROM tasks WHERE owner_id=? AND deleted_at IS NULL ORDER BY id",
        )
        .bind(&self.owner_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let mut sorted = expected.to_vec();
        sorted.sort();
        if actual != sorted {
            return Err("STATE_CONFLICT:任务已改变，请重新预览".into());
        }
        Ok(())
    }
    async fn productivity_project_exists(&self, tx: &mut Tx<'_>, id: &str) -> StoreResult<()> {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL)")
                .bind(id)
                .bind(&self.owner_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        if !exists {
            return Err("USER:项目不存在".into());
        }
        Ok(())
    }
    async fn productivity_task_exists(&self, tx: &mut Tx<'_>, id: &str) -> StoreResult<()> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND owner_id=? AND deleted_at IS NULL)",
        )
        .bind(id)
        .bind(&self.owner_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if !exists {
            return Err("USER:任务不存在".into());
        }
        Ok(())
    }
    async fn productivity_status(
        &self,
        tx: &mut Tx<'_>,
        id: &str,
        status: &str,
        c: &ProductivityCommand,
    ) -> StoreResult<()> {
        self.productivity_task_exists(tx, id).await?;
        let zone: String =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("USER:请先确认工作空间时区")?;
        let date = DateTime::parse_from_rfc3339(&c.occurred_at)
            .unwrap()
            .with_timezone(&zone.parse::<Tz>().unwrap())
            .format("%Y-%m-%d")
            .to_string();
        let saved_plan: Option<String> =
            sqlx::query_scalar("SELECT plan_value FROM tasks WHERE id=?")
                .bind(id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        let target = if status == "waiting" { "todo" } else { status };
        let (old,summary):(String,bool)=sqlx::query_as("SELECT status,EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=tasks.id AND child.deleted_at IS NULL) FROM tasks WHERE id=?").bind(id).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
        if old == "completed" && target == "completed" {
            return Ok(());
        }
        if old != target {
            if summary {
                sqlx::query(
                    "UPDATE tasks SET status=?,completed_at=?,version=version+1 WHERE id=?",
                )
                .bind(target)
                .bind(if target == "completed" {
                    Some(&c.occurred_at)
                } else {
                    None
                })
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            } else {
                self.apply_task_status(
                    tx,
                    id,
                    target,
                    "用户明确变更",
                    &Uuid::new_v4().to_string(),
                    &date,
                    &zone,
                    &c.occurred_at,
                    None,
                    false,
                )
                .await?;
            }
        }
        sqlx::query("UPDATE tasks SET plan_value=?,completed_at=CASE WHEN status='completed' THEN ? ELSE NULL END WHERE id=?").bind(saved_plan).bind(&c.occurred_at).bind(id).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        sqlx::query("UPDATE tasks SET waiting=?,version=version+1 WHERE id=?")
            .bind(status == "waiting")
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
