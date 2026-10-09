use super::planning::{replay, validate_operation};
use super::*;
use chrono::{Datelike, Duration as Days, Utc};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewCondition {
    pub field: String,
    pub op: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewQuery {
    pub text: String,
    pub entity_type: String,
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub include_archived: bool,
    pub groups: Vec<Vec<ViewCondition>>,
    pub sort: String,
    pub group_by: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: ViewAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ViewAction {
    Save {
        id: String,
        expected_version: Option<i64>,
        name: String,
        query: ViewQuery,
        followed: bool,
    },
    Delete {
        id: String,
        expected_version: i64,
    },
}
fn validate_query(q: &ViewQuery) -> StoreResult<()> {
    if q.text.len() > 2000
        || !["all", "task", "project", "record", "habit"].contains(&q.entity_type.as_str())
        || ![
            "title", "priority", "plan", "deadline", "followUp", "created",
        ]
        .contains(&q.sort.as_str())
        || !["none", "project", "status", "priority", "type"].contains(&q.group_by.as_str())
        || q.groups.len() > 3
    {
        return Err("USER:筛选结构无效（最多三个 OR 组）".into());
    }
    if let Some(id) = &q.project_id {
        Uuid::parse_str(id).map_err(|_| "USER:项目引用无效")?;
    }
    if q.status.as_ref().is_some_and(|s| {
        ![
            "todo",
            "in_progress",
            "waiting",
            "blocked",
            "completed",
            "cancelled",
            "active",
            "paused",
            "draft",
        ]
        .contains(&s.as_str())
    }) {
        return Err("USER:状态无效".into());
    }
    for group in &q.groups {
        if group.is_empty() || group.len() > 12 {
            return Err("USER:每个 AND 组需要一至十二个条件".into());
        }
        for c in group {
            let valid = match c.field.as_str() {
                "project" | "label" => c.op == "eq" && Uuid::parse_str(&c.value).is_ok(),
                "status" => {
                    c.op == "eq"
                        && [
                            "todo",
                            "in_progress",
                            "waiting",
                            "blocked",
                            "completed",
                            "cancelled",
                        ]
                        .contains(&c.value.as_str())
                }
                "priority" => {
                    ["eq", "lte"].contains(&c.op.as_str())
                        && c.value.parse::<i64>().is_ok_and(|n| (1..=4).contains(&n))
                }
                "estimate" => {
                    ["eq", "lte", "gte"].contains(&c.op.as_str())
                        && c.value
                            .parse::<i64>()
                            .is_ok_and(|n| (1..=1440).contains(&n))
                }
                "plan" | "deadline" | "followUp" => match c.op.as_str() {
                    "eq" | "lte" | "gte" => validate_date(&c.value).is_ok(),
                    "empty" | "present" | "due" | "thisWeek" => c.value.is_empty(),
                    _ => false,
                },
                "nextAction" | "independent" | "projectActive" | "unblocked" => {
                    c.op == "eq" && ["true", "false"].contains(&c.value.as_str())
                }
                _ => false,
            };
            if !valid {
                return Err("USER:不支持的筛选条件；仅接受结构化字段、操作符与值".into());
            }
        }
    }
    Ok(())
}
fn date_value(v: &Value, zone: Tz) -> Option<String> {
    if v["kind"] == "date" {
        return v["date"].as_str().map(str::to_owned);
    }
    DateTime::parse_from_rfc3339(v["atUtc"].as_str()?)
        .ok()
        .map(|d| d.with_timezone(&zone).date_naive().to_string())
}
fn matches(row: &Value, c: &ViewCondition, today: NaiveDate, zone: Tz) -> bool {
    match c.field.as_str() {
        "project" => row["projectId"] == c.value,
        "label" => row["labels"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == &c.value)),
        "status" => row["status"] == c.value,
        "priority" | "estimate" => row[&c.field].as_i64().is_some_and(|n| {
            let target = c.value.parse::<i64>().unwrap_or(0);
            match c.op.as_str() {
                "lte" => n <= target,
                "gte" => n >= target,
                _ => n == target,
            }
        }),
        "nextAction" | "independent" | "projectActive" | "unblocked" => {
            row[&c.field].as_bool() == Some(c.value == "true")
        }
        "plan" | "deadline" | "followUp" => {
            let d = date_value(&row[&c.field], zone);
            match c.op.as_str() {
                "empty" => d.is_none(),
                "present" => d.is_some(),
                "due" => d.is_some_and(|s| s <= today.to_string()),
                "thisWeek" => {
                    let monday = today - Days::days(today.weekday().num_days_from_monday() as i64);
                    d.is_some_and(|s| {
                        s >= monday.to_string() && s <= (monday + Days::days(6)).to_string()
                    })
                }
                "eq" => d.as_ref() == Some(&c.value),
                "lte" => d.is_some_and(|s| s <= c.value),
                "gte" => d.is_some_and(|s| s >= c.value),
                _ => false,
            }
        }
        _ => false,
    }
}
fn preset(name: &str, groups: Value) -> Value {
    json!({"name":name,"query":{"text":"","entityType":"task","projectId":null,"status":null,"includeArchived":false,"groups":groups,"sort":"priority","groupBy":"project"}})
}
impl Store {
    pub async fn view_command(&self, c: &ViewCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "saved_view",
            &payload,
        )
        .await?
        {
            return Ok(());
        }
        let entity = match &c.action {
            ViewAction::Save {
                id,
                expected_version,
                name,
                query,
                followed,
            } => {
                Uuid::parse_str(id).map_err(|_| "USER:无效视图标识")?;
                validate_query(query)?;
                if query.entity_type != "task"
                    || name.trim().is_empty()
                    || name.chars().count() > 120
                {
                    return Err("USER:保存视图需要名称，且仅支持任务清单".into());
                }
                let old: Option<(i64, Option<String>)> = sqlx::query_as(
                    "SELECT version,deleted_at FROM saved_views WHERE id=? AND owner_id=?",
                )
                .bind(id)
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if old.as_ref().map(|r| r.0) != *expected_version
                    || old.as_ref().is_some_and(|r| r.1.is_some())
                {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("INSERT INTO saved_views(id,owner_id,name,query_json,is_followed,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,query_json=excluded.query_json,is_followed=excluded.is_followed,updated_at=excluded.updated_at,version=saved_views.version+1")
                    .bind(id).bind(&self.owner_id).bind(name.trim()).bind(serde_json::to_string(query).map_err(|e|e.to_string())?).bind(followed).bind(&c.occurred_at).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                id
            }
            ViewAction::Delete {
                id,
                expected_version,
            } => {
                let affected=sqlx::query("UPDATE saved_views SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND version=? AND deleted_at IS NULL").bind(&c.occurred_at).bind(&c.occurred_at).bind(id).bind(&self.owner_id).bind(expected_version).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                if affected != 1 {
                    return Err("STATE_CONFLICT".into());
                }
                id
            }
        };
        sqlx::query("INSERT INTO content_events(id,owner_id,entity_id,kind,occurred_at,payload) VALUES(?,?,?,'saved_view',?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(entity).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        self.queue_operation(
            &mut tx,
            &c.operation_id,
            "saved_view",
            &payload,
            &c.occurred_at,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn view_snapshot(&self) -> StoreResult<Value> {
        let raw:Vec<(String,String,String,bool,i64)>=sqlx::query_as("SELECT id,name,query_json,is_followed,version FROM saved_views WHERE owner_id=? AND deleted_at IS NULL ORDER BY is_followed DESC,name,id").bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())?;
        let views:Vec<Value>=raw.into_iter().map(|(id,name,q,followed,version)|Ok(json!({"id":id,"name":name,"query":serde_json::from_str::<Value>(&q).map_err(|e|e.to_string())?,"followed":followed,"version":version}))).collect::<StoreResult<_>>()?;
        let projects: Vec<(String, String)> = sqlx::query_as(
            "SELECT id,name FROM projects WHERE owner_id=? AND deleted_at IS NULL ORDER BY name",
        )
        .bind(&self.owner_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let labels: Vec<(String, String)> =
            sqlx::query_as("SELECT id,name FROM labels WHERE owner_id=? ORDER BY name")
                .bind(&self.owner_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        let presets = vec![
            preset(
                "未安排独立任务",
                json!([[{"field":"independent","op":"eq","value":"true"},{"field":"plan","op":"empty","value":""},{"field":"status","op":"eq","value":"todo"}]]),
            ),
            preset(
                "集中推进",
                json!([[{"field":"nextAction","op":"eq","value":"true"},{"field":"status","op":"eq","value":"todo"},{"field":"unblocked","op":"eq","value":"true"},{"field":"projectActive","op":"eq","value":"true"}],[{"field":"nextAction","op":"eq","value":"true"},{"field":"status","op":"eq","value":"in_progress"},{"field":"unblocked","op":"eq","value":"true"},{"field":"projectActive","op":"eq","value":"true"}]]),
            ),
            preset(
                "零碎处理",
                json!([[{"field":"estimate","op":"lte","value":"15"},{"field":"status","op":"eq","value":"todo"},{"field":"unblocked","op":"eq","value":"true"}]]),
            ),
            preset(
                "等待跟进",
                json!([[{"field":"status","op":"eq","value":"waiting"},{"field":"followUp","op":"due","value":""}]]),
            ),
            preset(
                "本周期限",
                json!([[{"field":"deadline","op":"thisWeek","value":""}]]),
            ),
        ];
        Ok(
            json!({"views":views,"projects":projects.into_iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>(),"labels":labels.into_iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>(),"presets":presets}),
        )
    }
    pub async fn view_query(&self, q: &ViewQuery) -> StoreResult<Value> {
        validate_query(q)?;
        let zone_name: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        let zone: Tz = zone_name
            .as_deref()
            .unwrap_or("UTC")
            .parse()
            .map_err(|_| "USER:工作空间时区无效")?;
        let today = Utc::now().with_timezone(&zone).date_naive();
        let mut rows = Vec::<Value>::new();
        let queries=[
            ("task", "SELECT json_object('id',t.id,'type','task','title',t.title,'body',t.notes,'projectId',t.project_id,'projectName',p.name,'status',CASE WHEN t.waiting=1 THEN 'waiting' ELSE t.status END,'priority',t.priority_level,'estimate',t.default_estimated_minutes,'plan',json(t.plan_value),'deadline',json(t.deadline_value),'followUp',json(t.follow_up_value),'nextAction',json(CASE WHEN c.next_action_task_id=t.id THEN 'true' ELSE 'false' END),'independent',json(CASE WHEN t.project_id IS NULL THEN 'true' ELSE 'false' END),'projectActive',json(CASE WHEN p.status='active' AND p.canceled=0 THEN 'true' ELSE 'false' END),'unblocked',json(CASE WHEN t.status='blocked' OR EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks before ON before.id=d.predecessor_id WHERE d.task_id=t.id AND before.deleted_at IS NULL AND before.status NOT IN('completed','cancelled')) THEN 'false' ELSE 'true' END),'labels',json((SELECT json_group_array(label_id) FROM task_labels WHERE task_id=t.id)),'archived',p.archived_at IS NOT NULL,'created',t.created_at) FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN project_context c ON c.project_id=t.project_id WHERE t.owner_id=? AND t.deleted_at IS NULL AND (p.id IS NULL OR p.deleted_at IS NULL)"),
            ("project","SELECT json_object('id',p.id,'type','project','title',p.name,'body',p.outcome||' '||coalesce(c.definition_of_done,'')||' '||coalesce(c.blocker_text,'')||' '||coalesce(c.last_context,'')||' '||coalesce(c.restart_hint,''),'projectId',p.id,'projectName',p.name,'status',CASE WHEN p.canceled=1 THEN 'cancelled' ELSE p.status END,'archived',p.archived_at IS NOT NULL,'created',p.created_at) FROM projects p LEFT JOIN project_context c ON c.project_id=p.id WHERE p.owner_id=? AND p.deleted_at IS NULL"),
            ("record","SELECT json_object('id',r.id,'type','record','title',r.title,'body',r.body,'status',r.record_type,'projectIds',json((SELECT json_group_array(coalesce(p.id,t.project_id)) FROM record_links l LEFT JOIN projects p ON l.target_type='project' AND p.id=l.target_id AND p.deleted_at IS NULL LEFT JOIN tasks t ON l.target_type='task' AND t.id=l.target_id AND t.deleted_at IS NULL WHERE l.record_id=r.id)),'archived',0,'created',r.created_at) FROM records r WHERE r.owner_id=? AND r.deleted_at IS NULL"),
            ("habit","SELECT json_object('id',h.id,'type','habit','title',h.name,'body',h.notes||' '||h.trigger_context||' '||h.normal_version||' '||h.minimum_version,'projectId',h.project_id,'projectName',p.name,'status','habit','archived',p.archived_at IS NOT NULL,'created',h.created_at) FROM habits h LEFT JOIN projects p ON p.id=h.project_id WHERE h.owner_id=?")
        ];
        let text = q.text.to_lowercase();
        for (kind, sql) in queries {
            if q.entity_type != "all" && q.entity_type != kind {
                continue;
            }
            let found: Vec<String> = sqlx::query_scalar(sql)
                .bind(&self.owner_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            for raw in found {
                let row: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if !q.include_archived && row["archived"] == 1 {
                    continue;
                }
                if !format!(
                    "{} {}",
                    row["title"].as_str().unwrap_or(""),
                    row["body"].as_str().unwrap_or("")
                )
                .to_lowercase()
                .contains(&text)
                {
                    continue;
                }
                if q.project_id.as_ref().is_some_and(|id| {
                    row["projectId"] != *id
                        && !row["projectIds"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|v| v == id))
                }) {
                    continue;
                }
                if q.status.as_ref().is_some_and(|s| row["status"] != *s) {
                    continue;
                }
                if !q.groups.is_empty()
                    && (kind != "task"
                        || !q
                            .groups
                            .iter()
                            .any(|g| g.iter().all(|c| matches(&row, c, today, zone))))
                {
                    continue;
                }
                rows.push(row);
            }
        }
        let sort_key = |r: &Value| -> String {
            match q.sort.as_str() {
                "priority" => format!("{}", r["priority"].as_i64().unwrap_or(9)),
                "plan" | "deadline" | "followUp" => {
                    date_value(&r[&q.sort], zone).unwrap_or("9999-99-99".into())
                }
                _ => r[&q.sort].as_str().unwrap_or("").to_lowercase(),
            }
        };
        rows.sort_by_key(|r| (sort_key(r), r["id"].as_str().unwrap_or("").to_owned()));
        for row in &mut rows {
            row["group"] = match q.group_by.as_str() {
                "project" => row["projectName"]
                    .as_str()
                    .unwrap_or("独立 / 无项目")
                    .into(),
                "status" => row["status"].clone(),
                "priority" => row["priority"]
                    .as_i64()
                    .map(|n| json!(format!("P{n}")))
                    .unwrap_or(json!("无优先级")),
                "type" => row["type"].clone(),
                _ => json!("全部结果"),
            };
        }
        let snapshot = self.view_snapshot().await?;
        let mut warnings = Vec::<String>::new();
        let mut refs: Vec<(&str, &str)> = q
            .groups
            .iter()
            .flatten()
            .filter(|c| ["project", "label"].contains(&c.field.as_str()))
            .map(|c| (c.field.as_str(), c.value.as_str()))
            .collect();
        if let Some(id) = &q.project_id {
            refs.push(("project", id));
        }
        for (kind, id) in refs {
            let key = if kind == "project" {
                "projects"
            } else {
                "labels"
            };
            if !snapshot[key]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["id"] == id))
            {
                warnings.push(format!(
                    "{}引用已删除或不可用：{}",
                    if kind == "project" {
                        "项目"
                    } else {
                        "标签"
                    },
                    id
                ));
            }
        }
        warnings.sort();
        warnings.dedup();
        Ok(
            json!({"rows":rows,"warnings":warnings,"today":today.to_string(),"timeZone":zone.to_string()}),
        )
    }
}
