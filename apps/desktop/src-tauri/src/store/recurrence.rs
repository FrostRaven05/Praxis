use super::planning::{replay, validate_operation};
use super::*;
use chrono::{Datelike, Duration};
use serde_json::{json, Value};
use sqlx::{Sqlite, Transaction};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecurrenceCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: RecurrenceAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RecurrenceAction {
    Edit {
        id: String,
        expected_version: i64,
        effective_date: String,
        title: String,
        interval_days: i64,
        weekdays: Vec<u32>,
        time_zone: String,
        expected_tasks: Vec<(String, i64)>,
        overwrite_overrides: bool,
    },
    Create {
        id: String,
        title: String,
        project_id: Option<String>,
        start_date: String,
        interval_days: i64,
        weekdays: Vec<u32>,
    },
    Expand {
        id: String,
        through: String,
        batch_size: usize,
    },
    Stop {
        id: String,
        expected_version: i64,
    },
}
#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub start_date: String,
    pub time_zone: String,
    pub interval_days: i64,
    #[serde(skip_serializing)]
    pub interval_days_extended: Option<i64>,
    pub weekdays: String,
    pub enabled: bool,
    pub expanded_through: Option<String>,
    pub version: i64,
}
fn date(s: &str) -> StoreResult<NaiveDate> {
    validate_date(s)?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| e.to_string())
}
pub fn matches(t: &Template, d: NaiveDate) -> bool {
    let start = NaiveDate::parse_from_str(&t.start_date, "%Y-%m-%d").unwrap();
    let days: Vec<u32> = serde_json::from_str(&t.weekdays).unwrap_or_default();
    d >= start
        && if days.is_empty() {
            (d - start).num_days() % t.interval_days_extended.unwrap_or(t.interval_days) == 0
        } else {
            days.contains(&d.weekday().number_from_monday())
        }
}
fn pending_rules(t: &Template, rules: &[Rule], through: NaiveDate) -> StoreResult<Vec<NaiveDate>> {
    let mut d = if let Some(w) = &t.expanded_through {
        date(w)?.succ_opt().ok_or("日期超出范围")?
    } else {
        date(&t.start_date)?
    };
    let mut result = vec![];
    while d <= through {
        let rule = rule_at(t, rules, d);
        if rule.enabled && matches(&rule, d) {
            result.push(d)
        }
        d = d.succ_opt().ok_or("日期超出范围")?;
    }
    Ok(result)
}
#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Rule {
    effective_date: String,
    title: String,
    interval_days: i64,
    #[serde(skip_serializing)]
    interval_days_extended: Option<i64>,
    active: bool,
    weekdays: String,
    time_zone: String,
    anchor_date: String,
}
fn rule_at(t: &Template, rules: &[Rule], d: NaiveDate) -> Template {
    let mut out = t.clone();
    if let Some(r) = rules
        .iter()
        .rev()
        .find(|r| r.effective_date <= d.to_string())
    {
        out.start_date = r.anchor_date.clone();
        out.title = r.title.clone();
        out.interval_days = r.interval_days;
        out.interval_days_extended = r.interval_days_extended;
        out.enabled = out.enabled && r.active;
        out.weekdays = r.weekdays.clone();
        out.time_zone = r.time_zone.clone();
    }
    out
}
async fn rules(tx: &mut Transaction<'_, Sqlite>, id: &str) -> StoreResult<Vec<Rule>> {
    sqlx::query_as("SELECT effective_date,title,interval_days,interval_days_extended,active,weekdays,time_zone,anchor_date FROM recurrence_rules WHERE template_id=? ORDER BY effective_date").bind(id).fetch_all(&mut **tx).await.map_err(|e|e.to_string())
}
async fn future(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> StoreResult<Vec<(String, i64, String, String, bool, String)>> {
    sqlx::query_as("SELECT id,version,occurrence_key,title,(is_occurrence_override=1 OR status IN('in_progress','blocked') OR waiting=1),status FROM tasks WHERE recurrence_template_id=? AND deleted_at IS NULL ORDER BY id").bind(id).fetch_all(&mut **tx).await.map_err(|e|e.to_string())
}
impl Store {
    pub async fn recurrence_edit_preview(&self, action: &RecurrenceAction) -> StoreResult<Value> {
        let RecurrenceAction::Edit {
            id,
            expected_version,
            effective_date,
            title,
            interval_days,
            weekdays,
            time_zone,
            expected_tasks,
            overwrite_overrides,
        } = action
        else {
            return Err("USER:只能预览规则修改".into());
        };
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let t: Template =
            sqlx::query_as("SELECT * FROM recurrence_templates WHERE id=? AND owner_id=?")
                .bind(id)
                .bind(&self.owner_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        validate_edit(
            &t,
            *expected_version,
            effective_date,
            title,
            *interval_days,
            weekdays,
            time_zone,
            &chrono::Utc::now().to_rfc3339(),
        )?;
        let tasks = future(&mut tx, id).await?;
        validate_preview_tasks(&tasks, expected_tasks)?;
        let new = edited_template(
            t,
            effective_date,
            title,
            *interval_days,
            weekdays,
            time_zone,
        );
        let mut effects = vec![];
        for (id, _, key, title, exception, status) in tasks {
            if key < *effective_date {
                continue;
            }
            let next = edit_status(&new, &key, exception, &status, *overwrite_overrides)?;
            let effect = match next.as_deref() {
                None if status == "completed" => "preserveHistory",
                None => "preserveOverride",
                Some("cancelled") => "cancel",
                Some(_) => "update",
            };
            effects.push(json!({"id":id,"occurrenceKey":key,"title":title,"effect":effect,"nextStatus":next}));
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(json!({"effects":effects}))
    }
    pub async fn recurrence_snapshot(&self) -> StoreResult<Value> {
        let templates:Vec<Template>=sqlx::query_as("SELECT r.* FROM recurrence_templates r LEFT JOIN projects p ON p.id=r.project_id WHERE r.owner_id=? AND r.deleted_at IS NULL AND (r.project_id IS NULL OR p.deleted_at IS NULL) ORDER BY r.start_date,r.id").bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())?;
        let mut rows = vec![];
        for t in templates {
            let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
            let rs = rules(&mut tx, &t.id).await?;
            let tasks = future(&mut tx, &t.id).await?;
            tx.commit().await.map_err(|e| e.to_string())?;
            let zone = t.time_zone.parse::<Tz>().map_err(|e| e.to_string())?;
            let through = chrono::Utc::now().with_timezone(&zone).date_naive() + Duration::days(30);
            let remaining = if t.enabled {
                pending_rules(&t, &rs, through)?.len()
            } else {
                0
            };
            let mut wire_template = serde_json::to_value(&t).map_err(|e| e.to_string())?;
            wire_template["intervalDays"] =
                json!(t.interval_days_extended.unwrap_or(t.interval_days));
            let wire_rules = rs
                .iter()
                .map(|r| {
                    let mut v = serde_json::to_value(r).unwrap();
                    v["intervalDays"] = json!(r.interval_days_extended.unwrap_or(r.interval_days));
                    v
                })
                .collect::<Vec<_>>();
            rows.push(json!({"template":wire_template,"rules":wire_rules,"futureTasks":tasks.iter().map(|(id,version,key,title,exception,status)|json!({"id":id,"version":version,"occurrenceKey":key,"title":title,"exception":exception,"status":status})).collect::<Vec<_>>(),"through":through.to_string(),"remaining":remaining}));
        }
        Ok(json!({"templates":rows}))
    }
    pub async fn recurrence_command(&self, c: &RecurrenceCommand) -> StoreResult<()> {
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
        let entity;
        match &c.action {
            RecurrenceAction::Edit {
                id,
                expected_version,
                effective_date,
                title,
                interval_days,
                weekdays,
                time_zone,
                expected_tasks,
                overwrite_overrides,
            } => {
                let t: Template =
                    sqlx::query_as("SELECT * FROM recurrence_templates WHERE id=? AND owner_id=?")
                        .bind(id)
                        .bind(&self.owner_id)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                validate_edit(
                    &t,
                    *expected_version,
                    effective_date,
                    title,
                    *interval_days,
                    weekdays,
                    time_zone,
                    &c.occurred_at,
                )?;
                let effective = date(effective_date)?;
                let tasks = future(&mut tx, id).await?;
                validate_preview_tasks(&tasks, expected_tasks)?;
                sqlx::query(
                    "DELETE FROM recurrence_rules WHERE template_id=? AND effective_date>=?",
                )
                .bind(id)
                .bind(effective_date)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO recurrence_rules(template_id,effective_date,title,interval_days,weekdays,time_zone,anchor_date,interval_days_extended,active) VALUES(?,?,?,?,?,?,?,?,1)")
                    .bind(id)
                    .bind(effective_date)
                    .bind(title.trim())
                    .bind((*interval_days).min(366))
                    .bind(json!(weekdays).to_string())
                    .bind(time_zone)
                    .bind(effective_date)
                    .bind(interval_days)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                let new = edited_template(
                    t,
                    effective_date,
                    title,
                    *interval_days,
                    weekdays,
                    time_zone,
                );
                for (task, _, key, _, exception, status) in tasks {
                    let Some(status) =
                        edit_status(&new, &key, exception, &status, *overwrite_overrides)?
                    else {
                        continue;
                    };
                    sqlx::query("UPDATE tasks SET title=?,plan_value=?,status=?,version=version+1 WHERE id=?").bind(&new.title).bind(json!({"kind":"date","date":key}).to_string()).bind(status).bind(&task).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    sqlx::query("UPDATE tasks SET is_occurrence_override=0 WHERE id=?")
                        .bind(task)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                sqlx::query("UPDATE recurrence_templates SET version=version+1,expanded_through=CASE WHEN expanded_through>=? THEN ? ELSE expanded_through END WHERE id=?").bind(effective_date).bind(effective.pred_opt().unwrap().to_string()).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = id.clone();
            }
            RecurrenceAction::Create {
                id,
                title,
                project_id,
                start_date,
                interval_days,
                weekdays,
            } => {
                Uuid::parse_str(id).map_err(|_| "USER:无效模板 ID")?;
                let start = date(start_date)?;
                if start.year() < 1900
                    || start.year() > 2200
                    || title.trim().is_empty()
                    || title.chars().count() > 500
                    || !(1..=3650).contains(interval_days)
                    || weekdays.iter().any(|d| !(1..=7).contains(d))
                {
                    return Err("USER:请填写有效标题、1900–2200日期、间隔或星期".into());
                }
                if let Some(p) = project_id {
                    let ok:i64=sqlx::query_scalar("SELECT count(*) FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL AND status NOT IN('completed','archived') AND canceled=0 AND archived_at IS NULL").bind(p).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if ok != 1 {
                        return Err("USER:项目不可用，请重开项目或选择独立任务".into());
                    }
                }
                let zone: Option<String> =
                    sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO recurrence_templates(id,owner_id,title,project_id,start_date,time_zone,interval_days,weekdays,interval_days_extended) VALUES(?,?,?,?,?,?,?,?,?)").bind(id).bind(&self.owner_id).bind(title.trim()).bind(project_id).bind(start_date).bind(zone.ok_or("USER:请先在时间设置确认工作空间时区")?).bind((*interval_days).min(366)).bind(serde_json::to_string(weekdays).unwrap()).bind(interval_days).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("INSERT INTO recurrence_rules(template_id,effective_date,title,interval_days,weekdays,time_zone,anchor_date,interval_days_extended) SELECT id,start_date,title,interval_days,weekdays,time_zone,start_date,interval_days_extended FROM recurrence_templates WHERE id=?").bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                entity = id.clone();
            }
            RecurrenceAction::Expand {
                id,
                through,
                batch_size,
            } => {
                if !(1..=500).contains(batch_size) {
                    return Err("USER:每批需为1–500项".into());
                }
                let t: Template =
                    sqlx::query_as("SELECT * FROM recurrence_templates WHERE id=? AND owner_id=?")
                        .bind(id)
                        .bind(&self.owner_id)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if !t.enabled {
                    return Err("USER:模板已停止".into());
                }
                let end = date(through)?;
                let now = DateTime::parse_from_rfc3339(&c.occurred_at)
                    .map_err(|e| e.to_string())?
                    .with_timezone(&t.time_zone.parse::<Tz>().map_err(|e| e.to_string())?)
                    .date_naive();
                if end > now + Duration::days(30) {
                    return Err("USER:仅展开到未来30天".into());
                }
                if let Some(p) = &t.project_id {
                    let ok:i64=sqlx::query_scalar("SELECT count(*) FROM projects WHERE id=? AND deleted_at IS NULL AND status NOT IN('completed','archived') AND canceled=0 AND archived_at IS NULL").bind(p).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if ok != 1 {
                        return Err("USER:项目已停止，请处理模板".into());
                    }
                }
                let rs = rules(&mut tx, id).await?;
                let dates = pending_rules(&t, &rs, end)?;
                for d in dates.iter().take(*batch_size) {
                    let t = rule_at(&t, &rs, *d);
                    let key = d.to_string();
                    let task_id = Uuid::new_v5(
                        &Uuid::NAMESPACE_URL,
                        format!("praxis:occurrence:{id}:{key}").as_bytes(),
                    )
                    .to_string();
                    sqlx::query("INSERT INTO tasks(id,owner_id,title,project_id,source,created_at,plan_value,recurrence_template_id,occurrence_key) VALUES(?,?,?,?,'temporary',?,?,?,?) ON CONFLICT(recurrence_template_id,occurrence_key) WHERE recurrence_template_id IS NOT NULL DO NOTHING").bind(task_id).bind(&self.owner_id).bind(&t.title).bind(&t.project_id).bind(&c.occurred_at).bind(json!({"kind":"date","date":key}).to_string()).bind(id).bind(key).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                let watermark = if dates.len() > *batch_size {
                    dates[*batch_size - 1]
                } else {
                    end
                };
                if t.expanded_through
                    .as_ref()
                    .map(|s| s < &watermark.to_string())
                    .unwrap_or(true)
                {
                    sqlx::query("UPDATE recurrence_templates SET expanded_through=?,version=version+1 WHERE id=?").bind(watermark.to_string()).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                entity = id.clone();
            }
            RecurrenceAction::Stop {
                id,
                expected_version,
            } => {
                let n=sqlx::query("UPDATE recurrence_templates SET enabled=0,version=version+1 WHERE id=? AND owner_id=? AND version=?").bind(id).bind(&self.owner_id).bind(expected_version).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                if n != 1 {
                    return Err("STATE_CONFLICT".into());
                }
                entity = id.clone();
            }
        }
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(entity)
            .bind("recurrence")
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
        tx.commit().await.map_err(|e| e.to_string())
    }
}

pub(super) async fn change_zone(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &str,
    zone: &str,
    at: &str,
    expected: &Option<Vec<(String, i64)>>,
) -> StoreResult<()> {
    let ts: Vec<Template> = sqlx::query_as(
        "SELECT * FROM recurrence_templates WHERE owner_id=? AND deleted_at IS NULL AND enabled=1 ORDER BY id",
    )
    .bind(owner)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let actual: Vec<_> = ts.iter().map(|t| (t.id.clone(), t.version)).collect();
    let mut given = expected.clone().unwrap_or_default();
    given.sort();
    if actual != given {
        return Err("STATE_CONFLICT".into());
    }
    let effective = (DateTime::parse_from_rfc3339(at)
        .map_err(|e| e.to_string())?
        .with_timezone(&zone.parse::<Tz>().map_err(|e| e.to_string())?)
        .date_naive()
        + Duration::days(1))
    .to_string();
    for t in ts {
        let rs = rules(tx, &t.id).await?;
        let active = rule_at(&t, &rs, date(&effective)?);
        sqlx::query("INSERT INTO recurrence_rules(template_id,effective_date,title,interval_days,weekdays,time_zone,anchor_date,interval_days_extended,active) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(template_id,effective_date) DO UPDATE SET time_zone=excluded.time_zone").bind(&t.id).bind(&effective).bind(active.title).bind(active.interval_days).bind(active.weekdays).bind(zone).bind(active.start_date).bind(active.interval_days_extended).bind(active.enabled).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        sqlx::query(
            "UPDATE recurrence_rules SET time_zone=? WHERE template_id=? AND effective_date>=?",
        )
        .bind(zone)
        .bind(&t.id)
        .bind(&effective)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE recurrence_templates SET time_zone=?,version=version+1 WHERE id=?")
            .bind(zone)
            .bind(t.id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn edited_template(
    t: Template,
    effective: &str,
    title: &str,
    interval: i64,
    days: &[u32],
    zone: &str,
) -> Template {
    Template {
        start_date: effective.into(),
        title: title.trim().into(),
        interval_days: interval,
        interval_days_extended: Some(interval),
        weekdays: json!(days).to_string(),
        time_zone: zone.into(),
        ..t
    }
}
fn validate_edit(
    t: &Template,
    version: i64,
    effective: &str,
    title: &str,
    interval: i64,
    days: &[u32],
    zone: &str,
    at: &str,
) -> StoreResult<()> {
    let zone = zone.parse::<Tz>().map_err(|_| "USER:无效时区")?;
    let today = DateTime::parse_from_rfc3339(at)
        .map_err(|e| e.to_string())?
        .with_timezone(&zone)
        .date_naive();
    let effective = date(effective)?;
    if !t.enabled || t.version != version {
        return Err("STATE_CONFLICT".into());
    }
    if effective <= today
        || effective < date(&t.start_date)?
        || effective.year() > 2200
        || title.trim().is_empty()
        || title.chars().count() > 500
        || !(1..=3650).contains(&interval)
        || days.iter().any(|d| !(1..=7).contains(d))
    {
        return Err(
            "USER:生效日期应在明天起且不早于模板开始日（不晚于2200年），并填写有效规则".into(),
        );
    }
    Ok(())
}
fn validate_preview_tasks(
    tasks: &[(String, i64, String, String, bool, String)],
    expected: &[(String, i64)],
) -> StoreResult<()> {
    let actual: Vec<_> = tasks.iter().map(|t| (t.0.clone(), t.1)).collect();
    let mut expected = expected.to_vec();
    expected.sort();
    if actual != expected {
        return Err("STATE_CONFLICT".into());
    }
    Ok(())
}
fn edit_status(
    rule: &Template,
    key: &str,
    exception: bool,
    status: &str,
    overwrite: bool,
) -> StoreResult<Option<String>> {
    if key < rule.start_date.as_str() || status == "completed" || (exception && !overwrite) {
        return Ok(None);
    }
    Ok(Some(
        if !matches(rule, date(key)?) {
            "cancelled"
        } else if status == "cancelled" {
            "todo"
        } else {
            status
        }
        .into(),
    ))
}
