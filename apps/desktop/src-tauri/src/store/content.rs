use super::planning::{replay, validate_operation};
use super::*;
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: ContentAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentAction {
    Capture {
        id: String,
        raw_text: String,
    },
    Record {
        id: String,
        expected_version: Option<i64>,
        title: String,
        body: String,
        record_type: String,
        links: Vec<Link>,
    },
    Resolve {
        capture_id: String,
        expected_version: i64,
        outputs: Vec<Output>,
        project_id: Option<String>,
        new_project: Option<NewProject>,
    },
    Undo {
        resolution_id: String,
        keep_outputs: bool,
    },
    Context {
        project_id: String,
        expected_version: Option<i64>,
        definition_of_done: String,
        blocker_text: String,
        review_date: Option<String>,
        next_action_task_id: Option<String>,
        last_context: String,
        restart_hint: String,
        waiting_note: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub target_type: String,
    pub target_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewProject {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
}

fn valid_id(id: &str) -> StoreResult<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "USER:无效的对象标识".into())
}
fn text_limit(s: &str, n: usize) -> StoreResult<()> {
    if s.chars().count() > n {
        Err(format!("USER:内容超过 {n} 个字符，请缩短后保存"))
    } else {
        Ok(())
    }
}
fn record_fields(title: &str, body: &str, kind: &str) -> StoreResult<()> {
    text_limit(title, 500)?;
    text_limit(body, 100_000)?;
    if title.trim().is_empty() && body.trim().is_empty() {
        return Err("USER:请填写标题或正文".into());
    }
    if ![
        "note", "idea", "question", "evidence", "decision", "progress", "review",
    ]
    .contains(&kind)
    {
        return Err("USER:记录类型无效".into());
    }
    Ok(())
}
type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;
async fn project_exists(tx: &mut Tx<'_>, owner: &str, id: &str) -> StoreResult<()> {
    valid_id(id)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE owner_id=? AND id=? AND deleted_at IS NULL)",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if !exists {
        return Err("USER:项目不存在或不属于本工作空间".into());
    }
    Ok(())
}
async fn set_links(tx: &mut Tx<'_>, owner: &str, record: &str, links: &[Link]) -> StoreResult<()> {
    if links.len() > 100 {
        return Err("USER:单条记录最多关联 100 个对象".into());
    }
    for link in links {
        valid_id(&link.target_id)?;
        let sql=match link.target_type.as_str() {"project"=>"SELECT EXISTS(SELECT 1 FROM projects WHERE owner_id=? AND id=? AND deleted_at IS NULL)", "task"=>"SELECT EXISTS(SELECT 1 FROM tasks WHERE owner_id=? AND id=? AND deleted_at IS NULL)",_=>return Err("USER:关联类型无效".into())};
        let exists: bool = sqlx::query_scalar(sql)
            .bind(owner)
            .bind(&link.target_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("USER:关联对象不存在或不属于本工作空间".into());
        }
    }
    sqlx::query("DELETE FROM record_links WHERE record_id=?")
        .bind(record)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    for link in links {
        sqlx::query("INSERT OR IGNORE INTO record_links VALUES(?,?,?)")
            .bind(record)
            .bind(&link.target_type)
            .bind(&link.target_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
impl Store {
    pub async fn content_snapshot(&self) -> StoreResult<Value> {
        // A single connection gives a consistent read transaction across all sections.
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let specs=[
   ("captures","SELECT json_object('id',id,'rawText',raw_text,'state',state,'version',version,'createdAt',created_at,'resolutionId',resolution_id,'retainedOutputs',retained_outputs) FROM captures WHERE owner_id=? AND sync_deleted=0 ORDER BY created_at DESC,id"),
   ("records","SELECT json_object('id',r.id,'title',r.title,'body',r.body,'recordType',r.record_type,'weeklyReview',json(CASE WHEN EXISTS(SELECT 1 FROM weekly_reviews w WHERE w.record_id=r.id) THEN 'true' ELSE 'false' END),'version',r.version,'sourceCaptureId',r.source_capture_id,'updatedAt',r.updated_at,'links',json((SELECT json_group_array(json_object('targetType',target_type,'targetId',target_id)) FROM record_links WHERE record_id=r.id))) FROM records r WHERE r.owner_id=? AND r.deleted_at IS NULL ORDER BY r.updated_at DESC,r.id"),
   ("tasks","SELECT json_object('id',id,'title',title,'projectId',project_id,'status',CASE WHEN waiting=1 THEN 'waiting' ELSE status END,'version',version,'sourceCaptureId',source_capture_id,'leaf',NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=tasks.id AND child.deleted_at IS NULL)) FROM tasks WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at,id"),
   ("contexts","SELECT json_object('projectId',c.project_id,'definitionOfDone',c.definition_of_done,'blockerText',c.blocker_text,'reviewDate',c.review_date,'nextActionTaskId',c.next_action_task_id,'lastContext',c.last_context,'restartHint',c.restart_hint,'waitingNote',c.waiting_note,'updatedAt',c.updated_at,'version',c.version,'nextActionCleared',c.next_action_cleared) FROM project_context c JOIN projects p ON p.id=c.project_id WHERE p.owner_id=? AND p.deleted_at IS NULL"),
   ("events","SELECT json_object('id',id,'entityId',entity_id,'kind',kind,'occurredAt',occurred_at,'payload',json(payload)) FROM content_events WHERE owner_id=? ORDER BY rowid DESC"),
   ("resolutions","SELECT json_object('id',r.id,'captureId',r.capture_id,'outputs',json(r.outputs),'undoneAt',r.undone_at,'kept',r.kept) FROM resolutions r JOIN captures c ON c.id=r.capture_id WHERE c.owner_id=? ORDER BY r.rowid DESC")
  ];
        let mut result = json!({});
        for (key, sql) in specs {
            let rows: Vec<String> = sqlx::query_scalar(sql)
                .bind(&self.owner_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            result[key] = Value::Array(
                rows.into_iter()
                    .map(|s| serde_json::from_str(&s).unwrap_or(Value::Null))
                    .collect(),
            );
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub async fn content_command(&self, c: &ContentCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "content",
            &payload,
        )
        .await?
        {
            return Ok(());
        }
        let entity: String;
        match &c.action {
            ContentAction::Capture { id, raw_text } => {
                valid_id(id)?;
                text_limit(raw_text, 100_000)?;
                if raw_text.trim().is_empty() {
                    return Err("USER:请填写原文".into());
                }
                sqlx::query(
                    "INSERT INTO captures(id,owner_id,raw_text,created_at) VALUES(?,?,?,?)",
                )
                .bind(id)
                .bind(&self.owner_id)
                .bind(raw_text)
                .bind(&c.occurred_at)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                entity = id.clone();
            }
            ContentAction::Record {
                id,
                expected_version,
                title,
                body,
                record_type,
                links,
            } => {
                valid_id(id)?;
                record_fields(title, body, record_type)?;
                let structured:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM weekly_reviews w JOIN records r ON r.id=w.record_id WHERE r.id=? AND r.owner_id=?)").bind(id).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                if structured {
                    return Err("USER:请从项目检查与周回顾页面编辑这份结构化回顾".into());
                }
                if let Some(version) = expected_version {
                    let n=sqlx::query("UPDATE records SET title=?,body=?,record_type=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND version=? AND deleted_at IS NULL").bind(title).bind(body).bind(record_type).bind(&c.occurred_at).bind(id).bind(&self.owner_id).bind(version).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                    if n != 1 {
                        return Err("STATE_CONFLICT".into());
                    }
                } else {
                    sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id).bind(&self.owner_id).bind(title).bind(body).bind(record_type).bind(&c.occurred_at).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                set_links(&mut tx, &self.owner_id, id, links).await?;
                entity = id.clone();
            }
            ContentAction::Resolve {
                capture_id,
                expected_version,
                outputs,
                project_id,
                new_project,
            } => {
                if outputs.is_empty() || outputs.len() > 100 {
                    return Err("USER:每次澄清需包含 1–100 个输出".into());
                }
                if project_id.is_some() && new_project.is_some() {
                    return Err("USER:只能选择已有项目或新项目之一".into());
                }
                let updated=sqlx::query("UPDATE captures SET state='processed',version=version+1,resolution_id=? WHERE id=? AND owner_id=? AND state='pending' AND version=?").bind(&c.operation_id).bind(capture_id).bind(&self.owner_id).bind(expected_version).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                if updated != 1 {
                    return Err("STATE_CONFLICT".into());
                }
                let target = if let Some(p) = new_project {
                    valid_id(&p.id)?;
                    text_limit(&p.name, 500)?;
                    if p.name.trim().is_empty() {
                        return Err("USER:请填写新项目名称".into());
                    }
                    sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,?,'',1,0,?)").bind(&p.id).bind(&self.owner_id).bind(p.name.trim()).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    Some(p.id.clone())
                } else {
                    project_id.clone()
                };
                if let Some(id) = &target {
                    project_exists(&mut tx, &self.owner_id, id).await?;
                    let active: bool = sqlx::query_scalar(
                        "SELECT status IN('active','draft','paused') FROM projects WHERE id=?",
                    )
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if !active {
                        return Err("USER:请先重新打开项目".into());
                    }
                }
                for o in outputs {
                    valid_id(&o.id)?;
                    record_fields(&o.title, &o.body, "note")?;
                    match o.kind.as_str() {
                        "task" => {
                            if o.title.trim().is_empty() {
                                return Err("USER:任务需要标题".into());
                            }
                            sqlx::query("INSERT INTO tasks(id,owner_id,title,notes,project_id,status,source,created_at,source_capture_id) VALUES(?,?,?,?,?,'todo','temporary',?,?)").bind(&o.id).bind(&self.owner_id).bind(o.title.trim()).bind(&o.body).bind(&target).bind(&c.occurred_at).bind(capture_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                        }
                        "record" => {
                            sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,source_capture_id,created_at,updated_at) VALUES(?,?,?,?,'note',?,?,?)").bind(&o.id).bind(&self.owner_id).bind(&o.title).bind(&o.body).bind(capture_id).bind(&c.occurred_at).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                            if let Some(id) = &target {
                                set_links(
                                    &mut tx,
                                    &self.owner_id,
                                    &o.id,
                                    &[Link {
                                        target_type: "project".into(),
                                        target_id: id.clone(),
                                    }],
                                )
                                .await?;
                            }
                        }
                        _ => return Err("USER:输出类型无效".into()),
                    }
                }
                sqlx::query(
                    "INSERT INTO resolutions(id,capture_id,outputs,created_at) VALUES(?,?,?,?)",
                )
                .bind(&c.operation_id)
                .bind(capture_id)
                .bind(serde_json::to_string(outputs).map_err(|e| e.to_string())?)
                .bind(&c.occurred_at)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                entity = capture_id.clone();
            }
            ContentAction::Undo {
                resolution_id,
                keep_outputs,
            } => {
                let row:Option<(String,String)>=sqlx::query_as("SELECT r.capture_id,r.outputs FROM resolutions r JOIN captures c ON c.id=r.capture_id WHERE r.id=? AND c.owner_id=? AND r.undone_at IS NULL AND c.resolution_id=r.id AND c.state='processed'").bind(resolution_id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                let (capture, outputs) = row.ok_or("STATE_CONFLICT")?;
                let outputs: Vec<Output> =
                    serde_json::from_str(&outputs).map_err(|e| e.to_string())?;
                if !keep_outputs {
                    for o in &outputs {
                        let sql = if o.kind == "task" {
                            "SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=? AND t.owner_id=? AND t.version=0 AND t.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_schedules WHERE task_id=t.id) AND NOT EXISTS(SELECT 1 FROM daily_plan_items WHERE task_id=t.id) AND NOT EXISTS(SELECT 1 FROM domain_events WHERE task_id=t.id) AND NOT EXISTS(SELECT 1 FROM project_context WHERE next_action_task_id=t.id) AND NOT EXISTS(SELECT 1 FROM record_links WHERE target_type='task' AND target_id=t.id) AND NOT EXISTS(SELECT 1 FROM tasks WHERE parent_task_id=t.id) AND NOT EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=t.id OR predecessor_id=t.id))"
                        } else {
                            "SELECT EXISTS(SELECT 1 FROM records WHERE id=? AND owner_id=? AND version=0 AND deleted_at IS NULL)"
                        };
                        let clean: bool = sqlx::query_scalar(sql)
                            .bind(&o.id)
                            .bind(&self.owner_id)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                        if !clean {
                            return Err("USER:输出已被编辑或关联。请检查影响，选择仅恢复原文并保留所有输出。".into());
                        }
                    }
                    for o in &outputs {
                        let sql = if o.kind == "task" {
                            "UPDATE tasks SET deleted_at=?,status='cancelled',version=version+1 WHERE id=?"
                        } else {
                            "UPDATE records SET deleted_at=?,version=version+1 WHERE id=?"
                        };
                        sqlx::query(sql)
                            .bind(&c.occurred_at)
                            .bind(&o.id)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                sqlx::query("UPDATE resolutions SET undone_at=?,kept=? WHERE id=?")
                    .bind(&c.occurred_at)
                    .bind(keep_outputs)
                    .bind(resolution_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("UPDATE captures SET state='pending',version=version+1,retained_outputs=? WHERE id=?").bind(keep_outputs).bind(&capture).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = capture;
            }
            ContentAction::Context {
                project_id,
                expected_version,
                definition_of_done,
                blocker_text,
                review_date,
                next_action_task_id,
                last_context,
                restart_hint,
                waiting_note,
            } => {
                project_exists(&mut tx, &self.owner_id, project_id).await?;
                for s in [
                    definition_of_done,
                    blocker_text,
                    last_context,
                    restart_hint,
                    waiting_note,
                ] {
                    text_limit(s, 100_000)?;
                }
                if let Some(date) = review_date {
                    validate_date(date)?;
                }
                if let Some(id) = next_action_task_id {
                    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.owner_id=? AND t.project_id=? AND t.status IN('todo','in_progress') AND t.waiting=0 AND t.deleted_at IS NULL AND p.status='active' AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM tasks WHERE parent_task_id=t.id AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks before ON before.id=d.predecessor_id WHERE d.task_id=t.id AND before.status<>'completed'))").bind(id).bind(&self.owner_id).bind(project_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if !valid {
                        return Err(
                            "USER:下一步必须是本项目未阻塞的可执行叶子任务，且项目正在进行中"
                                .into(),
                        );
                    }
                }
                let current: Option<i64> =
                    sqlx::query_scalar("SELECT version FROM project_context WHERE project_id=?")
                        .bind(project_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if current != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("INSERT INTO project_context(project_id,definition_of_done,blocker_text,review_date,next_action_task_id,last_context,restart_hint,waiting_note,version,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?) ON CONFLICT(project_id) DO UPDATE SET definition_of_done=excluded.definition_of_done,blocker_text=excluded.blocker_text,review_date=excluded.review_date,next_action_task_id=excluded.next_action_task_id,last_context=excluded.last_context,restart_hint=excluded.restart_hint,waiting_note=excluded.waiting_note,version=project_context.version+1,updated_at=excluded.updated_at,next_action_cleared=0").bind(project_id).bind(definition_of_done).bind(blocker_text).bind(review_date).bind(next_action_task_id).bind(last_context).bind(restart_hint).bind(waiting_note).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = project_id.clone();
            }
        }
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(entity)
            .bind("content")
            .bind(&c.occurred_at)
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_operation(
            &mut tx,
            &c.operation_id,
            "content",
            &payload,
            &c.occurred_at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
