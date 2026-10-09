use super::planning::{replay, validate_operation};
use super::*;
use serde_json::{json, Value};
type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: TrashAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrashAction {
    Settings {
        recovery_days: i64,
        expected_version: i64,
    },
    Delete {
        target_type: String,
        id: String,
        expected_version: i64,
        mode: String,
        confirm_all: bool,
        expected_tasks: Vec<(String, i64)>,
    },
    Restore {
        batch_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct TaskState {
    id: String,
    title: String,
    version: i64,
    project_id: Option<String>,
    parent_task_id: Option<String>,
    section_id: Option<String>,
}
async fn tasks(tx: &mut Tx<'_>, owner: &str) -> StoreResult<Vec<TaskState>> {
    sqlx::query_as("SELECT id,title,version,project_id,parent_task_id,section_id FROM tasks WHERE owner_id=? AND deleted_at IS NULL ORDER BY id")
        .bind(owner).fetch_all(&mut **tx).await.map_err(|e| e.to_string())
}
async fn run(tx: &mut Tx<'_>, sql: &str, id: &str) -> StoreResult<()> {
    sqlx::query(sql)
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
async fn retention(tx: &mut Tx<'_>, owner: &str) -> StoreResult<(i64, i64)> {
    Ok(
        sqlx::query_as("SELECT recovery_days,version FROM trash_settings WHERE owner_id=?")
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or((30, 0)),
    )
}
fn expires_at(started: &str, days: i64) -> StoreResult<chrono::DateTime<chrono::Utc>> {
    DateTime::parse_from_rfc3339(started)
        .map_err(|_| "USER:恢复时间记录无效".to_string())?
        .with_timezone(&chrono::Utc)
        .checked_add_signed(chrono::Duration::days(days))
        .ok_or_else(|| "USER:恢复时间超出范围".into())
}
impl Store {
    pub async fn trash_snapshot(&self) -> StoreResult<Value> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let active = tasks(&mut tx, &self.owner_id).await?;
        let (days, version) = retention(&mut tx, &self.owner_id).await?;
        let now = chrono::Utc::now();
        let projects:Vec<String>=sqlx::query_scalar("SELECT json_object('id',id,'title',name,'version',version,'templateCount',(SELECT count(*) FROM recurrence_templates WHERE project_id=projects.id AND enabled=1),'linkCount',(SELECT count(*) FROM record_links WHERE target_type='project' AND target_id=projects.id)) FROM projects WHERE owner_id=? AND deleted_at IS NULL ORDER BY name,id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let entries:Vec<String>=sqlx::query_scalar("SELECT json_object('id',id,'targetType',target_type,'title',title,'deletedAt',deleted_at,'recoveryStartedAt',recovery_started_at,'taskCount',json_array_length(payload,'$.deletedIds')) FROM trash_batches WHERE owner_id=? AND restored_at IS NULL ORDER BY deleted_at DESC,id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let entries: Vec<Value> = entries
            .into_iter()
            .map(|entry| {
                let mut value: Value = serde_json::from_str(&entry).map_err(|e| e.to_string())?;
                let expires = expires_at(
                    value["recoveryStartedAt"]
                        .as_str()
                        .ok_or("Missing recovery time")?,
                    days,
                )?;
                value["expiresAt"] =
                    json!(expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                value["canRestore"] = json!(now < expires);
                Ok::<Value, String>(value)
            })
            .collect::<Result<_, _>>()?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(
            json!({"tasks":active,"projects":projects.into_iter().map(|v|serde_json::from_str::<Value>(&v).unwrap()).collect::<Vec<_>>(),"entries":entries,"settings":{"recoveryDays":days,"version":version},"recoveryPolicy":"本地恢复窗口默认30天，可调整为1至3650天；按当前设置从删除时起计算。到期不可恢复，但删除内容和同步删除标记仍独立保留，不会物理清除。"}),
        )
    }
    pub async fn trash_command(&self, c: &TrashCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let serialized = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "trash",
            &serialized,
        )
        .await?
        {
            return Ok(());
        }
        match &c.action {
            TrashAction::Settings {
                recovery_days,
                expected_version,
            } => {
                if !(1..=3650).contains(recovery_days) {
                    return Err("USER:恢复窗口须为1至3650天的整数".into());
                }
                let (_, version) = retention(&mut tx, &self.owner_id).await?;
                if version != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("INSERT INTO trash_settings(owner_id,recovery_days,version) VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET recovery_days=excluded.recovery_days,version=trash_settings.version+1")
                    .bind(&self.owner_id).bind(recovery_days).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            TrashAction::Delete {
                target_type,
                id,
                expected_version,
                mode,
                confirm_all,
                expected_tasks,
            } => {
                let active = tasks(&mut tx, &self.owner_id).await?;
                let mut expected = expected_tasks.clone();
                expected.sort();
                let actual: Vec<_> = active.iter().map(|t| (t.id.clone(), t.version)).collect();
                if expected != actual {
                    return Err("STATE_CONFLICT".into());
                }
                let mut selected = std::collections::HashSet::new();
                let title;
                if target_type == "task" {
                    let t = active
                        .iter()
                        .find(|t| &t.id == id && &t.version == expected_version)
                        .ok_or("STATE_CONFLICT")?;
                    title = t.title.clone();
                    selected.insert(id.clone());
                    if mode == "cascade" {
                        loop {
                            let before = selected.len();
                            for t in &active {
                                if t.parent_task_id
                                    .as_ref()
                                    .is_some_and(|p| selected.contains(p))
                                {
                                    selected.insert(t.id.clone());
                                }
                            }
                            if selected.len() == before {
                                break;
                            }
                        }
                    } else if mode != "promote" {
                        return Err("USER:请选择删除子项或提升子项".into());
                    }
                } else if target_type == "project" {
                    title=sqlx::query_scalar::<_,String>("SELECT name FROM projects WHERE id=? AND owner_id=? AND version=? AND deleted_at IS NULL").bind(id).bind(&self.owner_id).bind(expected_version).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?.ok_or("STATE_CONFLICT")?;
                    if mode == "cascade" && !confirm_all {
                        return Err("USER:整项目删除需要额外确认".into());
                    }
                    if mode != "cascade" && mode != "detach" {
                        return Err("USER:请选择保留任务或整项目删除".into());
                    }
                    for t in &active {
                        if t.project_id.as_ref() == Some(id) {
                            selected.insert(t.id.clone());
                        }
                    }
                } else {
                    return Err("USER:删除类型无效".into());
                }
                let deleted: Vec<String> = if target_type == "project" && mode == "detach" {
                    vec![]
                } else {
                    selected.iter().cloned().collect()
                };
                let affected: Vec<TaskState> = active
                    .iter()
                    .filter(|t| {
                        selected.contains(&t.id)
                            || t.parent_task_id
                                .as_ref()
                                .is_some_and(|p| selected.contains(p))
                    })
                    .cloned()
                    .collect();
                let mut links = vec![];
                let mut dependencies = vec![];
                for t in &affected {
                    if selected.contains(&t.id) {
                        // Preserve dependencies as evidence, but never leave an active dependency on a hidden task.
                        let edges:Vec<(String,String)>=sqlx::query_as("SELECT task_id,predecessor_id FROM task_dependencies WHERE task_id=? OR predecessor_id=?").bind(&t.id).bind(&t.id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                        dependencies.extend(edges);
                        sqlx::query(
                            "DELETE FROM task_dependencies WHERE task_id=? OR predecessor_id=?",
                        )
                        .bind(&t.id)
                        .bind(&t.id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    }
                    if t.parent_task_id.is_some() {
                        run(
                            &mut tx,
                            "UPDATE tasks SET parent_task_id=NULL,version=version+1 WHERE id=?",
                            &t.id,
                        )
                        .await?;
                    }
                }
                let targets: Vec<(&str, &str)> = deleted
                    .iter()
                    .map(|id| ("task", id.as_str()))
                    .chain(if target_type == "project" {
                        Some(("project", id.as_str()))
                    } else {
                        None
                    })
                    .collect();
                for (kind, target) in targets {
                    let records: Vec<String> = sqlx::query_scalar(
                        "SELECT record_id FROM record_links WHERE target_type=? AND target_id=?",
                    )
                    .bind(kind)
                    .bind(target)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    for record in records {
                        links.push(json!({"recordId":record,"targetType":kind,"targetId":target}));
                    }
                    sqlx::query("DELETE FROM record_links WHERE target_type=? AND target_id=?")
                        .bind(kind)
                        .bind(target)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    sqlx::query("INSERT INTO deletion_tombstones VALUES(?,?,?,?,NULL) ON CONFLICT(entity_type,entity_id) DO UPDATE SET operation_id=excluded.operation_id,deleted_at=excluded.deleted_at,restored_at=NULL").bind(kind).bind(target).bind(&c.operation_id).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                if target_type == "project" && mode == "detach" {
                    for t in &affected {
                        run(&mut tx,"UPDATE tasks SET project_id=NULL,section_id=NULL,version=version+1 WHERE id=?",&t.id).await?;
                    }
                    // Every member has moved before rebuilding the still-valid hierarchy.
                    for t in &affected {
                        if let Some(parent) = &t.parent_task_id {
                            sqlx::query("UPDATE tasks SET parent_task_id=? WHERE id=?")
                                .bind(parent)
                                .bind(&t.id)
                                .execute(&mut *tx)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                for task in &deleted {
                    sqlx::query("UPDATE tasks SET deleted_at=?,version=version+1 WHERE id=?")
                        .bind(&c.occurred_at)
                        .bind(task)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                if target_type == "project" {
                    sqlx::query("UPDATE recurrence_templates SET enabled=0,version=version+1 WHERE project_id=? AND enabled=1").bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    sqlx::query("UPDATE projects SET deleted_at=?,version=version+1 WHERE id=?")
                        .bind(&c.occurred_at)
                        .bind(id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                dependencies.sort();
                dependencies.dedup();
                let payload = json!({"tasks":affected,"deletedIds":deleted,"links":links,"dependencies":dependencies,"mode":mode});
                sqlx::query("INSERT INTO trash_batches(id,owner_id,target_type,target_id,title,deleted_at,restored_at,payload,recovery_started_at) VALUES(?,?,?,?,?,?,NULL,?,?)")
                    .bind(&c.operation_id)
                    .bind(&self.owner_id)
                    .bind(target_type)
                    .bind(id)
                    .bind(title)
                    .bind(&c.occurred_at)
                    .bind(payload.to_string())
                    .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            TrashAction::Restore { batch_id } => {
                let (days, _) = retention(&mut tx, &self.owner_id).await?;
                let started:String=sqlx::query_scalar("SELECT recovery_started_at FROM trash_batches WHERE id=? AND owner_id=? AND restored_at IS NULL")
                    .bind(batch_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?.ok_or("USER:该条目已恢复或不存在")?;
                if chrono::Utc::now() >= expires_at(&started, days)? {
                    return Err(
                        "USER:该条目已超过当前恢复窗口；删除内容和同步删除标记仍保留".into(),
                    );
                }
                let (kind,id,payload):(String,String,String)=sqlx::query_as("SELECT target_type,target_id,payload FROM trash_batches WHERE id=? AND owner_id=? AND restored_at IS NULL").bind(batch_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?.ok_or("USER:该条目已恢复或不存在")?;
                let v: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
                let saved: Vec<TaskState> =
                    serde_json::from_value(v["tasks"].clone()).map_err(|e| e.to_string())?;
                let deleted: Vec<String> =
                    serde_json::from_value(v["deletedIds"].clone()).map_err(|e| e.to_string())?;
                if kind == "project" {
                    run(
                        &mut tx,
                        "UPDATE projects SET deleted_at=NULL,version=version+1 WHERE id=?",
                        &id,
                    )
                    .await?;
                }
                for task in &deleted {
                    // Restore visibility first; detach invalid ownership while the row is writable.
                    sqlx::query("UPDATE tasks SET deleted_at=NULL,parent_task_id=NULL,project_id=CASE WHEN EXISTS(SELECT 1 FROM projects p WHERE p.id=tasks.project_id AND p.deleted_at IS NULL AND (tasks.status IN('completed','cancelled') OR (p.status IN('active','draft','paused') AND p.canceled=0 AND p.archived_at IS NULL))) THEN project_id ELSE NULL END,section_id=NULL,version=version+1 WHERE id=? AND deleted_at IS NOT NULL").bind(task).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                // Saved parents are only applied to restored rows; promoted/independent live tasks
                // may have changed since deletion and must not be silently moved back.
                for t in &saved {
                    if deleted.contains(&t.id) {
                        if let Some(section) = &t.section_id {
                            sqlx::query("UPDATE tasks SET section_id=? WHERE id=? AND EXISTS(SELECT 1 FROM sections WHERE id=? AND project_id=tasks.project_id)").bind(section).bind(&t.id).bind(section).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                        }
                        if let Some(parent) = &t.parent_task_id {
                            sqlx::query("UPDATE tasks SET parent_task_id=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks p WHERE p.id=? AND p.deleted_at IS NULL AND p.project_id IS tasks.project_id AND (tasks.status IN('completed','cancelled') OR p.status NOT IN('completed','cancelled')) AND NOT EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=p.id OR predecessor_id=p.id))").bind(parent).bind(&t.id).bind(parent).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                        }
                    }
                }
                for link in v["links"].as_array().ok_or("Invalid saved links")? {
                    let k = link["targetType"].as_str().unwrap_or("");
                    let target = link["targetId"].as_str().unwrap_or("");
                    let valid: bool = sqlx::query_scalar(if k == "project" {
                        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)"
                    } else {
                        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL)"
                    })
                    .bind(target)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if valid {
                        sqlx::query("INSERT OR IGNORE INTO record_links SELECT id,?,? FROM records WHERE id=? AND deleted_at IS NULL").bind(k).bind(target).bind(link["recordId"].as_str()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    }
                }
                let edges: Vec<(String, String)> =
                    serde_json::from_value(v["dependencies"].clone()).map_err(|e| e.to_string())?;
                for (task, predecessor) in edges {
                    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks a JOIN tasks b ON a.project_id=b.project_id AND a.owner_id=b.owner_id WHERE a.id=? AND b.id=? AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM tasks WHERE parent_task_id IN(a.id,b.id))) AND NOT EXISTS(WITH RECURSIVE ancestors(id) AS(SELECT ? UNION SELECT predecessor_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id) SELECT 1 FROM ancestors WHERE id=?)").bind(&task).bind(&predecessor).bind(&predecessor).bind(&task).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if valid {
                        sqlx::query("INSERT OR IGNORE INTO task_dependencies(owner_id,task_id,predecessor_id) VALUES(?,?,?)").bind(&self.owner_id).bind(task).bind(predecessor).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    }
                }
                sqlx::query("UPDATE trash_batches SET restored_at=? WHERE id=?")
                    .bind(&c.occurred_at)
                    .bind(batch_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("UPDATE deletion_tombstones SET restored_at=? WHERE operation_id=?")
                    .bind(&c.occurred_at)
                    .bind(batch_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(&c.operation_id)
            .bind("trash")
            .bind(&c.occurred_at)
            .bind(&serialized)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_operation(
            &mut tx,
            &c.operation_id,
            "trash",
            &serialized,
            &c.occurred_at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
