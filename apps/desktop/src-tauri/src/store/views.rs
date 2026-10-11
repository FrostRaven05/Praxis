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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_filter: Option<Value>,
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
pub(super) fn validate_query(q: &ViewQuery) -> StoreResult<()> {
    if let Some(filter) = &q.mobile_filter {
        validate_mobile_filter(filter)?;
    }
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
fn filter_text<'a>(filter: &'a Value, key: &str) -> &'a str {
    filter.get(key).and_then(Value::as_str).unwrap_or("")
}
fn validate_mobile_filter(filter: &Value) -> StoreResult<()> {
    if !filter.is_object() || filter_text(filter, "query").len() > 2000 {
        return Err("USER:手机视图筛选无效".into());
    }
    for (key, valid) in [
        (
            "kind",
            vec![
                "", "task", "project", "record", "habit", "strategy", "decision", "review",
            ],
        ),
        (
            "status",
            vec![
                "",
                "todo",
                "in_progress",
                "waiting",
                "blocked",
                "completed",
                "cancelled",
                "active",
                "paused",
                "draft",
                "archived",
            ],
        ),
        ("mode", vec!["", "and", "or"]),
        ("priority", vec!["", "0", "1", "2", "3"]),
        ("due", vec!["", "overdue", "today", "week"]),
        ("sort", vec!["", "title", "priority", "due", "updated"]),
        ("group", vec!["", "none", "kind", "project", "status"]),
        (
            "preset",
            vec!["", "unplanned", "focus", "small", "waiting", "week"],
        ),
    ] {
        if !valid.contains(&filter_text(filter, key)) {
            return Err(format!("USER:手机视图不支持筛选字段 {key}"));
        }
    }
    let project = filter_text(filter, "projectId");
    if !project.is_empty() {
        Uuid::parse_str(project).map_err(|_| "USER:手机视图项目引用无效")?;
    }
    Ok(())
}
fn mobile_matches(row: &Value, filter: &Value, today: NaiveDate, zone: Tz) -> bool {
    let kind = row["mobileKind"].as_str().unwrap_or("");
    let selected = filter_text(filter, "kind");
    if !selected.is_empty() && selected != kind {
        return false;
    }
    if filter.get("includeArchived") != Some(&json!(true))
        && (row["archived"] == 1 || row["mobileArchived"] == 1)
    {
        return false;
    }
    let status = row["mobileStatus"]
        .as_str()
        .or_else(|| row["status"].as_str())
        .unwrap_or("");
    let active = kind == "task" && !["completed", "cancelled"].contains(&status);
    let due = date_value(&row["deadline"], zone);
    let end = (today + Days::days(6)).to_string();
    let start = today.to_string();
    let priority = row["priority"].as_i64().map(|p| if p == 4 { 0 } else { p });
    match filter_text(filter, "preset") {
        "unplanned"
            if !active || row["projectId"].is_string() || row["executionDate"].is_string() =>
        {
            return false
        }
        "focus" if !active || !priority.is_some_and(|p| [1, 2].contains(&p)) => return false,
        "small" if !active || !row["estimate"].as_i64().is_some_and(|n| n > 0 && n <= 15) => {
            return false
        }
        "waiting" if !active || row["waiting"] != true => return false,
        "week" if !active || !due.as_ref().is_some_and(|d| d >= &start && d <= &end) => {
            return false
        }
        _ => {}
    }
    let mut checks = Vec::new();
    let text = filter_text(filter, "query");
    if !text.is_empty() {
        checks.push(
            format!(
                "{} {}",
                row["title"].as_str().unwrap_or(""),
                row["mobileBody"]
                    .as_str()
                    .or_else(|| row["body"].as_str())
                    .unwrap_or("")
            )
            .to_lowercase()
            .contains(&text.to_lowercase()),
        );
    }
    let selected_status = filter_text(filter, "status");
    if !selected_status.is_empty() {
        checks.push(status == selected_status);
    }
    let project = filter_text(filter, "projectId");
    if !project.is_empty() {
        checks.push(row["projectId"] == project || row["id"] == project);
    }
    let selected_priority = filter_text(filter, "priority");
    if !selected_priority.is_empty() {
        checks.push(kind == "task" && priority == selected_priority.parse().ok());
    }
    let selected_due = filter_text(filter, "due");
    if !selected_due.is_empty() {
        checks.push(due.as_ref().is_some_and(|d| match selected_due {
            "overdue" => d < &start,
            "today" => d == &start,
            _ => d >= &start && d <= &end,
        }));
    }
    checks.is_empty()
        || if filter_text(filter, "mode") == "or" {
            checks.into_iter().any(|v| v)
        } else {
            checks.into_iter().all(|v| v)
        }
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
                if (query.entity_type != "task" && query.mobile_filter.is_none())
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
        let mirror_rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id,kind,updated_at,json_extract(data,'$.status') FROM lan_entities",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let mirrors: std::collections::BTreeMap<_, _> = mirror_rows
            .into_iter()
            .map(|(id, kind, updated, status)| (id, (kind, updated, status)))
            .collect();
        let dates:Vec<(String,String)>=sqlx::query_as("SELECT task_id,max(execution_date) FROM daily_plan_items WHERE removed=0 GROUP BY task_id").fetch_all(&self.pool).await.map_err(|e|e.to_string())?;
        let execution_dates: std::collections::BTreeMap<_, _> = dates.into_iter().collect();
        let mut rows = Vec::<Value>::new();
        let queries=[
            ("task", "SELECT json_object('id',t.id,'type','task','title',t.title,'body',t.notes,'projectId',t.project_id,'projectName',p.name,'status',CASE WHEN t.waiting=1 THEN 'waiting' ELSE t.status END,'rawStatus',t.status,'priority',t.priority_level,'estimate',t.default_estimated_minutes,'plan',json(t.plan_value),'deadline',json(t.deadline_value),'followUp',json(t.follow_up_value),'nextAction',json(CASE WHEN c.next_action_task_id=t.id THEN 'true' ELSE 'false' END),'independent',json(CASE WHEN t.project_id IS NULL THEN 'true' ELSE 'false' END),'projectActive',json(CASE WHEN p.status='active' AND p.canceled=0 THEN 'true' ELSE 'false' END),'unblocked',json(CASE WHEN t.status='blocked' OR EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks before ON before.id=d.predecessor_id WHERE d.task_id=t.id AND before.deleted_at IS NULL AND before.status NOT IN('completed','cancelled')) THEN 'false' ELSE 'true' END),'labels',json((SELECT json_group_array(label_id) FROM task_labels WHERE task_id=t.id)),'archived',p.archived_at IS NOT NULL,'created',t.created_at) FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN project_context c ON c.project_id=t.project_id WHERE t.owner_id=? AND t.deleted_at IS NULL AND (p.id IS NULL OR p.deleted_at IS NULL)"),
            ("project","SELECT json_object('id',p.id,'type','project','title',p.name,'mobileBody','','deadline',json(CASE WHEN p.target_date IS NOT NULL THEN json_object('kind','date','date',p.target_date) ELSE 'null' END),'body',p.outcome||' '||coalesce(c.definition_of_done,'')||' '||coalesce(c.blocker_text,'')||' '||coalesce(c.last_context,'')||' '||coalesce(c.restart_hint,''),'projectId',p.id,'projectName',p.name,'status',CASE WHEN p.canceled=1 THEN 'cancelled' ELSE p.status END,'archived',p.archived_at IS NOT NULL,'created',p.created_at) FROM projects p LEFT JOIN project_context c ON c.project_id=p.id WHERE p.owner_id=? AND p.deleted_at IS NULL"),
            ("record","SELECT json_object('id',r.id,'type','record','title',r.title,'body',r.body,'status',r.record_type,'projectId',(SELECT target_id FROM record_links WHERE record_id=r.id AND target_type='project' ORDER BY target_id LIMIT 1),'projectName',(SELECT p.name FROM projects p JOIN record_links l ON l.target_id=p.id AND l.target_type='project' WHERE l.record_id=r.id ORDER BY p.id LIMIT 1),'projectIds',json((SELECT json_group_array(coalesce(p.id,t.project_id)) FROM record_links l LEFT JOIN projects p ON l.target_type='project' AND p.id=l.target_id AND p.deleted_at IS NULL LEFT JOIN tasks t ON l.target_type='task' AND t.id=l.target_id AND t.deleted_at IS NULL WHERE l.record_id=r.id)),'archived',0,'mobileArchived',(SELECT p.archived_at IS NOT NULL FROM projects p JOIN record_links l ON l.target_id=p.id AND l.target_type='project' WHERE l.record_id=r.id ORDER BY p.id LIMIT 1),'created',r.created_at) FROM records r WHERE r.owner_id=? AND r.deleted_at IS NULL"),
            ("habit","SELECT json_object('id',h.id,'type','habit','title',h.name,'mobileBody',h.notes,'body',h.notes||' '||h.trigger_context||' '||h.normal_version||' '||h.minimum_version,'projectId',h.project_id,'projectName',p.name,'status','habit','archived',p.archived_at IS NOT NULL,'created',h.created_at) FROM habits h LEFT JOIN projects p ON p.id=h.project_id WHERE h.owner_id=? AND h.deleted_at IS NULL AND (h.project_id IS NULL OR p.deleted_at IS NULL)")
        ];
        let text = q.text.to_lowercase();
        for (kind, sql) in queries {
            if q.mobile_filter.is_none() && q.entity_type != "all" && q.entity_type != kind {
                continue;
            }
            let found: Vec<String> = sqlx::query_scalar(sql)
                .bind(&self.owner_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            for raw in found {
                let mut row: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if let Some(filter) = &q.mobile_filter {
                    let id = row["id"].as_str().unwrap_or("").to_string();
                    let mirror = mirrors.get(&id);
                    row["mobileKind"] = json!(mirror.map(|m| m.0.as_str()).unwrap_or(kind));
                    row["updated"] = json!(mirror
                        .map(|m| m.1.as_str())
                        .unwrap_or_else(|| row["created"].as_str().unwrap_or("")));
                    row["executionDate"] = json!(execution_dates.get(&id));
                    if kind == "task" {
                        row["waiting"] = json!(row["status"] == "waiting");
                        if row["status"] == "waiting" {
                            row["mobileStatus"] = json!(mirror
                                .and_then(|m| m.2.as_deref())
                                .filter(|s| *s == "waiting")
                                .unwrap_or_else(|| row["rawStatus"].as_str().unwrap_or("todo")));
                        }
                    }
                    if !mobile_matches(&row, filter, today, zone) {
                        continue;
                    }
                    rows.push(row);
                    continue;
                }
                if !q.include_archived && (row["archived"] == 1 || row["mobileArchived"] == 1) {
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
        let selected_sort = q
            .mobile_filter
            .as_ref()
            .map(|f| filter_text(f, "sort"))
            .unwrap_or(q.sort.as_str());
        let sort_key = |r: &Value| -> String {
            match selected_sort {
                "priority" => format!(
                    "{}",
                    r["priority"]
                        .as_i64()
                        .unwrap_or(if q.mobile_filter.is_some() { 4 } else { 9 })
                ),
                "due" => date_value(&r["deadline"], zone).unwrap_or("9999-99-99".into()),
                "plan" | "deadline" | "followUp" => {
                    date_value(&r[selected_sort], zone).unwrap_or("9999-99-99".into())
                }
                _ => r[selected_sort].as_str().unwrap_or("").to_lowercase(),
            }
        };
        if selected_sort == "updated" || (q.mobile_filter.is_some() && selected_sort.is_empty()) {
            rows.sort_by(|a, b| {
                b["updated"]
                    .as_str()
                    .cmp(&a["updated"].as_str())
                    .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            });
        } else {
            rows.sort_by_key(|r| (sort_key(r), r["id"].as_str().unwrap_or("").to_owned()));
        }
        let group_by = q
            .mobile_filter
            .as_ref()
            .map(|f| filter_text(f, "group"))
            .unwrap_or(q.group_by.as_str());
        for row in &mut rows {
            row["group"] = match group_by {
                "project" => row["projectName"]
                    .as_str()
                    .unwrap_or("独立 / 无项目")
                    .into(),
                "status" => row.get("mobileStatus").unwrap_or(&row["status"]).clone(),
                "kind" => row["mobileKind"].clone(),
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
        if let Some(filter) = &q.mobile_filter {
            let project = filter_text(filter, "projectId");
            if !project.is_empty() {
                refs.push(("project", project));
            }
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
