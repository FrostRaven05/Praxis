use super::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSource {
    pub id: String,
    pub version: i64,
    pub raw_text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiBasis {
    pub id: String,
    pub version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRecoveryBasis {
    pub version: Option<i64>,
    pub records: Vec<AiBasis>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiProject {
    pub id: String,
    pub version: i64,
    pub plan_version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiNewProject {
    pub id: String,
    pub name: String,
    pub outcome: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiTask {
    pub id: String,
    pub key: String,
    pub title: String,
    pub criteria: String,
    pub estimated_minutes: Option<i64>,
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiReward {
    pub title: String,
    pub condition: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiApplyCommand {
    pub operation_id: String,
    pub run_id: String,
    pub input: String,
    pub source: Option<AiSource>,
    pub project: Option<AiProject>,
    pub new_project: Option<AiNewProject>,
    pub basis_tasks: Vec<AiBasis>,
    pub tasks: Vec<AiTask>,
    pub reward: Option<AiReward>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basis_recovery: Option<AiRecoveryBasis>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyReceipt {
    pub operation_id: String,
    pub task_ids: Vec<String>,
    pub project_id: Option<String>,
    pub source_capture_id: String,
    pub resolution_id: String,
    pub applied_at: String,
    pub undone: bool,
}
fn valid(s: &str, max: usize, empty: bool) -> bool {
    s.chars().count() <= max && (empty || !s.trim().is_empty())
}
fn id(s: &str) -> bool {
    Uuid::parse_str(s).is_ok()
}
fn validate(c: &AiApplyCommand) -> StoreResult<()> {
    if !id(&c.operation_id)
        || !id(&c.run_id)
        || !valid(&c.input, 8000, false)
        || c.tasks.is_empty()
        || c.tasks.len() > 8
        || c.basis_tasks.len() > 100
        || c.project.is_some() && c.new_project.is_some()
    {
        return Err("AI_INVALID_COMMAND".into());
    }
    if let Some(b) = &c.basis_recovery {
        if c.project.is_none()
            || b.version.is_some_and(|v| v < 0)
            || b.records.len() > 5
            || b.records.iter().any(|r| !id(&r.id) || r.version < 0)
            || b.records
                .iter()
                .map(|r| &r.id)
                .collect::<HashSet<_>>()
                .len()
                != b.records.len()
        {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    if let Some(s) = &c.source {
        if !id(&s.id) || s.version < 0 || !valid(&s.raw_text, 8000, false) {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    if let Some(p) = &c.project {
        if !id(&p.id) || p.version < 0 || p.plan_version < 0 {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    if let Some(p) = &c.new_project {
        if !id(&p.id) || !valid(&p.name, 120, false) || !valid(&p.outcome, 2000, true) {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    if let Some(r) = &c.reward {
        if !valid(&r.title, 200, false) || !valid(&r.condition, 1000, false) {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for t in &c.tasks {
        if t.notes.as_ref().is_some_and(|v| !valid(v,4000,true)) || t.deadline.as_ref().is_some_and(|v| validate_date(v).is_err()) {return Err("AI_INVALID_COMMAND".into());}
        if !id(&t.id)
            || !ids.insert(&t.id)
            || !keys.insert(&t.key)
            || !valid(&t.key, 4, false)
            || !valid(&t.title, 300, false)
            || !valid(&t.criteria, 1000, false)
            || t.estimated_minutes.is_some_and(|m| !(1..=480).contains(&m))
            || t.depends_on.len() > 8
        {
            return Err("AI_INVALID_COMMAND".into());
        }
    }
    for t in &c.tasks {
        if t.depends_on
            .iter()
            .any(|d| d == &t.key || !keys.contains(d))
            || t.depends_on.iter().collect::<HashSet<_>>().len() != t.depends_on.len()
        {
            return Err("AI_INVALID_DEPENDENCIES".into());
        }
    }
    let mut done = HashSet::new();
    for _ in 0..c.tasks.len() {
        for t in &c.tasks {
            if t.depends_on.iter().all(|d| done.contains(d)) {
                done.insert(t.key.clone());
            }
        }
    }
    if done.len() != c.tasks.len()
        || (c.project.is_none()
            && c.new_project.is_none()
            && c.tasks.iter().any(|t| !t.depends_on.is_empty()))
    {
        return Err("AI_INVALID_DEPENDENCIES".into());
    }
    Ok(())
}
impl Store {
    pub async fn ai_receipt(&self, operation_id: &str) -> StoreResult<Option<AiApplyReceipt>> {
        if !id(operation_id) {
            return Err("AI_INVALID_COMMAND".into());
        }
        let value: Option<String> = sqlx::query_scalar(
            "SELECT receipt_json FROM ai_applications WHERE owner_id=? AND operation_id=?",
        )
        .bind(&self.owner_id)
        .bind(operation_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        value
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }
    pub async fn ai_apply(&self, c: &AiApplyCommand) -> StoreResult<AiApplyReceipt> {
        validate(c)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let old:Option<(String,String)>=sqlx::query_as("SELECT command_json,receipt_json FROM ai_applications WHERE owner_id=? AND operation_id=?").bind(&self.owner_id).bind(&c.operation_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        if let Some((before, receipt)) = old {
            if before != payload {
                return Err("AI_OPERATION_CHANGED".into());
            }
            return serde_json::from_str(&receipt).map_err(|e| e.to_string());
        }
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM ai_applications WHERE owner_id=? AND run_id=?)",
        )
        .bind(&self.owner_id)
        .bind(&c.run_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if used {
            return Err("AI_ALREADY_APPLIED".into());
        }
        if let Some(p) = &c.project {
            let current:Option<(i64,i64,String)>=sqlx::query_as("SELECT version,plan_version,status FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL AND archived_at IS NULL AND canceled=0").bind(&p.id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
            if !current.is_some_and(|v| {
                v.0 == p.version
                    && v.1 == p.plan_version
                    && ["active", "draft", "paused"].contains(&v.2.as_str())
            }) {
                return Err("AI_STALE_PROJECT".into());
            }
            let current:Vec<(String,i64)>=sqlx::query_as("SELECT id,version FROM tasks WHERE project_id=? AND owner_id=? AND deleted_at IS NULL").bind(&p.id).bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
            let basis: HashMap<_, _> = c
                .basis_tasks
                .iter()
                .map(|t| (t.id.clone(), t.version))
                .collect();
            if basis.len() != c.basis_tasks.len()
                || current.len() != basis.len()
                || current
                    .iter()
                    .any(|(id, version)| basis.get(id) != Some(version))
            {
                return Err("AI_STALE_PROJECT".into());
            }
        } else if !c.basis_tasks.is_empty() {
            return Err("AI_INVALID_COMMAND".into());
        }
        if let Some(expected) = &c.basis_recovery {
            let project = c.project.as_ref().ok_or("AI_INVALID_COMMAND")?;
            let (version, records) =
                super::ai_context::recovery_basis(&mut tx, &self.owner_id, &project.id).await?;
            if version != expected.version
                || records.len() != expected.records.len()
                || records.iter().any(|r| {
                    !expected
                        .records
                        .iter()
                        .any(|e| e.id == r.id && e.version == r.version)
                })
            {
                return Err("AI_STALE_PROJECT".into());
            }
        }
        let at = chrono::Utc::now().to_rfc3339();
        let capture_id = if let Some(s) = &c.source {
            let matches:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM captures WHERE id=? AND owner_id=? AND state='pending' AND version=? AND raw_text=? AND sync_deleted=0)").bind(&s.id).bind(&self.owner_id).bind(s.version).bind(&s.raw_text).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if !matches {
                return Err("AI_STALE_SOURCE".into());
            }
            s.id.clone()
        } else {
            let capture = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{}:capture", c.operation_id).as_bytes(),
            )
            .to_string();
            sqlx::query("INSERT INTO captures(id,owner_id,raw_text,created_at) VALUES(?,?,?,?)")
                .bind(&capture)
                .bind(&self.owner_id)
                .bind(&c.input)
                .bind(&at)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            capture
        };
        let project_id = if let Some(p) = &c.new_project {
            sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,?,?,1,0,?)").bind(&p.id).bind(&self.owner_id).bind(p.name.trim()).bind(&p.outcome).bind(&at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            Some(p.id.clone())
        } else {
            c.project.as_ref().map(|p| p.id.clone())
        };
        let rank: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(task_rank),0) FROM tasks WHERE owner_id=? AND project_id IS ?",
        )
        .bind(&self.owner_id)
        .bind(&project_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        for (index, t) in c.tasks.iter().enumerate() {
            let deadline=t.deadline.as_ref().map(|date|json!({"kind":"date","date":date}).to_string());
            sqlx::query("INSERT INTO tasks(id,owner_id,title,notes,completion_criteria,default_estimated_minutes,project_id,status,source,created_at,source_capture_id,task_rank,deadline_value) VALUES(?,?,?,?,?,?,?,'todo','temporary',?,?,?,?)").bind(&t.id).bind(&self.owner_id).bind(t.title.trim()).bind(t.notes.as_deref().unwrap_or("由规划草稿采用，原始意图保留在关联收集项。")).bind(&t.criteria).bind(t.estimated_minutes).bind(&project_id).bind(&at).bind(&capture_id).bind(rank+index as i64+1).bind(deadline).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
        let by_key: HashMap<_, _> = c.tasks.iter().map(|t| (&t.key, &t.id)).collect();
        for t in &c.tasks {
            for dep in &t.depends_on {
                sqlx::query(
                    "INSERT INTO task_dependencies(owner_id,task_id,predecessor_id) VALUES(?,?,?)",
                )
                .bind(&self.owner_id)
                .bind(&t.id)
                .bind(by_key[dep])
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        if let Some(p) = &project_id {
            sqlx::query(
                "UPDATE projects SET plan_version=plan_version+1 WHERE id=? AND owner_id=?",
            )
            .bind(p)
            .bind(&self.owner_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        let mut outputs: Vec<Value> = c
            .tasks
            .iter()
            .map(|t| json!({"id":t.id,"kind":"task","title":t.title,"body":t.criteria}))
            .collect();
        let reward_id = if let Some(reward) = &c.reward {
            let record = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{}:reward", c.operation_id).as_bytes(),
            )
            .to_string();
            let body = format!(
                "奖励：{}\n解锁条件：{}\n\n这是一份由用户采用的奖励约定，尚未自动解锁或购买。",
                reward.title, reward.condition
            );
            sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,source_capture_id,created_at,updated_at) VALUES(?,?,?,?,'idea',?,?,?)").bind(&record).bind(&self.owner_id).bind(format!("奖励约定：{}",reward.title)).bind(&body).bind(&capture_id).bind(&at).bind(&at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            if let Some(p) = &project_id {
                sqlx::query("INSERT INTO record_links(record_id,target_type,target_id) VALUES(?,'project',?)").bind(&record).bind(p).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            outputs.push(json!({"id":record,"kind":"record","title":reward.title,"body":body}));
            Some(record)
        } else {
            None
        };
        sqlx::query("UPDATE captures SET state='processed',version=version+1,resolution_id=? WHERE id=? AND owner_id=?").bind(&c.operation_id).bind(&capture_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO resolutions(id,capture_id,outputs,created_at) VALUES(?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&capture_id)
            .bind(json!(outputs).to_string())
            .bind(&at)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        let receipt = AiApplyReceipt {
            operation_id: c.operation_id.clone(),
            task_ids: c.tasks.iter().map(|t| t.id.clone()).collect(),
            project_id,
            source_capture_id: capture_id.clone(),
            resolution_id: c.operation_id.clone(),
            applied_at: at.clone(),
            undone: false,
        };
        sqlx::query("INSERT INTO ai_applications(owner_id,operation_id,run_id,command_json,receipt_json,reward_record_id) VALUES(?,?,?,?,?,?)").bind(&self.owner_id).bind(&c.operation_id).bind(&c.run_id).bind(&payload).bind(serde_json::to_string(&receipt).map_err(|e|e.to_string())?).bind(&reward_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(&capture_id)
            .bind("ai_apply")
            .bind(&at)
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_operation(&mut tx, &c.operation_id, "ai_apply", &payload, &at)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(receipt)
    }
    pub async fn ai_undo(&self, operation_id: &str, apply_operation_id: &str) -> StoreResult<()> {
        if !id(operation_id) || !id(apply_operation_id) {
            return Err("AI_INVALID_COMMAND".into());
        }
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let row:Option<(String,Option<String>,String)>=sqlx::query_as("SELECT receipt_json,reward_record_id,command_json FROM ai_applications WHERE owner_id=? AND operation_id=?").bind(&self.owner_id).bind(apply_operation_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        let (receipt, reward, original) = row.ok_or("AI_INVALID_COMMAND")?;
        let original: AiApplyCommand =
            serde_json::from_str(&original).map_err(|e| e.to_string())?;
        let source_version = original.source.as_ref().map(|s| s.version + 1).unwrap_or(1);
        let mut receipt: AiApplyReceipt =
            serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
        if receipt.undone {
            return Ok(());
        }
        let origin_used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cultivation_reward_agreements WHERE owner_id=? AND source_application_id=?)")
            .bind(&self.owner_id).bind(apply_operation_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        if origin_used {
            return Err("AI_UNDO_CONFLICT".into());
        }
        let set: HashSet<_> = receipt.task_ids.iter().collect();
        for task in &receipt.task_ids {
            let linked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cultivation_goal_tasks WHERE owner_id=? AND task_id=? UNION ALL SELECT 1 FROM cultivation_achievement_tasks WHERE owner_id=? AND task_id=? UNION ALL SELECT 1 FROM cultivation_reward_agreements r,json_each(r.task_ids) j WHERE r.owner_id=? AND j.value=?)")
                .bind(&self.owner_id).bind(task).bind(&self.owner_id).bind(task).bind(&self.owner_id).bind(task).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if linked {
                return Err("AI_UNDO_CONFLICT".into());
            }
            let clean:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks t WHERE id=? AND owner_id=? AND version=0 AND status='todo' AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM daily_plan_items WHERE task_id=t.id) AND NOT EXISTS(SELECT 1 FROM project_schedules WHERE task_id=t.id) AND NOT EXISTS(SELECT 1 FROM record_links WHERE target_type='task' AND target_id=t.id) AND NOT EXISTS(SELECT 1 FROM project_context WHERE next_action_task_id=t.id) AND NOT EXISTS(SELECT 1 FROM tasks WHERE parent_task_id=t.id) AND NOT EXISTS(SELECT 1 FROM domain_events WHERE task_id=t.id))").bind(task).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if !clean {
                return Err("AI_UNDO_CONFLICT".into());
            }
            let edges:Vec<(String,String)>=sqlx::query_as("SELECT task_id,predecessor_id FROM task_dependencies WHERE owner_id=? AND (task_id=? OR predecessor_id=?)").bind(&self.owner_id).bind(task).bind(task).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
            if edges
                .iter()
                .any(|(a, b)| !set.contains(a) || !set.contains(b))
            {
                return Err("AI_UNDO_CONFLICT".into());
            }
        }
        let source_valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM captures WHERE id=? AND owner_id=? AND state='processed' AND resolution_id=? AND version=? AND sync_deleted=0)").bind(&receipt.source_capture_id).bind(&self.owner_id).bind(apply_operation_id).bind(source_version).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        if !source_valid {
            return Err("AI_UNDO_CONFLICT".into());
        }
        if let Some(record) = &reward {
            let clean:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM records WHERE id=? AND owner_id=? AND version=0 AND deleted_at IS NULL)").bind(record).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if !clean {
                return Err("AI_UNDO_CONFLICT".into());
            }
        }
        let at = chrono::Utc::now().to_rfc3339();
        for task in &receipt.task_ids {
            sqlx::query("DELETE FROM task_dependencies WHERE owner_id=? AND task_id=?")
                .bind(&self.owner_id)
                .bind(task)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE tasks SET deleted_at=?,status='cancelled',version=version+1 WHERE id=? AND owner_id=?").bind(&at).bind(task).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
        if let Some(record) = &reward {
            sqlx::query(
                "UPDATE records SET deleted_at=?,version=version+1 WHERE id=? AND owner_id=?",
            )
            .bind(&at)
            .bind(record)
            .bind(&self.owner_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query("UPDATE resolutions SET undone_at=? WHERE id=?")
            .bind(&at)
            .bind(apply_operation_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE captures SET state='pending',resolution_id=NULL,version=version+1 WHERE id=? AND owner_id=?").bind(&receipt.source_capture_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        if let Some(project) = &receipt.project_id {
            sqlx::query(
                "UPDATE projects SET plan_version=plan_version+1 WHERE id=? AND owner_id=?",
            )
            .bind(project)
            .bind(&self.owner_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        receipt.undone = true;
        sqlx::query(
            "UPDATE ai_applications SET receipt_json=? WHERE owner_id=? AND operation_id=?",
        )
        .bind(serde_json::to_string(&receipt).map_err(|e| e.to_string())?)
        .bind(&self.owner_id)
        .bind(apply_operation_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        self.queue_operation(
            &mut tx,
            operation_id,
            "ai_undo",
            &json!({"applyOperationId":apply_operation_id}).to_string(),
            &at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
}
