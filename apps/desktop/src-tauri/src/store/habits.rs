use super::planning::{replay, validate_operation};
use super::*;
use chrono::{Datelike, Duration as Days, Utc};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HabitCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: HabitAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HabitAction {
    Create {
        id: String,
        name: String,
        start_date: String,
        frequency: String,
        weekdays: Vec<u32>,
        weekly_target: i64,
        trigger_context: String,
        normal_version: String,
        minimum_version: String,
        notes: String,
        project_id: Option<String>,
    },
    Rule {
        id: String,
        expected_version: i64,
        effective_from: String,
        time_zone: String,
        frequency: String,
        weekdays: Vec<u32>,
        weekly_target: i64,
        paused: bool,
        confirmed: bool,
    },
    Entry {
        id: String,
        date: String,
        status: Option<String>,
        note: String,
        time_zone: String,
        expected_version: Option<i64>,
    },
}
#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct Habit {
    id: String,
    name: String,
    start_date: String,
    trigger_context: String,
    normal_version: String,
    minimum_version: String,
    notes: String,
    project_id: Option<String>,
    version: i64,
    created_at: String,
}
#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct Schedule {
    habit_id: String,
    version: i64,
    effective_from: String,
    effective_until: Option<String>,
    frequency: String,
    weekdays: String,
    weekly_target: i64,
    paused: bool,
    interval_days: i64,
    time_zone: Option<String>,
}
#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    habit_id: String,
    local_date: String,
    status: Option<String>,
    note: String,
    timezone: String,
    occurred_at: String,
    schedule_version: i64,
    version: i64,
}
fn day(s: &str) -> StoreResult<NaiveDate> {
    validate_date(s)?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| e.to_string())
}
fn applies(s: &Schedule, d: NaiveDate) -> bool {
    if s.paused
        || d.to_string() < s.effective_from
        || s.effective_until
            .as_ref()
            .is_some_and(|end| d.to_string() >= *end)
    {
        return false;
    }
    if s.interval_days > 1
        && day(&s.effective_from)
            .map(|start| (d - start).num_days() % s.interval_days != 0)
            .unwrap_or(true)
    {
        return false;
    }
    s.frequency != "weekdays"
        || serde_json::from_str::<Vec<u32>>(&s.weekdays)
            .unwrap_or_default()
            .contains(&d.weekday().number_from_monday())
}
fn rule_at<'a>(rules: &'a [Schedule], id: &str, date: NaiveDate) -> Option<&'a Schedule> {
    let d = date.to_string();
    rules.iter().find(|s| {
        s.habit_id == id
            && s.effective_from <= d
            && s.effective_until.as_ref().is_none_or(|end| d < *end)
    })
}
fn validated_weekdays(
    frequency: &str,
    weekdays: &[u32],
    weekly_target: i64,
) -> StoreResult<Vec<u32>> {
    let mut days = weekdays.to_vec();
    days.sort();
    days.dedup();
    if !["daily", "weekdays", "weekly"].contains(&frequency)
        || !(1..=7).contains(&weekly_target)
        || days.iter().any(|d| !(1..=7).contains(d))
        || days.len() != weekdays.len()
        || (frequency == "weekdays" && days.is_empty())
    {
        return Err("USER:请选择有效频率、星期和周目标".into());
    }
    Ok(days)
}
impl Store {
    pub(super) async fn apply_habit_arrangements(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        c: &PlanCommand,
    ) -> StoreResult<()> {
        let selected = day(&c.date)?;
        let mut seen = std::collections::HashSet::new();
        for change in &c.habit_changes {
            if !seen.insert(&change.habit_id)
                || change.day_rank < 1
                || change.expected_version.is_some_and(|v| v < 0)
                || !["morning", "afternoon", "evening"].contains(&change.day_period.as_str())
            {
                return Err("USER:习惯安排无效".into());
            }
            let rule: Option<Schedule> = sqlx::query_as("SELECT s.* FROM habit_schedules s JOIN habits h ON h.id=s.habit_id WHERE h.owner_id=? AND h.id=? AND h.deleted_at IS NULL AND s.effective_from<=? AND (s.effective_until IS NULL OR s.effective_until>?)")
                .bind(&self.owner_id).bind(&change.habit_id).bind(&c.date).bind(&c.date).fetch_optional(&mut **tx).await.map_err(|e| e.to_string())?;
            if rule.is_none_or(|r| !applies(&r, selected)) {
                return Err("STATE_CONFLICT".into());
            }
            let recorded: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM habit_entries WHERE habit_id=? AND local_date=? AND status IS NOT NULL)")
                .bind(&change.habit_id).bind(&c.date).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
            if recorded {
                return Err("STATE_CONFLICT".into());
            }
            let version: Option<i64> = sqlx::query_scalar(
                "SELECT version FROM habit_daily_plans WHERE habit_id=? AND local_date=?",
            )
            .bind(&change.habit_id)
            .bind(&c.date)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            if version != change.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            sqlx::query("INSERT INTO habit_daily_plans(habit_id,local_date,day_period,day_rank) VALUES(?,?,?,?) ON CONFLICT(habit_id,local_date) DO UPDATE SET day_period=excluded.day_period,day_rank=excluded.day_rank,version=habit_daily_plans.version+1")
                .bind(&change.habit_id).bind(&c.date).bind(&change.day_period).bind(change.day_rank).execute(&mut **tx).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO habit_events(id,habit_id,local_date,occurred_at,payload) VALUES(?,?,?,?,?)")
                .bind(format!("{}:{}",c.operation_id,change.habit_id)).bind(&change.habit_id).bind(&c.date).bind(&c.occurred_at)
                .bind(json!({"kind":"arranged","change":change}).to_string()).execute(&mut **tx).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub async fn habit_command(&self, c: &HabitCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(&mut tx, &self.owner_id, &c.operation_id, "habit", &payload).await? {
            return Ok(());
        }
        let (entity, date) = match &c.action {
            HabitAction::Create {
                id,
                name,
                start_date,
                frequency,
                weekdays,
                weekly_target,
                trigger_context,
                normal_version,
                minimum_version,
                notes,
                project_id,
            } => {
                Uuid::parse_str(id).map_err(|_| "USER:无效习惯标识")?;
                day(start_date)?;
                if name.trim().is_empty()
                    || name.chars().count() > 500
                    || [trigger_context, normal_version, minimum_version, notes]
                        .iter()
                        .any(|v| v.chars().count() > 100000)
                {
                    return Err("USER:名称必填，内容超出长度限制".into());
                }
                let days = validated_weekdays(frequency, weekdays, *weekly_target)?;
                if let Some(p) = project_id {
                    let found: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_id=?)",
                    )
                    .bind(p)
                    .bind(&self.owner_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if !found {
                        return Err("USER:关联项目不存在".into());
                    }
                }
                sqlx::query("INSERT INTO habits(id,owner_id,name,start_date,trigger_context,normal_version,minimum_version,notes,project_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
                    .bind(id).bind(&self.owner_id).bind(name.trim()).bind(start_date).bind(trigger_context).bind(normal_version).bind(minimum_version).bind(notes).bind(project_id).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                let zone: Option<String> =
                    sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO habit_schedules(habit_id,version,effective_from,frequency,weekdays,weekly_target,time_zone) VALUES(?,0,?,?,?,?,?)")
                    .bind(id).bind(start_date).bind(frequency).bind(json!(days).to_string()).bind(weekly_target).bind(zone.unwrap_or("Asia/Hong_Kong".into())).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                (id.clone(), None)
            }
            HabitAction::Rule {
                id,
                expected_version,
                effective_from,
                time_zone,
                frequency,
                weekdays,
                weekly_target,
                paused,
                confirmed,
            } => {
                if !confirmed {
                    return Err("USER:请先检查规则预览并确认".into());
                }
                let zone = time_zone.parse::<Tz>().map_err(|_| "USER:无效时区")?;
                let workspace: Option<String> =
                    sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if workspace.as_deref().unwrap_or("UTC") != time_zone {
                    return Err("USER:工作空间时区已变更，请刷新后调整".into());
                }
                let today = DateTime::parse_from_rfc3339(&c.occurred_at)
                    .unwrap()
                    .with_timezone(&zone)
                    .date_naive();
                let effective = day(effective_from)?;
                if effective != today + Days::days(1)
                    && effective
                        != today + Days::days(7 - today.weekday().num_days_from_monday() as i64)
                {
                    return Err("USER:规则只能从次日或下周一生效".into());
                }
                let version: Option<i64> =
                    sqlx::query_scalar("SELECT version FROM habits WHERE id=? AND owner_id=?")
                        .bind(id)
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if version != Some(*expected_version) {
                    return Err("STATE_CONFLICT".into());
                }
                let old: Schedule = sqlx::query_as(
                    "SELECT * FROM habit_schedules WHERE habit_id=? ORDER BY version DESC LIMIT 1",
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if old.effective_from > today.to_string() {
                    return Err("USER:已有尚未生效的规则，请待其生效后再调整".into());
                }
                let days = validated_weekdays(frequency, weekdays, *weekly_target)?;
                sqlx::query(
                    "UPDATE habit_schedules SET effective_until=? WHERE habit_id=? AND version=?",
                )
                .bind(effective_from)
                .bind(id)
                .bind(old.version)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                sqlx::query("INSERT INTO habit_schedules(habit_id,version,effective_from,frequency,weekdays,weekly_target,paused,time_zone) VALUES(?,?,?,?,?,?,?,?)").bind(id).bind(old.version+1).bind(effective_from).bind(frequency).bind(json!(days).to_string()).bind(weekly_target).bind(paused).bind(time_zone).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE habits SET version=version+1 WHERE id=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                (id.clone(), None)
            }
            HabitAction::Entry {
                id,
                date,
                status,
                note,
                time_zone,
                expected_version,
            } => {
                let date_day = day(date)?;
                let zone = time_zone.parse::<Tz>().map_err(|_| "USER:无效时区")?;
                let workspace: Option<String> =
                    sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if workspace.as_deref().unwrap_or("UTC") != time_zone {
                    return Err("USER:工作空间时区已变更，请刷新后记录".into());
                }
                if date_day
                    > DateTime::parse_from_rfc3339(&c.occurred_at)
                        .unwrap()
                        .with_timezone(&zone)
                        .date_naive()
                {
                    return Err("USER:不能记录未来日期".into());
                }
                if status
                    .as_ref()
                    .is_some_and(|s| s != "done" && s != "skipped")
                    || note.chars().count() > 100000
                {
                    return Err("USER:无效记录状态或备注过长".into());
                }
                let rule:Option<Schedule>=sqlx::query_as("SELECT s.* FROM habit_schedules s JOIN habits h ON h.id=s.habit_id WHERE h.id=? AND h.owner_id=? AND s.effective_from<=? AND (s.effective_until IS NULL OR s.effective_until>?)")
                    .bind(id).bind(&self.owner_id).bind(date).bind(date).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                let rule = rule.ok_or("USER:该日期没有有效习惯规则")?;
                if status.is_some() && !applies(&rule, date_day) {
                    return Err("USER:该日期不适用此习惯".into());
                }
                let old: Option<Entry> =
                    sqlx::query_as("SELECT * FROM habit_entries WHERE habit_id=? AND local_date=?")
                        .bind(id)
                        .bind(date)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if old.as_ref().map(|e| e.version) != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                if status.is_none() && old.as_ref().is_none_or(|e| e.status.is_none()) {
                    return Err("USER:没有可撤销的记录".into());
                }
                sqlx::query("INSERT INTO habit_entries(habit_id,local_date,status,note,timezone,occurred_at,schedule_version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(habit_id,local_date) DO UPDATE SET status=excluded.status,note=excluded.note,timezone=excluded.timezone,occurred_at=excluded.occurred_at,schedule_version=excluded.schedule_version,version=habit_entries.version+1")
                    .bind(id).bind(date).bind(status).bind(note).bind(time_zone).bind(&c.occurred_at).bind(rule.version).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                // The event includes the previous provenance even when the current row is replaced or undone.
                sqlx::query("INSERT INTO habit_events(id,habit_id,local_date,occurred_at,payload) VALUES(?,?,?,?,?)")
                    .bind(format!("{}:before",c.operation_id)).bind(id).bind(date).bind(&c.occurred_at).bind(json!({"before":old}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                (id.clone(), Some(date.clone()))
            }
        };
        sqlx::query("INSERT INTO habit_events(id,habit_id,local_date,occurred_at,payload) VALUES(?,?,?,?,?)")
            .bind(&c.operation_id).bind(entity).bind(date).bind(&c.occurred_at).bind(&payload).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        self.queue_operation(&mut tx, &c.operation_id, "habit", &payload, &c.occurred_at)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn habit_snapshot(&self, date: &str) -> StoreResult<Value> {
        let selected = day(date)?;
        let monday = selected - Days::days(selected.weekday().num_days_from_monday() as i64);
        let sunday = monday + Days::days(6);
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let zone: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        let zone = zone.unwrap_or("UTC".into());
        let today = Utc::now()
            .with_timezone(
                &zone
                    .parse::<Tz>()
                    .map_err(|_| "Invalid workspace timezone")?,
            )
            .date_naive();
        let habits:Vec<Habit>=sqlx::query_as("SELECT id,name,start_date,trigger_context,normal_version,minimum_version,notes,project_id,version,created_at FROM habits WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at,id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let rules: Vec<Schedule> = sqlx::query_as(
            "SELECT s.* FROM habit_schedules s JOIN habits h ON h.id=s.habit_id WHERE h.owner_id=?",
        )
        .bind(&self.owner_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let entries:Vec<Entry>=sqlx::query_as("SELECT e.* FROM habit_entries e JOIN habits h ON h.id=e.habit_id WHERE h.owner_id=? AND e.local_date BETWEEN ? AND ?").bind(&self.owner_id).bind(monday.to_string()).bind(sunday.to_string()).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let placements: Vec<(String,String,String,i64,i64)> = sqlx::query_as("SELECT p.habit_id,p.local_date,p.day_period,p.day_rank,p.version FROM habit_daily_plans p JOIN habits h ON h.id=p.habit_id WHERE h.owner_id=? AND p.local_date<=? ORDER BY p.local_date DESC")
            .bind(&self.owner_id).bind(date).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for h in &habits {
            let selected_rule = rule_at(&rules, &h.id, selected);
            let mut eligible = 0;
            let mut done = 0;
            let mut skipped = 0;
            let mut remaining = Vec::new();
            for offset in 0..7 {
                let d = monday + Days::days(offset);
                let rule = rule_at(&rules, &h.id, d);
                if rule.is_some_and(|r| applies(r, d)) {
                    eligible += 1;
                    let e = entries
                        .iter()
                        .find(|e| e.habit_id == h.id && e.local_date == d.to_string());
                    if e.is_some_and(|e| e.status.as_deref() == Some("done")) {
                        done += 1;
                    } else if e.is_some_and(|e| e.status.as_deref() == Some("skipped")) {
                        skipped += 1;
                    } else if d >= today {
                        remaining.push(d.to_string());
                    }
                }
            }
            let rule_versions: std::collections::HashSet<i64> = (0..7)
                .filter_map(|n| rule_at(&rules, &h.id, monday + Days::days(n)).map(|r| r.version))
                .collect();
            let incomplete = h.start_date > monday.to_string()
                || rule_versions.len() > 1
                || (0..7).any(|n| {
                    rule_at(&rules, &h.id, monday + Days::days(n)).is_none_or(|r| r.paused)
                });
            let statistics_rule = selected_rule
                .or_else(|| (0..7).find_map(|n| rule_at(&rules, &h.id, monday + Days::days(n))));
            let target = statistics_rule
                .filter(|r| r.frequency == "weekly")
                .map_or(eligible, |r| r.weekly_target);
            let collapsed =
                selected_rule.is_some_and(|r| r.frequency == "weekly") && done >= target;
            let entry = entries
                .iter()
                .find(|e| e.habit_id == h.id && e.local_date == date);
            let applicable = selected_rule.is_some_and(|r| applies(r, selected));
            let placement = placements.iter().find(|p| p.0 == h.id);
            let exact = placement.filter(|p| p.1 == date);
            result.push(json!({"habit":h,"rules":rules.iter().filter(|r|r.habit_id==h.id).collect::<Vec<_>>(),"schedule":selected_rule,"entry":entry,"applicable":applicable,"collapsed":collapsed,
                "placement":{"dayPeriod":placement.map_or("morning",|p|p.2.as_str()),"dayRank":exact.map_or(0,|p|p.3),"version":exact.map(|p|p.4)},
                "week":{"from":monday.to_string(),"until":sunday.to_string(),"done":done,"target":target,"skipped":skipped,"remainingDates":remaining,"incomplete":incomplete,"state":if today<=sunday && today>=monday {"进行中"} else if incomplete {"不完整周"} else if today<monday {"尚未开始"} else if done>=target {"已达标"} else {"已结束"}}}));
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(json!({"date":date,"today":today.to_string(),"timeZone":zone,"habits":result}))
    }
}
