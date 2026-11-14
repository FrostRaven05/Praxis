//! Versioned, atomic full-workspace replication. Wire versions never replace local CAS versions.
use super::*;
use serde_json::{json, Map, Value};
use sqlx::{Row, Sqlite, Transaction};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
#[path = "entity_identity.rs"]
mod identity;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub kind: String,
    pub version: i64,
    pub data: Value,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub kind: String,
    pub expected_version: Option<i64>,
    pub data: Value,
    pub deleted: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_data: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub operation_id: String,
    pub device_id: String,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub entities: Vec<Entity>,
    pub cursor: i64,
    pub operation_id: String,
    pub device_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub changes: Vec<Batch>,
    pub cursor: i64,
    pub has_more: bool,
}
const TABLES: &[(&str, &str)] = &[
    ("captures", "capture"),
    ("projects", "project"),
    ("sections", "section"),
    ("recurrence_templates", "recurrence"),
    ("tasks", "task"),
    ("records", "record"),
    ("habits", "habit"),
    ("saved_views", "view"),
    ("workspace_settings", "settings"),
    ("labels", "desktop_row"),
    ("daily_plan_items", "desktop_row"),
    ("execution_records", "desktop_row"),
    ("task_labels", "desktop_row"),
    ("day_preferences", "desktop_row"),
    ("day_notes", "desktop_row"),
    ("project_schedules", "desktop_row"),
    ("task_dependencies", "desktop_row"),
    ("record_links", "desktop_row"),
    ("resolutions", "desktop_row"),
    ("project_context", "desktop_row"),
    ("habit_schedules", "desktop_row"),
    ("habit_entries", "desktop_row"),
    ("habit_daily_plans", "desktop_row"),
    ("recurrence_rules", "desktop_row"),
    ("weekly_reviews", "desktop_row"),
    ("review_settings", "desktop_row"),
    ("trash_settings", "desktop_row"),
    ("trash_batches", "desktop_row"),
    ("deletion_tombstones", "desktop_row"),
    ("domain_events", "desktop_row"),
    ("project_events", "desktop_row"),
    ("day_events", "desktop_row"),
    ("content_events", "desktop_row"),
    ("habit_events", "desktop_row"),
];
const EPOCH: &str = "1970-01-01T00:00:00Z";
fn err(e: sqlx::Error) -> String {
    e.to_string()
}
fn val<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}
fn s(v: &Value, k: &str) -> String {
    val(v, k).as_str().unwrap_or("").into()
}
fn number(v: &Value, k: &str) -> i64 {
    val(v, k).as_i64().unwrap_or(0)
}
fn parse(v: &Value) -> Value {
    v.as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn time_date(value: &Value, fallback_zone: &str) -> Value {
    if let Some(date) = value.get("date") {
        return date.clone();
    }
    if s(value, "kind") == "instant" {
        let zone = value
            .get("displayTimezone")
            .and_then(Value::as_str)
            .unwrap_or(fallback_zone)
            .parse::<Tz>();
        if let (Ok(zone), Ok(at)) = (zone, DateTime::parse_from_rfc3339(&s(value, "atUtc"))) {
            return json!(at.with_timezone(&zone).date_naive().to_string());
        }
    }
    Value::Null
}
fn stable(table: &str, key: &Value) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("praxis:{table}:{key}").as_bytes(),
    )
    .to_string()
}
fn projection(e: &Entity) -> Value {
    json!({"kind":e.kind,"data":e.data,"deleted":e.deleted})
}
fn capture_projection_created(value: &Value, created: &str) -> Value {
    let mut value = value.clone();
    if s(&value, "kind") == "capture" {
        if let Some(desktop) = value["data"]
            .get_mut("desktop")
            .and_then(Value::as_object_mut)
        {
            desktop.insert("created_at".into(), json!(created));
        }
    }
    value
}
fn capture_business(data: &Value) -> Value {
    let mut data = data.clone();
    let fields = data.as_object_mut().unwrap();
    fields.remove("desktop");
    if !fields.contains_key("status") {
        fields.insert(
            "status".into(),
            json!(if fields.get("state") == Some(&json!("processed")) {
                "clarified"
            } else {
                "inbox"
            }),
        );
    }
    if !fields.contains_key("state") {
        fields.insert(
            "state".into(),
            json!(if fields.get("status") == Some(&json!("clarified")) {
                "processed"
            } else {
                "pending"
            }),
        );
    }
    fields.entry("outputs").or_insert(json!([]));
    for key in ["resolutionId", "lastOutputs"] {
        if fields
            .get(key)
            .is_some_and(|v| v.is_null() || v == &json!([]) || v == "")
        {
            fields.remove(key);
        }
    }
    data
}
async fn columns(
    tx: &mut Transaction<'_, Sqlite>,
    table: &str,
) -> StoreResult<Vec<(String, String, i64, Option<String>, i64)>> {
    sqlx::query_as(&format!(
        "SELECT name,type,\"notnull\",dflt_value,pk FROM pragma_table_info('{table}')"
    ))
    .fetch_all(&mut **tx)
    .await
    .map_err(err)
}
async fn rows(tx: &mut Transaction<'_, Sqlite>, table: &str) -> StoreResult<Vec<Value>> {
    let cols = columns(tx, table).await?;
    let args = cols
        .iter()
        .map(|(c, _, _, _, _)| format!("'{c}',\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let raw: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT json_object({args}) FROM \"{table}\" ORDER BY rowid"
    ))
    .fetch_all(&mut **tx)
    .await
    .map_err(err)?;
    raw.into_iter()
        .map(|r| serde_json::from_str(&r).map_err(|e| e.to_string()))
        .collect()
}
async fn mirrors(tx: &mut Transaction<'_, Sqlite>) -> StoreResult<BTreeMap<String, Entity>> {
    let raw: Vec<(String, String, i64, String, bool, String, String)> = sqlx::query_as(
        "SELECT id,kind,version,data,deleted,created_at,updated_at FROM lan_entities",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(err)?;
    raw.into_iter()
        .map(
            |(id, kind, version, data, deleted, created_at, updated_at)| {
                Ok((
                    id.clone(),
                    Entity {
                        id,
                        kind,
                        version,
                        data: serde_json::from_str(&data).map_err(|e| e.to_string())?,
                        deleted,
                        created_at,
                        updated_at,
                    },
                ))
            },
        )
        .collect()
}
fn overlay(d: &mut Value, r: &Value, pairs: &[(&str, &str)]) {
    for (a, b) in pairs {
        d[*a] = val(r, b).clone();
    }
}
fn native_view_query(data: &Value) -> StoreResult<Value> {
    let query = if let Some(query) = data
        .get("nativeQuery")
        .filter(|q| q.is_object())
        .or_else(|| data.get("query").filter(|q| q.is_object()))
    {
        query.clone()
    } else {
        let mut filter = json!({"query":"","kind":"","status":"","projectId":"","mode":"and","includeArchived":false,"priority":"","due":"","sort":"updated","group":"kind","preset":""});
        for key in [
            "query",
            "kind",
            "status",
            "projectId",
            "mode",
            "includeArchived",
            "priority",
            "due",
            "sort",
            "group",
            "preset",
        ] {
            if let Some(value) = data.get(key) {
                filter[key] = value.clone();
            }
        }
        json!({"text":"","entityType":"all","projectId":null,"status":null,"includeArchived":true,"groups":[],"sort":"title","groupBy":"none","mobileFilter":filter})
    };
    let typed: super::ViewQuery =
        serde_json::from_value(query.clone()).map_err(|_| "同步保存视图筛选格式无效")?;
    super::views::validate_query(&typed)?;
    Ok(query)
}
fn structured_review_body(data: &Value) -> StoreResult<Option<String>> {
    let keys = [
        "periodStart",
        "periodEnd",
        "achievements",
        "blockers",
        "stopPause",
        "nextFocus",
    ];
    if !keys.iter().any(|k| data.get(*k).is_some()) {
        return Ok(None);
    }
    if keys
        .iter()
        .any(|k| !data.get(*k).is_some_and(Value::is_string))
    {
        return Err("结构化回顾字段不完整".into());
    }
    let start = s(data, "periodStart");
    let end = s(data, "periodEnd");
    validate_date(&start)?;
    validate_date(&end)?;
    if start > end {
        return Err("回顾期间无效".into());
    }
    Ok(Some(format!(
        "期间：{start} — {end}\n\n推进成果\n{}\n\n阻塞\n{}\n\n停止 / 暂停\n{}\n\n下周重点\n{}",
        s(data, "achievements"),
        s(data, "blockers"),
        s(data, "stopPause"),
        s(data, "nextFocus")
    )))
}
fn extended_interval(row: &Value) -> i64 {
    val(row, "interval_days_extended")
        .as_i64()
        .unwrap_or_else(|| number(row, "interval_days"))
        .max(1)
}
fn wire_weekdays(row: &Value) -> Value {
    json!(parse(val(row, "weekdays"))
        .as_array()
        .map(|a| a
            .iter()
            .map(|n| json!(n.as_i64().unwrap_or(1) % 7))
            .collect::<Vec<_>>())
        .unwrap_or_default())
}
async fn snapshot(tx: &mut Transaction<'_, Sqlite>) -> StoreResult<BTreeMap<String, Entity>> {
    let mut old = mirrors(tx).await?;
    let locals: Vec<String> = sqlx::query_scalar("SELECT payload FROM lan_entity_local")
        .fetch_all(&mut **tx)
        .await
        .map_err(err)?;
    for raw in locals {
        let e: Entity = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        old.insert(e.id.clone(), e);
    }
    let mut out = BTreeMap::new();
    let zone: Option<String> =
        sqlx::query_scalar("SELECT time_zone FROM workspace_settings LIMIT 1")
            .fetch_optional(&mut **tx)
            .await
            .map_err(err)?;
    let zone = zone.unwrap_or("Asia/Hong_Kong".into());
    for (table, kind) in TABLES {
        let cols = columns(tx, table).await?;
        for row in rows(tx, table).await? {
            let key: Map<String, Value> = cols
                .iter()
                .filter(|(c, _, _, _, pk)| *pk > 0 && c != "owner_id")
                .map(|(c, _, _, _, _)| (c.clone(), val(&row, c).clone()))
                .collect();
            let key = Value::Object(key);
            let id = if *kind != "desktop_row" && *kind != "settings" {
                s(&row, "id")
            } else if *kind == "settings" {
                old.values()
                    .find(|e| e.kind == "settings")
                    .map(|e| e.id.clone())
                    .unwrap_or_else(|| stable(table, &key))
            } else {
                stable(table, &key)
            };
            let aliases = if *kind == "desktop_row" {
                identity::aliases(tx, table, &key).await?
            } else {
                vec![]
            };
            let ids = if aliases.is_empty() {
                vec![id]
            } else {
                aliases
            };
            for id in ids {
                let mut row = row.clone();
                let wire_kind = if *kind == "record" {
                    old.get(&id)
                        .filter(|e| {
                            ["record", "review", "strategy", "decision"].contains(&e.kind.as_str())
                        })
                        .map(|e| e.kind.clone())
                        .unwrap_or_else(|| {
                            if s(&row, "record_type") == "review" {
                                "review".into()
                            } else if s(&row, "record_type") == "decision" {
                                "decision".into()
                            } else {
                                "record".into()
                            }
                        })
                } else {
                    kind.to_string()
                };
                let mut d = old.get(&id).map(|e| e.data.clone()).unwrap_or(json!({}));
                let version = number(&row, "version");
                row.as_object_mut().unwrap().remove("owner_id");
                if *table != "habit_schedules" {
                    row.as_object_mut().unwrap().remove("version");
                }
                // plan revision is local optimistic concurrency, not portable domain state.
                row.as_object_mut().unwrap().remove("plan_version");
                if *kind == "desktop_row" {
                    let row = if let Some(e) = old.get(&id) {
                        identity::wire_row(tx, e, &row).await?
                    } else {
                        row.clone()
                    };
                    d = json!({"table":table,"row":row});
                } else {
                    // Overlay current native fields while retaining opaque extensions
                    // received from another version/device. Local identities/CAS stay local.
                    let mut desktop = d.get("desktop").and_then(Value::as_object).cloned().unwrap_or_default();
                    desktop.remove("owner_id");
                    desktop.remove("plan_version");
                    if *table != "habit_schedules" { desktop.remove("version"); }
                    desktop.extend(row.as_object().unwrap().clone());
                    d["desktop"] = Value::Object(desktop);
                    match *kind {
                        "capture" => {
                            overlay(&mut d, &row, &[("rawText", "raw_text"), ("state", "state")]);
                            let processed = s(&row, "state") == "processed";
                            d["status"] = json!(if processed { "clarified" } else { "inbox" });
                            let resolution = s(&row, "resolution_id");
                            let output_text: Option<String> = sqlx::query_scalar(
                                "SELECT outputs FROM resolutions WHERE id=? AND capture_id=?",
                            )
                            .bind(&resolution)
                            .bind(&id)
                            .fetch_optional(&mut **tx)
                            .await
                            .map_err(err)?;
                            let native_outputs = output_text
                                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                                .unwrap_or_default();
                            let previous = d
                                .get(if processed { "outputs" } else { "lastOutputs" })
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            let refs=native_outputs.iter().map(|o|previous.iter().find(|p|val(p,"id")==val(o,"id")&&val(p,"kind")==val(o,"kind")).cloned().unwrap_or_else(||json!({"id":val(o,"id"),"kind":val(o,"kind"),"version":1}))).collect::<Vec<_>>();
                            if processed {
                                d["outputs"] = json!(refs);
                                d["resolutionId"] = json!(resolution);
                            } else {
                                // Retain the frozen receipt for safe undo history, never replace it with a target's new revision.
                                if !refs.is_empty() {
                                    d["lastOutputs"] = json!(refs);
                                }
                                d["outputs"] = json!([]);
                            }
                        }
                        "task" => {
                            overlay(
                                &mut d,
                                &row,
                                &[
                                    ("title", "title"),
                                    ("status", "status"),
                                    ("notes", "notes"),
                                    ("completedAt", "completed_at"),
                                    ("completionCriteria", "completion_criteria"),
                                    ("estimatedMinutes", "default_estimated_minutes"),
                                    ("projectId", "project_id"),
                                    ("sectionId", "section_id"),
                                    ("parentId", "parent_task_id"),
                                    ("waitingFor", "waiting_for"),
                                    ("waitingReason", "waiting_note"),
                                    ("sourceCaptureId", "source_capture_id"),
                                    ("recurrenceId", "recurrence_template_id"),
                                    ("originalDate", "occurrence_key"),
                                ],
                            );
                            let priority = number(&row, "priority_level");
                            d["priority"] = json!(if priority == 4 {
                                0
                            } else {
                                priority.clamp(1, 3)
                            });
                            d["waiting"] = json!(number(&row, "waiting") == 1);
                            if number(&row, "waiting") == 1
                                && old
                                    .get(&id)
                                    .is_some_and(|e| s(&e.data, "status") == "waiting")
                            {
                                d["status"] = json!("waiting");
                            }
                            for (a, b) in [
                                ("startDate", "plan_value"),
                                ("dueDate", "deadline_value"),
                                ("followUpDate", "follow_up_value"),
                            ] {
                                let t = parse(val(&row, b));
                                d[a] = time_date(&t, &zone);
                            }
                            let date:Option<String>=sqlx::query_scalar("SELECT execution_date FROM daily_plan_items WHERE task_id=? AND removed=0 ORDER BY execution_date DESC LIMIT 1").bind(&id).fetch_optional(&mut **tx).await.map_err(err)?;
                            d["executionDate"] = json!(date);
                            let tags:Vec<String>=sqlx::query_scalar("SELECT l.name FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=? ORDER BY l.name").bind(&id).fetch_all(&mut **tx).await.map_err(err)?;
                            d["tags"] = json!(tags);
                        }
                        "project" => {
                            overlay(
                                &mut d,
                                &row,
                                &[
                                    ("title", "name"),
                                    ("outcome", "outcome"),
                                    ("dueDate", "target_date"),
                                    ("archivedAt", "archived_at"),
                                ],
                            );
                            d["status"] = json!(if number(&row, "canceled") == 1 {
                                "cancelled"
                            } else if ["completed", "archived"]
                                .contains(&s(&row, "status").as_str())
                            {
                                "completed"
                            } else {
                                "active"
                            });
                            let ctx = rows(tx, "project_context")
                                .await?
                                .into_iter()
                                .find(|x| s(x, "project_id") == id);
                            if let Some(c) = ctx {
                                overlay(
                                    &mut d,
                                    &c,
                                    &[
                                        ("completionCriteria", "definition_of_done"),
                                        ("blocker", "blocker_text"),
                                        ("reviewDate", "review_date"),
                                        ("nextActionId", "next_action_task_id"),
                                        ("recoveryNote", "restart_hint"),
                                    ],
                                );
                            }
                        }
                        "section" => overlay(
                            &mut d,
                            &row,
                            &[("title", "name"), ("projectId", "project_id")],
                        ),
                        "record" => {
                            overlay(
                                &mut d,
                                &row,
                                &[
                                    ("title", "title"),
                                    ("body", "body"),
                                    ("type", "record_type"),
                                    ("sourceCaptureId", "source_capture_id"),
                                ],
                            );
                            let links:Vec<(String,String)>=sqlx::query_as("SELECT target_type,target_id FROM record_links WHERE record_id=? ORDER BY target_type,target_id").bind(&id).fetch_all(&mut **tx).await.map_err(err)?;
                            d["links"] = json!(links
                                .iter()
                                .map(|(kind, id)| json!({"targetType":kind,"targetId":id}))
                                .collect::<Vec<_>>());
                            for (kind, key) in [("project", "projectId"), ("task", "taskId")] {
                                d[key] =
                                    json!(links.iter().find(|(k, _)| k == kind).map(|(_, id)| id));
                            }
                            if let Some(review) = rows(tx, "weekly_reviews")
                                .await?
                                .into_iter()
                                .find(|r| s(r, "record_id") == id)
                            {
                                overlay(
                                    &mut d,
                                    &review,
                                    &[
                                        ("periodStart", "period_start"),
                                        ("periodEnd", "period_end"),
                                        ("achievements", "achievements"),
                                        ("blockers", "blockers"),
                                        ("stopPause", "stop_pause"),
                                        ("nextFocus", "next_focus"),
                                    ],
                                );
                            }
                        }
                        "habit" => {
                            overlay(
                                &mut d,
                                &row,
                                &[
                                    ("title", "name"),
                                    ("notes", "notes"),
                                    ("projectId", "project_id"),
                                    ("startDate", "start_date"),
                                    ("trigger", "trigger_context"),
                                    ("normalVersion", "normal_version"),
                                    ("minimumVersion", "minimum_version"),
                                ],
                            );
                            let schedules = rows(tx, "habit_schedules")
                                .await?
                                .into_iter()
                                .filter(|r| s(r, "habit_id") == id)
                                .collect::<Vec<_>>();
                            let mut history:Vec<Value>=schedules.iter().map(|r|json!({"effectiveDate":val(r,"effective_from"),"frequency":if number(r,"interval_days")>1{json!("interval")}else{val(r,"frequency").clone()},"weekdays":parse(val(r,"weekdays")).as_array().map(|a|a.iter().map(|n|json!(n.as_i64().unwrap_or(1)%7)).collect::<Vec<_>>()).unwrap_or_default(),"target":val(r,"weekly_target"),"paused":number(r,"paused")==1,"timeZone":val(r,"time_zone").as_str().unwrap_or(&zone),"interval":number(r,"interval_days").max(1)})).collect();
                            history.sort_by_key(|r| s(r, "effectiveDate"));
                            if let Some(latest) = history.last() {
                                for k in [
                                    "frequency",
                                    "weekdays",
                                    "target",
                                    "paused",
                                    "timeZone",
                                    "interval",
                                    "effectiveDate",
                                ] {
                                    d[k] = val(latest, k).clone();
                                }
                            }
                            d["ruleHistory"] = json!(history);
                        }
                        "recurrence" => {
                            overlay(
                                &mut d,
                                &row,
                                &[
                                    ("title", "title"),
                                    ("projectId", "project_id"),
                                    ("startDate", "start_date"),
                                    ("timeZone", "time_zone"),
                                ],
                            );
                            d["interval"] = json!(extended_interval(&row));
                            d["frequency"] = json!(if parse(val(&row, "weekdays"))
                                .as_array()
                                .is_some_and(|v| !v.is_empty())
                            {
                                "weekdays"
                            } else {
                                "interval"
                            });
                            d["weekdays"] = wire_weekdays(&row);
                            d["enabled"] = json!(number(&row, "enabled") == 1);
                            d["active"] = d["enabled"].clone();
                            let mut rules = rows(tx, "recurrence_rules")
                                .await?
                                .into_iter()
                                .filter(|r| s(r, "template_id") == id)
                                .collect::<Vec<_>>();
                            rules.sort_by_key(|r| s(r, "effective_date"));
                            d["ruleHistory"]=json!(rules.iter().map(|r|json!({"effectiveDate":val(r,"effective_date"),"anchorDate":val(r,"anchor_date"),"title":val(r,"title"),"frequency":if parse(val(r,"weekdays")).as_array().is_some_and(|v|!v.is_empty()){"weekdays"}else{"interval"},"weekdays":wire_weekdays(r),"interval":extended_interval(r),"timeZone":val(r,"time_zone"),"active":number(&row,"enabled")==1&&number(r,"active")==1})).collect::<Vec<_>>());
                        }
                        "view" => {
                            overlay(&mut d, &row, &[("title", "name")]);
                            let query = parse(val(&row, "query_json"));
                            d["nativeQuery"] = query.clone();
                            if !d.get("query").is_some_and(Value::is_string) {
                                d["query"] = json!(s(&query, "text"));
                            }
                            d["followed"] = json!(number(&row, "followed") == 1);
                        }
                        "settings" => overlay(&mut d, &row, &[("timeZone", "time_zone")]),
                        _ => {}
                    }
                }
                let deleted =
                    val(&row, "deleted_at").is_string() || number(&row, "sync_deleted") == 1;
                let mut created = val(&row, "created_at")
                    .as_str()
                    .unwrap_or(EPOCH)
                    .to_string();
                if *kind == "capture" {
                    if let Some(remote) = old.get(&id) {
                        // A legacy v1 server stamped first receipt time. Wire CAS
                        // keeps that immutable value; native history keeps its own.
                        created = remote.created_at.clone();
                        d["desktop"]["created_at"] = json!(created);
                    }
                }
                out.insert(
                    id.clone(),
                    Entity {
                        id,
                        kind: wire_kind,
                        version: version + 1,
                        data: d,
                        deleted,
                        created_at: created,
                        updated_at: EPOCH.into(),
                    },
                );
            }
        }
    }
    // A daily plan is one canonical entity; native detail rows retain ranks, periods and history.
    for row in rows(tx, "day_notes").await? {
        let date = s(&row, "date");
        let existing = old
            .values()
            .find(|e| e.kind == "plan" && s(&e.data, "date") == date);
        let id = existing
            .map(|e| e.id.clone())
            .unwrap_or_else(|| stable("plan", &json!(date)));
        let mut data = existing.map(|e| e.data.clone()).unwrap_or(json!({}));
        data["date"] = json!(date);
        data["outcome"] = val(&row, "outcome").clone();
        data["note"] = val(&row, "closing").clone();
        data["taskIds"] = parse(val(&row, "focus_ids"));
        out.insert(
            id.clone(),
            Entity {
                id,
                kind: "plan".into(),
                version: number(&row, "version") + 1,
                data,
                deleted: false,
                created_at: existing
                    .map(|e| e.created_at.clone())
                    .unwrap_or(EPOCH.into()),
                updated_at: EPOCH.into(),
            },
        );
    }
    for row in rows(tx, "habit_entries").await? {
        let habit = s(&row, "habit_id");
        let date = s(&row, "local_date");
        let existing = old.values().find(|e| {
            e.kind == "habit_check" && s(&e.data, "habitId") == habit && s(&e.data, "date") == date
        });
        let id = existing
            .map(|e| e.id.clone())
            .unwrap_or_else(|| stable("habit_check", &json!([habit, date])));
        let mut data = existing.map(|e| e.data.clone()).unwrap_or(json!({}));
        overlay(
            &mut data,
            &row,
            &[
                ("habitId", "habit_id"),
                ("date", "local_date"),
                ("status", "status"),
                ("note", "note"),
                ("timeZone", "timezone"),
                ("recordedAt", "occurred_at"),
            ],
        );
        if val(&row, "status").is_null() {
            if let Some(prior) = existing {
                // A check's tombstone represents undo. Its historical status and
                // timestamp stay available for restoring the same check identity.
                if ["done", "skipped"].contains(&s(&prior.data, "status").as_str()) {
                    data["status"] = val(&prior.data, "status").clone();
                }
                if let Some(recorded) = prior.data.get("recordedAt") {
                    data["recordedAt"] = recorded.clone();
                }
            }
        }
        out.insert(
            id.clone(),
            Entity {
                id,
                kind: "habit_check".into(),
                version: number(&row, "version") + 1,
                data,
                deleted: val(&row, "status").is_null(),
                created_at: existing
                    .map(|e| e.created_at.clone())
                    .unwrap_or_else(|| s(&row, "occurred_at")),
                updated_at: EPOCH.into(),
            },
        );
    }
    // Mobile-native entities are stored losslessly and edited through the shared workspace editor.
    for (id, e) in old {
        if !out.contains_key(&id) {
            let native = TABLES.iter().any(|(_, k)| *k == e.kind)
                || ["review", "strategy", "decision"].contains(&e.kind.as_str());
            let mut e = e;
            if native {
                e.deleted = true;
            }
            out.insert(id, e);
        }
    }
    Ok(out)
}
fn check(e: &Entity) -> StoreResult<()> {
    Uuid::parse_str(&e.id).map_err(|_| "无效同步实体标识")?;
    if e.version < 1
        || !e.data.is_object()
        || chrono::DateTime::parse_from_rfc3339(&e.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&e.updated_at).is_err()
    {
        return Err("无效同步实体".into());
    }
    if e.kind == "desktop_row"
        && !TABLES
            .iter()
            .any(|(t, k)| *k == "desktop_row" && *t == s(&e.data, "table"))
    {
        return Err("未知原生数据表".into());
    }
    Ok(())
}
async fn save_mirror(tx: &mut Transaction<'_, Sqlite>, e: &Entity) -> StoreResult<()> {
    check(e)?;
    sqlx::query("INSERT INTO lan_entities(id,kind,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,version=excluded.version,data=excluded.data,deleted=excluded.deleted,created_at=excluded.created_at,updated_at=excluded.updated_at").bind(&e.id).bind(&e.kind).bind(e.version).bind(e.data.to_string()).bind(e.deleted).bind(&e.created_at).bind(&e.updated_at).execute(&mut **tx).await.map_err(err)?;
    Ok(())
}
fn copy_fields(r: &mut Value, d: &Value, pairs: &[(&str, &str)]) {
    for (a, b) in pairs {
        if let Some(v) = d.get(*a) {
            r[*b] = v.clone();
        }
    }
}
async fn native_row(
    tx: &mut Transaction<'_, Sqlite>,
    e: &Entity,
    owner: &str,
) -> StoreResult<Option<(String, Value)>> {
    let table = if ["review", "strategy", "decision"].contains(&e.kind.as_str()) {
        "records".into()
    } else if e.kind == "desktop_row" {
        s(&e.data, "table")
    } else {
        TABLES
            .iter()
            .find(|(_, k)| *k == e.kind)
            .map(|(t, _)| t.to_string())
            .unwrap_or_default()
    };
    if table.is_empty() {
        return Ok(None);
    }
    let d = &e.data;
    let existing_row = rows(tx, &table)
        .await?
        .into_iter()
        .find(|r| s(r, "id") == e.id || (e.kind == "settings" && s(r, "owner_id") == owner));
    let current_row = existing_row.clone();
    let mut r = if e.kind == "desktop_row" {
        val(d, "row").clone()
    } else {
        d.get("desktop")
            .filter(|v| v.is_object())
            .cloned()
            .or(existing_row)
            .unwrap_or(json!({}))
    };
    if !r.is_object() {
        return Err("无效原生数据".into());
    }
    if e.kind != "desktop_row" {
        r["id"] = json!(e.id);
        r["created_at"] = json!(e.created_at);
        if e.kind == "capture" {
            if let Some(created) = current_row
                .as_ref()
                .and_then(|r| r.get("created_at"))
                .filter(|v| v.is_string())
            {
                r["created_at"] = created.clone();
            }
        }
        r["updated_at"] = json!(e.updated_at);
        match e.kind.as_str() {
            "capture" => {
                copy_fields(&mut r, d, &[("rawText", "raw_text"), ("state", "state")]);
                if d.get("status").is_some() {
                    r["state"] = json!(if s(d, "status") == "clarified" {
                        "processed"
                    } else {
                        "pending"
                    });
                }
                r["sync_deleted"] = json!(if e.deleted { 1 } else { 0 });
            }
            "task" => {
                copy_fields(
                    &mut r,
                    d,
                    &[
                        ("title", "title"),
                        ("status", "status"),
                        ("notes", "notes"),
                        ("completedAt", "completed_at"),
                        ("completionCriteria", "completion_criteria"),
                        ("estimatedMinutes", "default_estimated_minutes"),
                        ("projectId", "project_id"),
                        ("sectionId", "section_id"),
                        ("parentId", "parent_task_id"),
                        ("waitingFor", "waiting_for"),
                        ("waitingReason", "waiting_note"),
                        ("sourceCaptureId", "source_capture_id"),
                        ("recurrenceId", "recurrence_template_id"),
                        ("originalDate", "occurrence_key"),
                    ],
                );
                if r.get("source").is_none() {
                    r["source"] = json!("temporary");
                }
                let priority = number(d, "priority").clamp(0, 3);
                r["priority_level"] = json!(if priority == 0 { 4 } else { priority });
                r["waiting"] = json!(if val(d, "waiting") == &json!(true)
                    || s(d, "status") == "waiting"
                {
                    1
                } else {
                    0
                });
                if s(d, "status") == "waiting" {
                    r["status"] = json!("todo");
                }
                for (a, b) in [
                    ("startDate", "plan_value"),
                    ("dueDate", "deadline_value"),
                    ("followUpDate", "follow_up_value"),
                ] {
                    if d.get(a).is_some() {
                        let date = val(d, a);
                        let existing = parse(val(&r, b));
                        let zone: Option<String> = sqlx::query_scalar(
                            "SELECT time_zone FROM workspace_settings WHERE owner_id=?",
                        )
                        .bind(owner)
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(err)?;
                        let zone = zone.unwrap_or("Asia/Hong_Kong".into());
                        let prior: Option<String> =
                            sqlx::query_scalar("SELECT data FROM lan_entities WHERE id=?")
                                .bind(&e.id)
                                .fetch_optional(&mut **tx)
                                .await
                                .map_err(err)?;
                        let prior = prior.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
                        let actual = parse(
                            current_row
                                .as_ref()
                                .map(|row| val(row, b))
                                .unwrap_or(&Value::Null),
                        );
                        let typed_changed = d.get("desktop").and_then(|desktop| desktop.get(b)).is_some()
                            && prior.as_ref().is_some_and(|wire| val(val(wire, "desktop"), b) != val(val(d, "desktop"), b));
                        if typed_changed && time_date(&existing, &zone) == *date {
                            // A new personal command can explicitly replace an instant with
                            // a same-day date (or another instant). Unchanged extensions below
                            // still preserve exact native precision for older phone editors.
                        } else if s(&actual, "kind") == "instant"
                            && prior.as_ref().is_some_and(|wire| val(wire, a) == date)
                        {
                            // A phone edit of another field preserves the exact native instant,
                            // including legacy feeds which projected it as a null date.
                            r[b] = current_row.as_ref().unwrap()[b].clone();
                        } else if !(prior.is_none()
                            && date.is_null()
                            && s(&existing, "kind") == "instant")
                            && time_date(&existing, &zone) != *date
                        {
                            r[b] = if date.is_string() && !date.as_str().unwrap().is_empty() {
                                json!(json!({"kind":"date","date":date}).to_string())
                            } else {
                                Value::Null
                            };
                        }
                    }
                }
                if d.get("dueDate").is_some() {
                    let deadline = parse(val(&r, "deadline_value"));
                    if s(&deadline, "kind") == "instant" {
                        r["deadline"] = val(&deadline, "atUtc").clone();
                        r["deadline_time_zone"] = val(&deadline, "displayTimezone").clone();
                    } else {
                        r["deadline"] = Value::Null;
                        r["deadline_time_zone"] = Value::Null;
                    }
                }
            }
            "project" => {
                copy_fields(
                    &mut r,
                    d,
                    &[
                        ("title", "name"),
                        ("outcome", "outcome"),
                        ("dueDate", "target_date"),
                        ("archivedAt", "archived_at"),
                    ],
                );
                let status = s(d, "status");
                r["canceled"] = json!(if status == "cancelled" { 1 } else { 0 });
                if status != "active"
                    || !["draft", "active", "paused"].contains(&s(&r, "status").as_str())
                {
                    r["status"] = json!(if status == "completed" || status == "cancelled" {
                        "completed"
                    } else {
                        "active"
                    });
                }
                r["priority"] = r.get("priority").cloned().unwrap_or(json!(0));
                r["outcome"] = r.get("outcome").cloned().unwrap_or(json!(""));
            }
            "section" => copy_fields(&mut r, d, &[("title", "name"), ("projectId", "project_id")]),
            "record" | "review" | "strategy" | "decision" => {
                copy_fields(
                    &mut r,
                    d,
                    &[
                        ("title", "title"),
                        ("body", "body"),
                        ("type", "record_type"),
                        ("sourceCaptureId", "source_capture_id"),
                    ],
                );
                if !r.get("record_type").is_some_and(|v| v.is_string()) {
                    r["record_type"] = json!(if e.kind == "review" {
                        "review"
                    } else if e.kind == "decision" {
                        "decision"
                    } else {
                        "note"
                    });
                }
                r["title"] = r.get("title").cloned().unwrap_or(json!(""));
                r["body"] = r.get("body").cloned().unwrap_or(json!(""));
                if let Some(body) = structured_review_body(d)? {
                    if d.get("body").is_some_and(|v| v != &json!(body)) {
                        return Err("周回顾正文须与结构化字段一致".into());
                    }
                    r["body"] = json!(body);
                    r["record_type"] = json!("review");
                } else if let Some(review) = rows(tx, "weekly_reviews")
                    .await?
                    .into_iter()
                    .find(|w| s(w, "record_id") == e.id)
                {
                    let mut fields = json!({});
                    overlay(
                        &mut fields,
                        &review,
                        &[
                            ("periodStart", "period_start"),
                            ("periodEnd", "period_end"),
                            ("achievements", "achievements"),
                            ("blockers", "blockers"),
                            ("stopPause", "stop_pause"),
                            ("nextFocus", "next_focus"),
                        ],
                    );
                    if r["body"] != json!(structured_review_body(&fields)?.unwrap())
                        || r["record_type"] != "review"
                    {
                        return Err("请使用结构化周回顾字段编辑这条记录".into());
                    }
                }
            }
            "habit" => copy_fields(
                &mut r,
                d,
                &[
                    ("title", "name"),
                    ("notes", "notes"),
                    ("projectId", "project_id"),
                    ("startDate", "start_date"),
                    ("trigger", "trigger_context"),
                    ("normalVersion", "normal_version"),
                    ("minimumVersion", "minimum_version"),
                ],
            ),
            "recurrence" => {
                copy_fields(
                    &mut r,
                    d,
                    &[
                        ("title", "title"),
                        ("projectId", "project_id"),
                        ("startDate", "start_date"),
                        ("timeZone", "time_zone"),
                    ],
                );
                let interval = number(d, "interval").max(1);
                if interval > 3650 {
                    return Err("重复间隔超出范围".into());
                }
                r["interval_days_extended"] = json!(interval);
                r["interval_days"] = json!(interval.min(366));
                r["weekdays"] = json!(json!(d
                    .get("weekdays")
                    .and_then(Value::as_array)
                    .filter(|_| s(d, "frequency") == "weekdays")
                    .map(|a| a
                        .iter()
                        .map(|v| json!(if v.as_i64() == Some(0) {
                            7
                        } else {
                            v.as_i64().unwrap_or(1)
                        }))
                        .collect::<Vec<_>>())
                    .unwrap_or_default())
                .to_string());
                let history = d
                    .get("ruleHistory")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty());
                let enabled = history
                    .map(|a| a.iter().any(|r| val(r, "active") != &json!(false)))
                    .unwrap_or_else(|| {
                        val(d, "enabled") != &json!(false) && val(d, "active") != &json!(false)
                    });
                r["enabled"] = json!(if e.deleted || !enabled { 0 } else { 1 });
                r["time_zone"] = json!(d
                    .get("timeZone")
                    .and_then(Value::as_str)
                    .unwrap_or("Asia/Hong_Kong"));
            }
            "view" => {
                copy_fields(&mut r, d, &[("title", "name")]);
                r["query_json"] = json!(native_view_query(d)?.to_string());
                if let Some(followed) = d.get("followed").and_then(Value::as_bool) {
                    r["followed"] = json!(if followed { 1 } else { 0 });
                }
            }
            "settings" => copy_fields(&mut r, d, &[("timeZone", "time_zone")]),
            _ => {}
        }
    }
    identity::adapt(tx, e, &table, &mut r).await?;
    let cols = columns(tx, &table).await?;
    let existing =
        if table != "habit_schedules" && cols.iter().any(|(c, _, _, _, _)| c == "version") {
            // Local CAS follows the physical row's complete primary key, including
            // composite keys and identities adapted from a different wire UUID.
            let keys = cols
                .iter()
                .filter(|c| c.4 > 0)
                .map(|c| &c.0)
                .collect::<Vec<_>>();
            if keys.is_empty() {
                return Err("原生版本行缺少主键".into());
            }
            let sql = format!(
                "SELECT version FROM \"{table}\" WHERE {}",
                keys.iter()
                    .map(|k| format!("\"{k}\" IS ?"))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            );
            let mut q = sqlx::query(&sql);
            for key in keys {
                q = if key == "owner_id" {
                    bind(q, &json!(owner))
                } else {
                    bind(q, val(&r, key))
                };
            }
            let row = q.fetch_optional(&mut **tx).await.map_err(err)?;
            row.map(|row| row.try_get::<i64, _>("version").map_err(err))
                .transpose()?
                .unwrap_or(-1)
                + 1
        } else {
            0
        };
    let mut clean = Map::new();
    for (c, typ, required, default, _) in cols {
        let v = if c == "owner_id" {
            json!(owner)
        } else if c == "version" && table == "habit_schedules" {
            val(&r, "version").clone()
        } else if c == "version" {
            json!(existing)
        } else if c == "deleted_at" {
            if e.deleted {
                json!(e.updated_at)
            } else {
                Value::Null
            }
        } else if c == "start_date" && r.get(&c).is_none() {
            json!(e.created_at.get(..10).unwrap_or("1970-01-01"))
        } else if let Some(v) = r.get(&c) {
            v.clone()
        } else if let Some(default) = default {
            serde_json::from_str::<Value>(&default)
                .unwrap_or_else(|_| json!(default.trim_matches('\'')))
        } else if required == 1 {
            if typ == "INTEGER" {
                json!(0)
            } else {
                json!("")
            }
        } else {
            Value::Null
        };
        clean.insert(c, v);
    }
    Ok(Some((table, Value::Object(clean))))
}
async fn remove_row(tx: &mut Transaction<'_, Sqlite>, table: &str, row: &Value) -> StoreResult<()> {
    let keys: Vec<String> = columns(tx, table)
        .await?
        .into_iter()
        .filter(|x| x.4 > 0)
        .map(|x| x.0)
        .collect();
    let sql = format!(
        "DELETE FROM \"{table}\" WHERE {}",
        keys.iter()
            .map(|k| format!("\"{k}\" IS ?"))
            .collect::<Vec<_>>()
            .join(" AND ")
    );
    let mut q = sqlx::query(&sql);
    for k in &keys {
        q = bind(q, val(row, k));
    }
    q.execute(&mut **tx).await.map_err(err)?;
    Ok(())
}
fn bind<'q>(
    q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &Value,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(Option::<String>::None),
        Value::Bool(v) => q.bind(*v),
        Value::Number(v) => q.bind(v.as_i64().unwrap_or(0)),
        Value::String(v) => q.bind(v.clone()),
        _ => q.bind(v.to_string()),
    }
}
async fn insert_row(tx: &mut Transaction<'_, Sqlite>, table: &str, row: &Value) -> StoreResult<()> {
    let obj = row.as_object().ok_or("无效原生数据")?;
    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({})",
        obj.keys()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(","),
        vec!["?"; obj.len()].join(",")
    );
    let mut q = sqlx::query(&sql);
    for v in obj.values() {
        q = bind(q, v);
    }
    q.execute(&mut **tx).await.map_err(err)?;
    Ok(())
}
async fn apply(
    tx: &mut Transaction<'_, Sqlite>,
    entities: &[Entity],
    owner: &str,
) -> StoreResult<()> {
    for e in entities {
        check(e)?;
    }
    sqlx::query("PRAGMA defer_foreign_keys=ON")
        .execute(&mut **tx)
        .await
        .map_err(err)?;
    // Triggers implementing local edit CAS/side effects must not manufacture replica writes.
    // They are restored in this same transaction; every failure rolls both DDL and data back.
    let triggers: Vec<(String, String)> = sqlx::query_as(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(err)?;
    for (name, _) in &triggers {
        sqlx::query(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))
            .execute(&mut **tx)
            .await
            .map_err(err)?;
    }
    identity::register(tx, entities, owner).await?;
    let mut native = Vec::new();
    for e in entities {
        if let Some((table, row)) = native_row(tx, e, owner).await? {
            identity::rekey(tx, e, &table, &row).await?;
            native.push((table, row, e));
        }
    }
    for (table, row, entity) in &native {
        if !identity::retain_native(tx, entity, table, row).await? {
            remove_row(tx, table, row).await?;
        }
    }
    for (table, row, e) in &native {
        if !(e.deleted && e.kind == "desktop_row") {
            insert_row(tx, table, row).await?;
        }
    }
    let mut ordered = entities.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|e| {
        if e.kind == "habit" {
            0
        } else if e.kind == "habit_check" {
            2
        } else {
            1
        }
    });
    for e in ordered {
        apply_relations(tx, e, owner).await?;
        save_mirror(tx, e).await?;
        sqlx::query("INSERT INTO lan_entity_local(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind(&e.id).bind(serde_json::to_string(e).unwrap()).execute(&mut **tx).await.map_err(err)?;
    }
    let fk = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut **tx)
        .await
        .map_err(err)?;
    if !fk.is_empty() {
        return Err("同步批次存在缺失引用，已保留本机内容".into());
    }
    let invalid:i64=sqlx::query_scalar("SELECT count(*) FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id WHERE t.deleted_at IS NULL AND t.parent_task_id IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT NULL OR p.id=t.id OR p.owner_id IS NOT t.owner_id OR p.project_id IS NOT t.project_id OR p.section_id IS NOT t.section_id)").fetch_one(&mut **tx).await.map_err(err)?;
    if invalid > 0 {
        return Err("同步批次存在无效父子关系".into());
    }
    // The original desktop model supports nested subtasks. Preserve valid trees
    // at every depth while rejecting cycles, including cycles of three or more.
    let parents: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT id,parent_task_id FROM tasks WHERE deleted_at IS NULL AND parent_task_id IS NOT NULL",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(err)?
    .into_iter()
    .collect();
    let mut checked = HashSet::new();
    for id in parents.keys() {
        let mut path = HashSet::new();
        let mut current = id;
        while let Some(parent) = parents.get(current) {
            if checked.contains(current) {
                break;
            }
            if !path.insert(current.clone()) {
                return Err("同步批次存在父子循环关系".into());
            }
            current = parent;
        }
        checked.extend(path);
    }
    for (_, sql) in triggers {
        sqlx::query(&sql).execute(&mut **tx).await.map_err(err)?;
    }
    Ok(())
}
async fn apply_relations(
    tx: &mut Transaction<'_, Sqlite>,
    e: &Entity,
    owner: &str,
) -> StoreResult<()> {
    let d = &e.data;
    if ["record", "review"].contains(&e.kind.as_str()) && structured_review_body(d)?.is_some() {
        sqlx::query("INSERT INTO weekly_reviews(record_id,period_start,period_end,achievements,blockers,stop_pause,next_focus) VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET period_start=excluded.period_start,period_end=excluded.period_end,achievements=excluded.achievements,blockers=excluded.blockers,stop_pause=excluded.stop_pause,next_focus=excluded.next_focus").bind(&e.id).bind(s(d,"periodStart")).bind(s(d,"periodEnd")).bind(s(d,"achievements")).bind(s(d,"blockers")).bind(s(d,"stopPause")).bind(s(d,"nextFocus")).execute(&mut **tx).await.map_err(err)?;
    }
    if ["record", "review", "strategy", "decision"].contains(&e.kind.as_str())
        && (d.get("links").is_some() || d.get("projectId").is_some() || d.get("taskId").is_some())
    {
        let mut links = d
            .get("links")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // Legacy mobile fields describe one link per kind; canonical arrays preserve all links.
        if d.get("links").is_none() {
            for (kind, key) in [("project", "projectId"), ("task", "taskId")] {
                if let Some(id) = d.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    links.push(json!({"targetType":kind,"targetId":id}));
                }
            }
        }
        sqlx::query("DELETE FROM record_links WHERE record_id=?")
            .bind(&e.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
        for link in links {
            let kind = s(&link, "targetType");
            let id = s(&link, "targetId");
            let table = match kind.as_str() {
                "project" => "projects",
                "task" => "tasks",
                _ => return Err("记录关联类型无效".into()),
            };
            let exists: i64 = sqlx::query_scalar(&format!(
                "SELECT count(*) FROM {table} WHERE id=? AND owner_id=?"
            ))
            .bind(&id)
            .bind(owner)
            .fetch_one(&mut **tx)
            .await
            .map_err(err)?;
            if exists != 1 {
                return Err("记录关联缺少目标".into());
            }
            sqlx::query(
                "INSERT OR IGNORE INTO record_links(record_id,target_type,target_id) VALUES(?,?,?)",
            )
            .bind(&e.id)
            .bind(kind)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
        }
    }
    if e.kind == "recurrence" && !e.deleted {
        let mut rules = d
            .get("ruleHistory")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if rules.is_empty() {
            rules.push(json!({"effectiveDate":d.get("startDate").cloned().unwrap_or(json!(e.created_at.get(..10).unwrap_or("1970-01-01"))),"frequency":d.get("frequency").cloned().unwrap_or(json!("interval")),"interval":d.get("interval").cloned().unwrap_or(json!(1)),"weekdays":d.get("weekdays").cloned().unwrap_or(json!([])),"timeZone":d.get("timeZone").cloned().unwrap_or(json!("Asia/Hong_Kong")),"active":d.get("active").cloned().unwrap_or(json!(true))}));
        }
        rules.sort_by_key(|r| s(r, "effectiveDate"));
        sqlx::query("DELETE FROM recurrence_rules WHERE template_id=?")
            .bind(&e.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
        for r in rules {
            let date = s(&r, "effectiveDate");
            validate_date(&date)?;
            let interval = number(&r, "interval").max(1);
            if interval > 3650 {
                return Err("重复间隔超出范围".into());
            }
            let days = r
                .get("weekdays")
                .and_then(Value::as_array)
                .filter(|_| s(&r, "frequency") == "weekdays")
                .map(|a| {
                    a.iter()
                        .map(|v| {
                            json!(if v.as_i64() == Some(0) {
                                7
                            } else {
                                v.as_i64().unwrap_or(1)
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let zone = r
                .get("timeZone")
                .and_then(Value::as_str)
                .or_else(|| d.get("timeZone").and_then(Value::as_str))
                .unwrap_or("Asia/Hong_Kong");
            zone.parse::<Tz>().map_err(|_| "重复规则时区无效")?;
            sqlx::query("INSERT INTO recurrence_rules(template_id,effective_date,title,interval_days,weekdays,time_zone,anchor_date,interval_days_extended,active) VALUES(?,?,?,?,?,?,?,?,?)").bind(&e.id).bind(&date).bind(r.get("title").and_then(Value::as_str).unwrap_or_else(||d.get("title").and_then(Value::as_str).unwrap_or(""))).bind(interval.min(366)).bind(json!(days).to_string()).bind(zone).bind(r.get("anchorDate").and_then(Value::as_str).unwrap_or(&date)).bind(interval).bind(val(&r,"active")!=&json!(false)).execute(&mut **tx).await.map_err(err)?;
        }
    }
    if e.kind == "capture" && (d.get("status").is_some() || d.get("outputs").is_some()) {
        let processed = s(d, "status") == "clarified"
            || (d.get("status").is_none() && s(d, "state") == "processed");
        if processed {
            let refs = d
                .get("outputs")
                .and_then(Value::as_array)
                .ok_or("澄清输出格式无效")?;
            if refs.is_empty() || refs.len() > 100 {
                return Err("澄清输出格式无效".into());
            }
            let mut outputs = Vec::new();
            for reference in refs {
                let kind = s(reference, "kind");
                let id = s(reference, "id");
                Uuid::parse_str(&id).map_err(|_| "澄清输出标识无效")?;
                let row = if kind == "task" {
                    sqlx::query_as::<_, (String, String, String)>(
                        "SELECT title,notes,source_capture_id FROM tasks WHERE id=?",
                    )
                    .bind(&id)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(err)?
                } else if kind == "record" {
                    sqlx::query_as::<_, (String, String, String)>(
                        "SELECT title,body,source_capture_id FROM records WHERE id=?",
                    )
                    .bind(&id)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(err)?
                } else {
                    return Err("澄清输出类型无效".into());
                };
                let (title, body, source) = row.ok_or("澄清输出引用缺失")?;
                if source != e.id || number(reference, "version") < 1 {
                    return Err("澄清输出引用无效".into());
                }
                outputs.push(json!({"id":id,"kind":kind,"title":title,"body":body}));
            }
            let mut supplied = d
                .get("resolutionId")
                .and_then(Value::as_str)
                .filter(|id| Uuid::parse_str(id).is_ok())
                .map(str::to_owned);
            if let Some(id) = &supplied {
                let previous: Option<String> =
                    sqlx::query_scalar("SELECT outputs FROM resolutions WHERE id=?")
                        .bind(id)
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(err)?;
                if previous.is_some_and(|raw| {
                    serde_json::from_str::<Vec<Value>>(&raw).map_or(true, |previous| {
                        previous.iter().map(|r| s(r, "id")).collect::<Vec<_>>()
                            != refs.iter().map(|r| s(r, "id")).collect::<Vec<_>>()
                    })
                }) {
                    supplied = None;
                }
            }
            let resolution = supplied.unwrap_or_else(|| {
                stable(
                    "mobile_resolution",
                    &json!([e.id, refs.iter().map(|r| val(r, "id")).collect::<Vec<_>>()]),
                )
            });
            sqlx::query("INSERT INTO resolutions(id,capture_id,outputs,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET outputs=excluded.outputs,undone_at=NULL,kept=0").bind(&resolution).bind(&e.id).bind(json!(outputs).to_string()).bind(&e.updated_at).execute(&mut **tx).await.map_err(err)?;
            sqlx::query("UPDATE captures SET state='processed',resolution_id=?,retained_outputs=0 WHERE id=?").bind(&resolution).bind(&e.id).execute(&mut **tx).await.map_err(err)?;
        } else {
            // Canonical mobile status overrides the extension's prior processed state.
            let mut retained = false;
            if let Some(refs) = val(d, "lastOutputs").as_array() {
                for reference in refs {
                    let sql = if s(reference, "kind") == "task" {
                        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL)"
                    } else {
                        "SELECT EXISTS(SELECT 1 FROM records WHERE id=? AND deleted_at IS NULL)"
                    };
                    let alive: bool = sqlx::query_scalar(sql)
                        .bind(s(reference, "id"))
                        .fetch_one(&mut **tx)
                        .await
                        .map_err(err)?;
                    retained |= alive;
                }
            }
            sqlx::query("UPDATE resolutions SET undone_at=COALESCE(undone_at,?),kept=? WHERE id=(SELECT resolution_id FROM captures WHERE id=?)").bind(&e.updated_at).bind(retained).bind(&e.id).execute(&mut **tx).await.map_err(err)?;
            sqlx::query("UPDATE captures SET state='pending',retained_outputs=? WHERE id=?")
                .bind(retained)
                .bind(&e.id)
                .execute(&mut **tx)
                .await
                .map_err(err)?;
        }
    }
    if e.kind == "task" {
        if let Some(tags) = d.get("tags").and_then(Value::as_array) {
            sqlx::query("DELETE FROM task_labels WHERE task_id=?")
                .bind(&e.id)
                .execute(&mut **tx)
                .await
                .map_err(err)?;
            for tag in tags {
                let name = tag.as_str().ok_or("标签格式无效")?;
                let existing: Option<String> =
                    sqlx::query_scalar("SELECT id FROM labels WHERE owner_id=? AND name=?")
                        .bind(owner)
                        .bind(name)
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(err)?;
                let id = existing.unwrap_or_else(|| stable("label", &json!(name)));
                sqlx::query(
                    "INSERT OR IGNORE INTO labels(id,owner_id,name,version) VALUES(?,?,?,0)",
                )
                .bind(&id)
                .bind(owner)
                .bind(name)
                .execute(&mut **tx)
                .await
                .map_err(err)?;
                sqlx::query("INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)")
                    .bind(&e.id)
                    .bind(id)
                    .execute(&mut **tx)
                    .await
                    .map_err(err)?;
            }
        }
        if d.get("executionDate")
            .is_some_and(|v| v.is_null() || v.as_str() == Some(""))
        {
            sqlx::query("UPDATE daily_plan_items SET removed=1 WHERE task_id=? AND NOT EXISTS(SELECT 1 FROM execution_records x WHERE x.plan_id=daily_plan_items.id AND x.revoked_at IS NULL)").bind(&e.id).execute(&mut **tx).await.map_err(err)?;
        }
        if let Some(date) = d
            .get("executionDate")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "安排日期无效")?;
            let exists:i64=sqlx::query_scalar("SELECT count(*) FROM daily_plan_items WHERE task_id=? AND execution_date=? AND removed=0").bind(&e.id).bind(date).fetch_one(&mut **tx).await.map_err(err)?;
            if exists == 0 {
                sqlx::query("UPDATE daily_plan_items SET removed=1 WHERE task_id=? AND removed=0 AND NOT EXISTS(SELECT 1 FROM execution_records x WHERE x.plan_id=daily_plan_items.id)").bind(&e.id).execute(&mut **tx).await.map_err(err)?;
                sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,task_id,execution_date) DO UPDATE SET removed=0").bind(stable("mobile_plan",&json!([e.id,date]))).bind(owner).bind(&e.id).bind(date).bind("Asia/Hong_Kong").bind(&e.created_at).execute(&mut **tx).await.map_err(err)?;
            }
        }
    }
    if e.kind == "task" {
        if s(d, "status") == "completed" && !e.deleted {
            let explicit_at = d.get("completedAt").or_else(|| d.get("desktop").and_then(|v| v.get("completed_at")));
            let completed_at = match explicit_at {
                Some(Value::Null) => None,
                Some(Value::String(at)) => {
                    DateTime::parse_from_rfc3339(at).map_err(|_| "完成时刻无效")?;
                    Some(at.as_str())
                }
                Some(_) => return Err("完成时刻无效".into()),
                None => Some(e.updated_at.as_str()), // Original feeds without a completion field.
            };
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM execution_records WHERE task_id=? AND revoked_at IS NULL LIMIT 1",
            )
            .bind(&e.id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(err)?;
            let completion = if let Some(id) = existing {
                Some(id)
            } else {
                let plan:Option<(String,String,String)>=sqlx::query_as("SELECT id,execution_date,time_zone FROM daily_plan_items WHERE task_id=? AND removed=0 ORDER BY execution_date DESC LIMIT 1").bind(&e.id).fetch_optional(&mut **tx).await.map_err(err)?;
                if let (Some((plan, date, zone)), Some(at)) = (plan, completed_at) {
                    let id = stable("completion", &json!([e.id, e.version]));
                    sqlx::query("INSERT OR IGNORE INTO execution_records(id,owner_id,task_id,plan_id,execution_date,time_zone,occurred_at) VALUES(?,?,?,?,?,?,?)").bind(&id).bind(owner).bind(&e.id).bind(plan).bind(date).bind(zone).bind(at).execute(&mut **tx).await.map_err(err)?;
                    Some(id)
                } else {
                    None
                }
            };
            sqlx::query("UPDATE tasks SET active_completion_id=?,completed_at=COALESCE(completed_at,?) WHERE id=?").bind(completion).bind(completed_at).bind(&e.id).execute(&mut **tx).await.map_err(err)?;
        } else if s(d, "status") != "completed" {
            sqlx::query(
                "UPDATE execution_records SET revoked_at=? WHERE task_id=? AND revoked_at IS NULL",
            )
            .bind(&e.updated_at)
            .bind(&e.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
            sqlx::query("UPDATE tasks SET active_completion_id=NULL,completed_at=NULL WHERE id=?")
                .bind(&e.id)
                .execute(&mut **tx)
                .await
                .map_err(err)?;
        }
    }
    if e.kind == "project"
        && [
            "nextActionId",
            "blocker",
            "reviewDate",
            "completionCriteria",
            "recoveryNote",
        ]
        .iter()
        .any(|k| d.get(k).is_some())
    {
        sqlx::query("INSERT OR IGNORE INTO project_context(project_id,updated_at) VALUES(?,?)")
            .bind(&e.id)
            .bind(&e.updated_at)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
        for (a, b) in [
            ("nextActionId", "next_action_task_id"),
            ("blocker", "blocker_text"),
            ("reviewDate", "review_date"),
            ("completionCriteria", "definition_of_done"),
            ("recoveryNote", "restart_hint"),
        ] {
            if let Some(v) = d.get(a) {
                let sql = format!(
                    "UPDATE project_context SET {b}=?,version=version+1 WHERE project_id=?"
                );
                bind(sqlx::query(&sql), v)
                    .bind(&e.id)
                    .execute(&mut **tx)
                    .await
                    .map_err(err)?;
            }
        }
    }
    if e.kind == "habit" {
        let current = rows(tx, "habit_schedules")
            .await?
            .into_iter()
            .filter(|r| s(r, "habit_id") == e.id)
            .collect::<Vec<_>>();
        let mut rules = d
            .get("ruleHistory")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if rules.is_empty() {
            rules.push(json!({"effectiveDate":d.get("startDate").cloned().unwrap_or(json!(e.created_at.get(..10).unwrap_or("1970-01-01"))),"frequency":d.get("frequency").cloned().unwrap_or(json!("daily")),"weekdays":d.get("weekdays").cloned().unwrap_or(json!([])),"target":d.get("target").cloned().unwrap_or(json!(1)),"paused":d.get("paused").cloned().unwrap_or(json!(false)),"interval":d.get("interval").cloned().unwrap_or(json!(1))}));
        }
        rules.sort_by_key(|r| s(r, "effectiveDate"));
        let mut next = current
            .iter()
            .map(|r| number(r, "version"))
            .max()
            .unwrap_or(-1)
            + 1;
        for (i, r) in rules.iter().enumerate() {
            let date = s(r, "effectiveDate");
            let version = current
                .iter()
                .find(|x| s(x, "effective_from") == date)
                .map(|x| number(x, "version"))
                .unwrap_or_else(|| {
                    let n = next;
                    next += 1;
                    n
                });
            let frequency = s(r, "frequency");
            if !["daily", "weekly", "weekdays", "interval"].contains(&frequency.as_str()) {
                return Err("此习惯频率尚不能映射到桌面日历，原批次已保留".into());
            }
            let days = val(r, "weekdays")
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| {
                            json!(if v.as_i64() == Some(0) {
                                7
                            } else {
                                v.as_i64().unwrap_or(1)
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            sqlx::query("INSERT INTO habit_schedules(habit_id,version,effective_from,effective_until,frequency,weekdays,weekly_target,paused,interval_days,time_zone) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(habit_id,version) DO UPDATE SET effective_until=excluded.effective_until,frequency=excluded.frequency,weekdays=excluded.weekdays,weekly_target=excluded.weekly_target,paused=excluded.paused,interval_days=excluded.interval_days,time_zone=excluded.time_zone").bind(&e.id).bind(version).bind(date).bind(rules.get(i+1).map(|r|s(r,"effectiveDate"))).bind(if frequency=="interval"{"daily"}else{frequency.as_str()}).bind(json!(days).to_string()).bind(number(r,"target").max(1)).bind(val(r,"paused")==&json!(true)).bind(if frequency=="interval"{number(r,"interval").max(1)}else{1}).bind(r.get("timeZone").and_then(Value::as_str).or_else(||d.get("timeZone").and_then(Value::as_str)).unwrap_or("Asia/Hong_Kong")).execute(&mut **tx).await.map_err(err)?;
        }
    }
    if e.kind == "habit_check" {
        let habit = s(d, "habitId");
        let date = s(d, "date");
        let schedule:Option<i64>=sqlx::query_scalar("SELECT version FROM habit_schedules WHERE habit_id=? AND effective_from<=? AND (effective_until IS NULL OR effective_until>?) ORDER BY effective_from DESC LIMIT 1").bind(&habit).bind(&date).bind(&date).fetch_optional(&mut **tx).await.map_err(err)?;
        let version = schedule.ok_or("打卡缺少生效习惯规则")?;
        sqlx::query("INSERT INTO habit_entries(habit_id,local_date,status,note,timezone,occurred_at,schedule_version,version) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(habit_id,local_date) DO UPDATE SET status=excluded.status,note=excluded.note,timezone=excluded.timezone,occurred_at=excluded.occurred_at,schedule_version=excluded.schedule_version,version=habit_entries.version+1").bind(habit).bind(date).bind(if e.deleted{None}else{Some(s(d,"status"))}).bind(s(d,"note")).bind(d.get("timeZone").and_then(Value::as_str).unwrap_or("Asia/Hong_Kong")).bind(d.get("recordedAt").and_then(Value::as_str).unwrap_or(&e.updated_at)).bind(version).execute(&mut **tx).await.map_err(err)?;
    }
    if e.kind == "plan" && e.deleted {
        sqlx::query("DELETE FROM day_notes WHERE owner_id=? AND date=?")
            .bind(owner)
            .bind(s(d, "date"))
            .execute(&mut **tx)
            .await
            .map_err(err)?;
    }
    if e.kind == "plan" && !e.deleted {
        let date = s(d, "date");
        NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "安排日期无效")?;
        sqlx::query("INSERT INTO day_notes(owner_id,date,outcome,closing,focus_ids,version) VALUES(?,?,?,?,?,0) ON CONFLICT(owner_id,date) DO UPDATE SET outcome=excluded.outcome,closing=excluded.closing,focus_ids=excluded.focus_ids,version=day_notes.version+1").bind(owner).bind(&date).bind(s(d,"outcome")).bind(s(d,"note")).bind(d.get("taskIds").cloned().unwrap_or(json!([])).to_string()).execute(&mut **tx).await.map_err(err)?;
        if let Some(ids) = d.get("taskIds").and_then(Value::as_array) {
            for id in ids {
                sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,task_id,execution_date) DO UPDATE SET removed=0").bind(stable("mobile_plan",&json!([id,date]))).bind(owner).bind(id.as_str().ok_or("安排任务标识无效")?).bind(&date).bind(d.get("timeZone").and_then(Value::as_str).unwrap_or("Asia/Hong_Kong")).bind(&e.created_at).execute(&mut **tx).await.map_err(err)?;
            }
        }
    }
    Ok(())
}
// Merge only changes made since the local snapshot; wire metadata normalization is not an edit.
fn merge_data(base: &Value, local: &Value, remote: &Value, strict: bool) -> StoreResult<Value> {
    if local == base {
        return Ok(remote.clone());
    }
    if remote == base || local == remote {
        return Ok(local.clone());
    }
    let structured = |data: &Value| {
        [
            "periodStart",
            "periodEnd",
            "achievements",
            "blockers",
            "stopPause",
            "nextFocus",
        ]
        .iter()
        .all(|k| data.get(*k).is_some_and(Value::is_string))
    };
    if base.is_object()
        && structured(local)
        && structured(remote)
        && (local.get("body").is_some() || remote.get("body").is_some())
    {
        let strip = |data: &Value| {
            let mut value = data.clone();
            value.as_object_mut().unwrap().remove("body");
            if let Some(desktop) = value.get_mut("desktop").and_then(Value::as_object_mut) {
                desktop.remove("body");
            }
            value
        };
        let mut value = merge_data(&strip(base), &strip(local), &strip(remote), strict)?;
        if let Some(body) = structured_review_body(&value)? {
            value["body"] = json!(body);
            if let Some(desktop) = value.get_mut("desktop").and_then(Value::as_object_mut) {
                desktop.insert("body".into(), json!(body));
            }
        }
        return Ok(value);
    }
    if base.is_object() && local.is_object() && remote.is_object() {
        let keys: BTreeSet<String> = base
            .as_object()
            .unwrap()
            .keys()
            .chain(local.as_object().unwrap().keys())
            .chain(remote.as_object().unwrap().keys())
            .cloned()
            .collect();
        let mut out = Map::new();
        for k in keys {
            let merged = merge_data(val(base, &k), val(local, &k), val(remote, &k), strict)?;
            if !merged.is_null() || local.get(&k).is_some() || remote.get(&k).is_some() {
                out.insert(k, merged);
            }
        }
        return Ok(Value::Object(out));
    }
    if strict {
        Err("同一属性在两端被修改".into())
    } else {
        Ok(local.clone())
    }
}
fn remote_projection(old: &Value, normalized: &Value, new: &Value) -> Value {
    if old == new {
        return normalized.clone();
    }
    if old.is_object() && normalized.is_object() && new.is_object() {
        let keys: BTreeSet<String> = normalized
            .as_object()
            .unwrap()
            .keys()
            .chain(new.as_object().unwrap().keys())
            .cloned()
            .collect();
        let mut out = Map::new();
        for k in keys {
            out.insert(
                k.clone(),
                remote_projection(val(old, &k), val(normalized, &k), val(new, &k)),
            );
        }
        Value::Object(out)
    } else {
        new.clone()
    }
}
async fn baselines(tx: &mut Transaction<'_, Sqlite>) -> StoreResult<BTreeMap<String, Value>> {
    let raw: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id,local_data FROM lan_entities")
            .fetch_all(&mut **tx)
            .await
            .map_err(err)?;
    raw.into_iter()
        .filter_map(|(id, s)| s.map(|s| (id, s)))
        .map(|(id, s)| Ok((id, serde_json::from_str(&s).map_err(|e| e.to_string())?)))
        .collect()
}
async fn stamp(tx: &mut Transaction<'_, Sqlite>, ids: &BTreeSet<String>) -> StoreResult<()> {
    let current = snapshot(tx).await?;
    for id in ids {
        if let Some(e) = current.get(id) {
            sqlx::query("UPDATE lan_entities SET local_data=? WHERE id=?")
                .bind(projection(e).to_string())
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(err)?;
        }
    }
    Ok(())
}
fn changed(e: &Entity, baseline: Option<&Value>) -> bool {
    baseline != Some(&projection(e))
}
fn as_change(e: &Entity, remote: Option<&Entity>) -> Change {
    Change {
        id: e.id.clone(),
        kind: e.kind.clone(),
        expected_version: remote.filter(|e| e.version > 0).map(|e| e.version),
        data: e.data.clone(),
        deleted: e.deleted,
        created_at: remote
            .map(|r| r.created_at.clone())
            .unwrap_or_else(|| e.created_at.clone()),
        base_data: remote.map(|e| e.data.clone()),
    }
}
impl Store {
    pub async fn entities_snapshot(&self) -> StoreResult<Vec<Entity>> {
        let mut tx = self.pool.begin().await.map_err(err)?;
        Ok(snapshot(&mut tx).await?.into_values().collect())
    }
    pub async fn entities_cursor(&self) -> StoreResult<i64> {
        sqlx::query_scalar("SELECT cursor FROM lan_entity_state WHERE singleton=1")
            .fetch_one(&self.pool)
            .await
            .map_err(err)
    }
    pub async fn entities_status(&self) -> StoreResult<Value> {
        let pending: i64 =
            sqlx::query_scalar("SELECT count(*) FROM lan_entity_pending WHERE blocked=0")
                .fetch_one(&self.pool)
                .await
                .map_err(err)?;
        let conflicts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM lan_entity_pending WHERE blocked=1")
                .fetch_one(&self.pool)
                .await
                .map_err(err)?;
        let last: Option<String> =
            sqlx::query_scalar("SELECT last_success FROM lan_entity_state WHERE singleton=1")
                .fetch_one(&self.pool)
                .await
                .map_err(err)?;
        Ok(
            json!({"entityPending":pending,"entityConflicts":conflicts,"entityCursor":self.entities_cursor().await?,"lastSuccess":last,"pending":pending,"conflicts":conflicts}),
        )
    }
    pub async fn entities_prepare(&self, device: &str) -> StoreResult<Vec<Command>> {
        let mut tx = self.pool.begin().await.map_err(err)?;
        // Existing capture acknowledgements provide the migration CAS baseline. Keep frozen v1
        // commands on disk until their raw text is acknowledged by v2; do not send them twice.
        let seeds:Vec<(String,i64,String,bool)>=sqlx::query_as("SELECT s.id,s.version,s.raw_text,s.deleted FROM lan_shadow s WHERE NOT EXISTS(SELECT 1 FROM lan_entities e WHERE e.id=s.id)").fetch_all(&mut *tx).await.map_err(err)?;
        for (id, version, raw, deleted) in seeds {
            let created: Option<String> =
                sqlx::query_scalar("SELECT created_at FROM captures WHERE id=?")
                    .bind(&id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(err)?;
            save_mirror(
                &mut tx,
                &Entity {
                    id,
                    kind: "capture".into(),
                    version,
                    data: json!({"rawText":raw}),
                    deleted,
                    created_at: created.unwrap_or(EPOCH.into()),
                    updated_at: EPOCH.into(),
                },
            )
            .await?;
        }
        let old = mirrors(&mut tx).await?;
        let baseline = baselines(&mut tx).await?;
        let current = snapshot(&mut tx).await?;
        let queued: Vec<String> = sqlx::query_scalar("SELECT payload FROM lan_entity_pending")
            .fetch_all(&mut *tx)
            .await
            .map_err(err)?;
        let mut busy = BTreeSet::new();
        for q in queued {
            let c: Command = serde_json::from_str(&q).map_err(|e| e.to_string())?;
            busy.extend(c.changes.into_iter().map(|c| c.id));
        }
        let changes: Vec<Change> = current
            .values()
            .filter(|e| !busy.contains(&e.id) && changed(e, baseline.get(&e.id)))
            .map(|e| as_change(e, old.get(&e.id)))
            .collect();
        if !changes.is_empty() {
            if changes.len() > 10000 {
                return Err("待同步实体超过单个原子批次上限，未拆分关联数据".into());
            }
            let c = Command {
                operation_id: Uuid::new_v4().to_string(),
                device_id: device.into(),
                changes,
            };
            sqlx::query("INSERT INTO lan_entity_pending(operation_id,payload) VALUES(?,?)")
                .bind(&c.operation_id)
                .bind(serde_json::to_string(&c).map_err(|e| e.to_string())?)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
        }
        let pending: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM lan_entity_pending WHERE blocked=0 ORDER BY rowid LIMIT 10",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(err)?;
        let result = pending
            .into_iter()
            .map(|p| serde_json::from_str(&p).map_err(|e| e.to_string()))
            .collect::<StoreResult<Vec<_>>>()?;
        tx.commit().await.map_err(err)?;
        Ok(result)
    }
    pub async fn entities_ack(&self, c: &Command, entities: &[Entity]) -> StoreResult<()> {
        if entities.len() != c.changes.len()
            || entities
                .iter()
                .any(|e| !c.changes.iter().any(|x| x.id == e.id && x.kind == e.kind))
        {
            return Err("同步回执与操作不匹配".into());
        }
        let mut tx = self.pool.begin().await.map_err(err)?;
        let current = snapshot(&mut tx).await?;
        let mut merged = Vec::new();
        for e in entities {
            check(e)?;
            let sent = c.changes.iter().find(|x| x.id == e.id).unwrap();
            let mut next = e.clone();
            if let Some(local) = current.get(&e.id) {
                next.data = merge_data(&sent.data, &local.data, &e.data, false)?;
                if local.deleted != sent.deleted {
                    next.deleted = local.deleted;
                }
            }
            merged.push(next);
        }
        apply(&mut tx, entities, &self.owner_id).await?;
        stamp(&mut tx, &entities.iter().map(|e| e.id.clone()).collect()).await?;
        apply(&mut tx, &merged, &self.owner_id).await?;
        for e in entities {
            save_mirror(&mut tx, e).await?;
        }
        for e in entities.iter().filter(|e| e.kind == "capture") {
            sqlx::query("DELETE FROM lan_pending WHERE id=? AND json_extract(payload,'$.rawText')=? AND json_extract(payload,'$.deleted')=?").bind(&e.id).bind(s(&e.data,"rawText")).bind(e.deleted).execute(&mut *tx).await.map_err(err)?;
        }
        sqlx::query("DELETE FROM lan_entity_pending WHERE operation_id=?")
            .bind(&c.operation_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        sqlx::query(
            "INSERT OR IGNORE INTO lan_entity_history(id,occurred_at,payload) VALUES(?,?,?)",
        )
        .bind(&c.operation_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(json!({"kind":"upload","command":c,"entities":entities}).to_string())
        .execute(&mut *tx)
        .await
        .map_err(err)?;
        tx.commit().await.map_err(err)
    }
    pub async fn entities_block(
        &self,
        c: &Command,
        remote: Option<Vec<Entity>>,
        message: &str,
    ) -> StoreResult<()> {
        sqlx::query(
            "UPDATE lan_entity_pending SET blocked=1,remote=?,message=? WHERE operation_id=?",
        )
        .bind(remote.map(|e| serde_json::to_string(&e).unwrap()))
        .bind(message)
        .bind(&c.operation_id)
        .execute(&self.pool)
        .await
        .map_err(err)?;
        Ok(())
    }
    pub async fn entities_pull(&self, feed: &Feed, device: &str) -> StoreResult<()> {
        let mut tx = self.pool.begin().await.map_err(err)?;
        let mut cursor: i64 =
            sqlx::query_scalar("SELECT cursor FROM lan_entity_state WHERE singleton=1")
                .fetch_one(&mut *tx)
                .await
                .map_err(err)?;
        for batch in &feed.changes {
            if batch.cursor != cursor + 1 || batch.entities.is_empty() {
                return Err("同步游标不连续".into());
            }
            for e in &batch.entities {
                check(e)?;
            }
            let old = mirrors(&mut tx).await?;
            let baseline = baselines(&mut tx).await?;
            let current = snapshot(&mut tx).await?;
            let remote: Vec<Entity> = batch
                .entities
                .iter()
                .filter(|e| old.get(&e.id).map_or(true, |o| e.version > o.version))
                .cloned()
                .collect();
            let identity_collisions = identity::collisions(&mut tx, &remote).await?;
            let mut merged = Vec::new();
            let mut projected = Vec::new();
            let mut dirty = !identity_collisions.is_empty();
            for e in &remote {
                let base = baseline
                    .get(&e.id)
                    .cloned()
                    .unwrap_or_else(|| old.get(&e.id).map(projection).unwrap_or(Value::Null));
                let old_wire = old.get(&e.id).map(projection).unwrap_or(Value::Null);
                let projected_value = remote_projection(&old_wire, &base, &projection(e));
                let mut rp = e.clone();
                rp.data = val(&projected_value, "data").clone();
                rp.deleted = val(&projected_value, "deleted")
                    .as_bool()
                    .unwrap_or(e.deleted);
                projected.push(rp.clone());
                if let Some(local) = current.get(&e.id) {
                    match merge_data(&base, &projection(local), &projected_value, true) {
                        Ok(v) => {
                            rp.data = val(&v, "data").clone();
                            rp.deleted = val(&v, "deleted").as_bool().unwrap_or(local.deleted);
                            merged.push(rp);
                        }
                        Err(_) => {
                            dirty = true;
                        }
                    }
                } else {
                    merged.push(rp);
                }
            }
            if dirty {
                let pending: Vec<(String, String)> =
                    sqlx::query_as("SELECT operation_id,payload FROM lan_entity_pending")
                        .fetch_all(&mut *tx)
                        .await
                        .map_err(err)?;
                let mut matched = false;
                for (id, payload) in pending {
                    let c: Command = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
                    if c.changes
                        .iter()
                        .any(|c| remote.iter().any(|e| e.id == c.id))
                    {
                        sqlx::query("UPDATE lan_entity_pending SET blocked=1,remote=?,message='双端内容同时修改' WHERE operation_id=?").bind(serde_json::to_string(&batch.entities).unwrap()).bind(id).execute(&mut *tx).await.map_err(err)?;
                        matched = true;
                    }
                }
                if !matched {
                    let c = Command {
                        operation_id: Uuid::new_v4().to_string(),
                        device_id: device.into(),
                        changes: remote
                            .iter()
                            .filter_map(|e| current.get(&e.id))
                            .chain(identity_collisions.iter())
                            .map(|e| as_change(e, old.get(&e.id)))
                            .collect(),
                    };
                    sqlx::query("INSERT INTO lan_entity_pending(operation_id,payload,blocked,remote,message) VALUES(?,?,1,?,'双端内容同时修改')").bind(&c.operation_id).bind(serde_json::to_string(&c).unwrap()).bind(serde_json::to_string(&batch.entities).unwrap()).execute(&mut *tx).await.map_err(err)?;
                }
            } else {
                apply(&mut tx, &projected, &self.owner_id).await?;
                stamp(&mut tx, &projected.iter().map(|e| e.id.clone()).collect()).await?;
                apply(&mut tx, &merged, &self.owner_id).await?;
                for e in &remote {
                    save_mirror(&mut tx, e).await?;
                }
            }
            sqlx::query("INSERT OR IGNORE INTO lan_entity_history(id,occurred_at,payload) VALUES(?,?,?)").bind(&batch.operation_id).bind(chrono::Utc::now().to_rfc3339()).bind(json!({"kind":"download","deviceId":batch.device_id,"entities":batch.entities,"conflict":dirty}).to_string()).execute(&mut *tx).await.map_err(err)?;
            cursor = batch.cursor;
        }
        if cursor != feed.cursor {
            return Err("同步游标无效".into());
        }
        sqlx::query("UPDATE lan_entity_state SET cursor=?,last_success=? WHERE singleton=1")
            .bind(cursor)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        tx.commit().await.map_err(err)
    }
    pub async fn entities_conflicts(&self) -> StoreResult<Value> {
        let mut tx = self.pool.begin().await.map_err(err)?;
        conflicts(&mut tx).await
    }
    pub async fn entities_resolve(
        &self,
        operation_id: &str,
        resolution_id: &str,
        decision: &str,
        token: &str,
        merged: Option<Vec<Entity>>,
    ) -> StoreResult<()> {
        Uuid::parse_str(resolution_id).map_err(|_| "无效操作标识")?;
        let receipt =
            json!({"operationId":operation_id,"decision":decision,"token":token,"merged":merged})
                .to_string();
        let mut tx = self.pool.begin().await.map_err(err)?;
        let prior: Option<String> =
            sqlx::query_scalar("SELECT payload FROM lan_entity_resolutions WHERE id=?")
                .bind(resolution_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(err)?;
        if let Some(prior) = prior {
            return if prior == receipt {
                Ok(())
            } else {
                Err("重试操作内容已改变".into())
            };
        }
        let all = conflicts(&mut tx).await?;
        let conflict = all
            .as_array()
            .unwrap()
            .iter()
            .find(|x| s(x, "operationId") == operation_id)
            .ok_or("冲突已处理，请刷新")?;
        if s(conflict, "token") != token {
            return Err("冲突内容已更新，请刷新后再选择".into());
        }
        let remote: Vec<Entity> =
            serde_json::from_value(conflict["remote"].clone()).map_err(|e| e.to_string())?;
        if remote.is_empty() {
            return Err("等待完整服务端冲突批次到达".into());
        }
        let local: Vec<Entity> =
            serde_json::from_value(conflict["local"].clone()).map_err(|e| e.to_string())?;
        let mut selected = match decision {
            "remote" => remote.clone(),
            "local" => local.clone(),
            "merge" => {
                let v = merged.ok_or("缺少合并内容")?;
                if v.iter().map(|e| &e.id).collect::<BTreeSet<_>>()
                    != local.iter().map(|e| &e.id).collect::<BTreeSet<_>>()
                {
                    return Err("合并不可增加或丢失批次实体".into());
                }
                v
            }
            _ => return Err("未知冲突处理方式".into()),
        };
        identity::adopt(&mut tx, &remote, &mut selected).await?;
        apply(&mut tx, &remote, &self.owner_id).await?;
        stamp(&mut tx, &remote.iter().map(|e| e.id.clone()).collect()).await?;
        if decision != "remote" {
            let shadow = mirrors(&mut tx).await?;
            apply(&mut tx, &selected, &self.owner_id).await?;
            for e in &remote {
                save_mirror(&mut tx, e).await?;
            }
            let current = snapshot(&mut tx).await?;
            let changes = selected
                .iter()
                .filter_map(|e| current.get(&e.id))
                .map(|e| as_change(e, shadow.get(&e.id)))
                .collect();
            let c = Command {
                operation_id: resolution_id.into(),
                device_id: self.device_id.clone(),
                changes,
            };
            // Device token identity is filled by prepare/runtime before first send; keep command stable.
            let device: Option<String> =
                sqlx::query_scalar("SELECT device_id FROM lan_binding WHERE owner_id=?")
                    .bind(&self.owner_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(err)?;
            let c = Command {
                device_id: device.unwrap_or(c.device_id.clone()),
                ..c
            };
            sqlx::query("INSERT INTO lan_entity_pending(operation_id,payload) VALUES(?,?)")
                .bind(resolution_id)
                .bind(serde_json::to_string(&c).unwrap())
                .execute(&mut *tx)
                .await
                .map_err(err)?;
        }
        sqlx::query("DELETE FROM lan_entity_pending WHERE operation_id=?")
            .bind(operation_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        sqlx::query("INSERT INTO lan_entity_resolutions(id,payload) VALUES(?,?)")
            .bind(resolution_id)
            .bind(&receipt)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        sqlx::query("INSERT INTO lan_entity_history(id,occurred_at,payload) VALUES(?,?,?)").bind(resolution_id).bind(chrono::Utc::now().to_rfc3339()).bind(json!({"kind":"resolve","decision":decision,"local":local,"remote":remote,"selected":selected}).to_string()).execute(&mut *tx).await.map_err(err)?;
        tx.commit().await.map_err(err)
    }
    pub async fn entities_edit(
        &self,
        operation_id: &str,
        entity: Entity,
        expected: Option<Entity>,
    ) -> StoreResult<()> {
        Uuid::parse_str(operation_id).map_err(|_| "无效操作标识")?;
        check(&entity)?;
        let payload = json!({"entity":entity,"expected":expected}).to_string();
        let mut tx = self.pool.begin().await.map_err(err)?;
        let prior: Option<String> =
            sqlx::query_scalar("SELECT payload FROM lan_entity_history WHERE id=?")
                .bind(operation_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(err)?;
        if let Some(p) = prior {
            return if p == payload {
                Ok(())
            } else {
                Err("相同操作标识不能更改内容".into())
            };
        }
        let current = snapshot(&mut tx).await?;
        if current.get(&entity.id).map(projection) != expected.as_ref().map(projection) {
            return Err("内容已变化，请刷新后修改".into());
        }
        if current
            .get(&entity.id)
            .is_some_and(|old| old.created_at != entity.created_at || old.kind != entity.kind)
        {
            return Err("实体创建时间及类型不可更改".into());
        }
        let old = mirrors(&mut tx).await?;
        apply(&mut tx, &[entity.clone()], &self.owner_id).await?;
        if let Some(remote) = old.get(&entity.id) {
            save_mirror(&mut tx, remote).await?;
        } else {
            sqlx::query("UPDATE lan_entities SET version=0 WHERE id=?")
                .bind(&entity.id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
        }
        sqlx::query("INSERT INTO lan_entity_history(id,occurred_at,payload) VALUES(?,?,?)")
            .bind(operation_id)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(payload)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        tx.commit().await.map_err(err)
    }
}
async fn conflicts(tx: &mut Transaction<'_, Sqlite>) -> StoreResult<Value> {
    let current = snapshot(tx).await?;
    let rows:Vec<(String,String,Option<String>,String)>=sqlx::query_as("SELECT operation_id,payload,remote,message FROM lan_entity_pending WHERE blocked=1 ORDER BY rowid").fetch_all(&mut **tx).await.map_err(err)?;
    let mut out = Vec::new();
    for (id, p, r, message) in rows {
        let c: Command = serde_json::from_str(&p).map_err(|e| e.to_string())?;
        let remote: Vec<Entity> = r
            .map(|r| serde_json::from_str(&r))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let ids: BTreeSet<String> = c
            .changes
            .iter()
            .map(|e| e.id.clone())
            .chain(remote.iter().map(|e| e.id.clone()))
            .collect();
        let local: Vec<Entity> = ids
            .iter()
            .filter_map(|id| current.get(id).cloned())
            .collect();
        let token = json!({"local":local,"remote":remote}).to_string();
        out.push(
            json!({"operationId":id,"local":local,"remote":remote,"token":token,"message":message}),
        );
    }
    Ok(json!(out))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn entity(kind: &str, data: Value) -> Entity {
        Entity {
            id: Uuid::new_v4().to_string(),
            kind: kind.into(),
            version: 1,
            data,
            deleted: false,
            created_at: "2026-10-11T00:00:00Z".into(),
            updated_at: "2026-10-11T00:00:00Z".into(),
        }
    }
    fn feed(entities: Vec<Entity>, cursor: i64) -> Feed {
        Feed {
            changes: vec![Batch {
                entities,
                cursor,
                operation_id: Uuid::new_v4().to_string(),
                device_id: Uuid::new_v4().to_string(),
            }],
            cursor,
            has_more: false,
        }
    }
    async fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("test.db")).await.unwrap();
        (dir, s)
    }
    #[tokio::test]
    async fn mobile_project_task_plan_roundtrip_and_frozen_retries() {
        let (_d, s) = store().await;
        let p = entity(
            "project",
            json!({"title":"project","status":"active","outcome":"done"}),
        );
        let sec = entity("section", json!({"title":"section","projectId":p.id}));
        let t = entity(
            "task",
            json!({"title":"task","status":"todo","projectId":p.id,"sectionId":sec.id,"priority":3,"tags":["tag"],"executionDate":"2026-10-11","dueDate":"2026-10-12","notes":"note"}),
        );
        let plan = entity(
            "plan",
            json!({"date":"2026-10-11","taskIds":[t.id],"outcome":"result","note":"closing"}),
        );
        s.entities_pull(
            &feed(vec![t.clone(), p.clone(), sec.clone(), plan.clone()], 1),
            "device",
        )
        .await
        .unwrap();
        let day = s.list_day("2026-10-11").await.unwrap();
        assert_eq!(day.len(), 1);
        assert_eq!(day[0].title, "task");
        let snapshot = s.entities_snapshot().await.unwrap();
        assert_eq!(
            snapshot.iter().find(|e| e.id == t.id).unwrap().data["priority"],
            json!(3)
        );
        assert_eq!(
            snapshot.iter().find(|e| e.id == plan.id).unwrap().data["outcome"],
            "result"
        );
        let first = s.entities_prepare("device").await.unwrap();
        let retry = s.entities_prepare("device").await.unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&retry).unwrap()
        );
        // Only native supplemental records created by projection may need upload, not the task again.
        assert!(!first.iter().flat_map(|c| &c.changes).any(|e| e.id == t.id));
    }
    #[tokio::test]
    async fn atomic_invalid_reference_rolls_back_data_cursor_and_triggers() {
        let (_d, s) = store().await;
        let t = entity(
            "task",
            json!({"title":"invalid","status":"todo","sectionId":Uuid::new_v4().to_string()}),
        );
        assert!(s.entities_pull(&feed(vec![t], 1), "device").await.is_err());
        assert_eq!(s.entities_cursor().await.unwrap(), 0);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let triggers: i64 =
            sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger'")
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert!(triggers > 10);
    }
    #[tokio::test]
    async fn unknown_mobile_fields_survive_native_edit_and_ack_inflight_edit() {
        let (_d, s) = store().await;
        let t = entity(
            "task",
            json!({"title":"old","status":"todo","custom":{"keep":true},"priority":0}),
        );
        s.entities_pull(&feed(vec![t.clone()], 1), "device")
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET title='local',version=version+1 WHERE id=?")
            .bind(&t.id)
            .execute(&s.pool)
            .await
            .unwrap();
        let cmd = s
            .entities_prepare("device")
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.changes.iter().any(|e| e.id == t.id))
            .unwrap();
        sqlx::query("UPDATE tasks SET title='newer',version=version+1 WHERE id=?")
            .bind(&t.id)
            .execute(&s.pool)
            .await
            .unwrap();
        let ack = cmd
            .changes
            .iter()
            .map(|c| Entity {
                id: c.id.clone(),
                kind: c.kind.clone(),
                version: 2,
                data: c.data.clone(),
                deleted: c.deleted,
                created_at: c.created_at.clone(),
                updated_at: "2026-10-11T01:00:00Z".into(),
            })
            .collect::<Vec<_>>();
        s.entities_ack(&cmd, &ack).await.unwrap();
        let current = s
            .entities_snapshot()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.id == t.id)
            .unwrap();
        assert_eq!(current.data["title"], "newer");
        assert_eq!(current.data["custom"], json!({"keep":true}));
        assert!(s
            .entities_prepare("device")
            .await
            .unwrap()
            .iter()
            .flat_map(|c| &c.changes)
            .any(|e| e.id == t.id && e.data["title"] == "newer"));
    }
    #[tokio::test]
    async fn conflict_resolution_guard_receipt_and_both_versions_retained() {
        let (_d, s) = store().await;
        let mut t = entity("task", json!({"title":"initial","status":"todo"}));
        s.entities_pull(&feed(vec![t.clone()], 1), "device")
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET title='local',version=version+1 WHERE id=?")
            .bind(&t.id)
            .execute(&s.pool)
            .await
            .unwrap();
        let _ = s.entities_prepare("device").await.unwrap();
        t.data["title"] = json!("remote");
        t.version = 2;
        s.entities_pull(&feed(vec![t.clone()], 2), "device")
            .await
            .unwrap();
        let conflicts = s.entities_conflicts().await.unwrap();
        let c = &conflicts[0];
        let resolution = Uuid::new_v4().to_string();
        assert!(s
            .entities_resolve(
                &super::s(c, "operationId"),
                &resolution,
                "remote",
                "stale",
                None
            )
            .await
            .is_err());
        s.entities_resolve(
            &super::s(c, "operationId"),
            &resolution,
            "remote",
            &super::s(c, "token"),
            None,
        )
        .await
        .unwrap();
        s.entities_resolve(
            &super::s(c, "operationId"),
            &resolution,
            "remote",
            &super::s(c, "token"),
            None,
        )
        .await
        .unwrap();
        let title: String = sqlx::query_scalar("SELECT title FROM tasks WHERE id=?")
            .bind(&t.id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(title, "remote");
        let history: String =
            sqlx::query_scalar("SELECT payload FROM lan_entity_history WHERE id=?")
                .bind(resolution)
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert!(history.contains("local") && history.contains("remote"));
    }
}
impl Store {
    pub async fn entities_generation(&self) -> StoreResult<Option<String>> {
        sqlx::query_scalar("SELECT generation FROM lan_entity_state WHERE singleton=1")
            .fetch_one(&self.pool)
            .await
            .map_err(err)
    }
    pub async fn entities_rebase(
        &self,
        remote: &[Entity],
        cursor: i64,
        generation: &str,
        device: &str,
    ) -> StoreResult<()> {
        Uuid::parse_str(generation).map_err(|_| "无效服务器代次")?;
        if cursor < 0 {
            return Err("无效服务器游标".into());
        }
        let mut tx = self.pool.begin().await.map_err(err)?;
        let old = mirrors(&mut tx).await?;
        let baseline = baselines(&mut tx).await?;
        let local = snapshot(&mut tx).await?;
        let mut clean = Vec::new();
        let mut conflicts = Vec::new();
        let mut ids = BTreeSet::new();
        let mut merged = Vec::new();
        let identity_collisions = identity::collisions(&mut tx, remote).await?;
        for e in remote {
            check(e)?;
            if !ids.insert(e.id.clone()) {
                return Err("恢复快照包含重复实体".into());
            }
            if !identity::collisions(&mut tx, &[e.clone()])
                .await?
                .is_empty()
            {
                conflicts.push(e.clone());
                continue;
            }
            let legacy_clean = local.get(&e.id).is_some_and(|l| {
                e.kind == "capture"
                    && !e
                        .data
                        .as_object()
                        .is_some_and(|d| d.contains_key("desktop"))
                    && capture_business(&l.data) == capture_business(&e.data)
                    && l.deleted == e.deleted
            });
            let base = baseline
                .get(&e.id)
                .cloned()
                .unwrap_or_else(|| old.get(&e.id).map(projection).unwrap_or(Value::Null));
            let base = if e.kind == "capture" {
                capture_projection_created(&base, &e.created_at)
            } else {
                base
            };
            let old_wire = old.get(&e.id).map(projection).unwrap_or(Value::Null);
            let pv = remote_projection(&old_wire, &base, &projection(e));
            let mut rp = e.clone();
            rp.data = val(&pv, "data").clone();
            rp.deleted = val(&pv, "deleted").as_bool().unwrap_or(e.deleted);
            if let Some(l) = local.get(&e.id) {
                let result = if legacy_clean {
                    Ok(pv.clone())
                } else {
                    let local = if e.kind == "capture" {
                        capture_projection_created(&projection(l), &e.created_at)
                    } else {
                        projection(l)
                    };
                    merge_data(&base, &local, &pv, true)
                };
                match result {
                    Ok(v) => {
                        clean.push(rp.clone());
                        rp.data = val(&v, "data").clone();
                        rp.deleted = val(&v, "deleted").as_bool().unwrap_or(l.deleted);
                        merged.push(rp);
                    }
                    Err(_) => conflicts.push(e.clone()),
                }
            } else {
                clean.push(rp.clone());
                merged.push(rp);
            }
        }
        let pending: Vec<(String, String)> =
            sqlx::query_as("SELECT operation_id,payload FROM lan_entity_pending")
                .fetch_all(&mut *tx)
                .await
                .map_err(err)?;
        // Retain the exact original command in recovery history before rebasing its CAS versions.
        for (id, payload) in pending {
            sqlx::query("INSERT OR IGNORE INTO lan_entity_history(id,occurred_at,payload) VALUES(?,?,?)").bind(format!("recovery:{generation}:{id}")).bind(chrono::Utc::now().to_rfc3339()).bind(json!({"kind":"server_recovery","originalCommand":serde_json::from_str::<Value>(&payload).map_err(|e|e.to_string())?,"generation":generation}).to_string()).execute(&mut *tx).await.map_err(err)?;
        }
        sqlx::query("DELETE FROM lan_entity_pending")
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        // Remote absence after server restore does not delete local entities: forget only their
        // remote acknowledgement, so the existing local content is uploaded again.
        for id in old.keys().filter(|id| !ids.contains(*id)) {
            sqlx::query("DELETE FROM lan_entities WHERE id=?")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
        }
        apply(&mut tx, &clean, &self.owner_id).await?;
        stamp(&mut tx, &clean.iter().map(|e| e.id.clone()).collect()).await?;
        apply(&mut tx, &merged, &self.owner_id).await?;
        for e in remote
            .iter()
            .filter(|e| !conflicts.iter().any(|c| c.id == e.id))
        {
            save_mirror(&mut tx, e).await?;
        }
        if !conflicts.is_empty() {
            let changes = conflicts
                .iter()
                .filter_map(|e| local.get(&e.id).map(|l| as_change(l, Some(e))))
                .chain(
                    identity_collisions
                        .iter()
                        .map(|l| as_change(l, old.get(&l.id))),
                )
                .collect();
            let cmd = Command {
                operation_id: Uuid::new_v4().to_string(),
                device_id: device.into(),
                changes,
            };
            sqlx::query("INSERT INTO lan_entity_pending(operation_id,payload,blocked,remote,message) VALUES(?,?,1,?,'服务恢复后存在未上传修改，双方均已保留')").bind(&cmd.operation_id).bind(serde_json::to_string(&cmd).unwrap()).bind(serde_json::to_string(&conflicts).unwrap()).execute(&mut *tx).await.map_err(err)?;
        }
        sqlx::query(
            "UPDATE lan_entity_state SET cursor=?,generation=?,last_success=? WHERE singleton=1",
        )
        .bind(cursor)
        .bind(generation)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await
        .map_err(err)?;
        tx.commit().await.map_err(err)
    }
}
