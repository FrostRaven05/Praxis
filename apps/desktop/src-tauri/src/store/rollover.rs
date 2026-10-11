use super::*;
use chrono::{Duration as CalendarDuration, TimeZone};
use serde_json::json;

fn plan_day(value: &TimeValue, zone: Tz) -> StoreResult<String> {
    match value {
        TimeValue::Date { date } => Ok(date.clone()),
        TimeValue::Instant { at_utc, .. } => Ok(DateTime::parse_from_rfc3339(at_utc)
            .map_err(|e| e.to_string())?
            .with_timezone(&zone)
            .date_naive()
            .to_string()),
    }
}

fn advance(value: &TimeValue, date: NaiveDate, zone: Tz) -> StoreResult<TimeValue> {
    match value {
        TimeValue::Date { .. } => Ok(TimeValue::Date {
            date: date.to_string(),
        }),
        TimeValue::Instant {
            at_utc,
            display_timezone,
        } => {
            let local = DateTime::parse_from_rfc3339(at_utc)
                .map_err(|e| e.to_string())?
                .with_timezone(&zone);
            let target = date.and_time(local.time());
            // A skipped DST hour advances to the first valid local minute that day.
            for minutes in 0..=180 {
                let candidate = target + CalendarDuration::minutes(minutes);
                if candidate.date() != date {
                    break;
                }
                if let Some(instant) = zone.from_local_datetime(&candidate).earliest() {
                    return Ok(TimeValue::Instant {
                        at_utc: instant
                            .with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
                        display_timezone: display_timezone.clone(),
                    });
                }
            }
            Ok(TimeValue::Date {
                date: date.to_string(),
            })
        }
    }
}

impl Store {
    pub async fn prepare_daily_tasks(&self, at: &str) -> StoreResult<()> {
        let zone: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        let zone = zone.unwrap_or("UTC".into());
        let date = DateTime::parse_from_rfc3339(at)
            .map_err(|e| e.to_string())?
            .with_timezone(
                &zone
                    .parse::<Tz>()
                    .map_err(|_| "Invalid workspace timezone")?,
            )
            .date_naive()
            .to_string();
        self.productivity_command(&ProductivityCommand {
            operation_id: Uuid::new_v4().to_string(),
            occurred_at: at.into(),
            action: ProductivityAction::Rollover {
                date,
                time_zone: zone,
            },
        })
        .await
    }

    pub(super) async fn apply_rollover(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        date: &str,
        time_zone: &str,
        at: &str,
    ) -> StoreResult<usize> {
        validate_date(date)?;
        let zone = time_zone.parse::<Tz>().map_err(|_| "Invalid time zone")?;
        let current: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        if current.as_deref().unwrap_or("UTC") != time_zone
            || DateTime::parse_from_rfc3339(at)
                .map_err(|e| e.to_string())?
                .with_timezone(&zone)
                .date_naive()
                .to_string()
                != date
        {
            return Err("STATE_CONFLICT".into());
        }
        let target = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
        let tasks: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT t.id,t.plan_value FROM tasks t WHERE t.owner_id=? AND t.deleted_at IS NULL
             AND t.status NOT IN ('completed','cancelled')
             AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id AND c.deleted_at IS NULL)
             AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND (p.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL OR p.canceled=1 OR p.status<>'active'))
             AND ((t.plan_value IS NOT NULL AND (json_extract(t.plan_value,'$.kind')='instant' OR json_extract(t.plan_value,'$.date')<?))
               OR EXISTS(SELECT 1 FROM daily_plan_items p WHERE p.owner_id=t.owner_id AND p.task_id=t.id AND p.removed=0 AND p.is_summary=0 AND p.execution_date<?))")
            .bind(&self.owner_id).bind(date).bind(date).fetch_all(&mut **tx).await.map_err(|e| e.to_string())?;
        let mut changed = 0;
        for (id, raw) in tasks {
            let plan: Option<TimeValue> = raw
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|e| e.to_string())?;
            // Respect an explicit future plan; do not revive superseded past arrangements.
            if plan
                .as_ref()
                .map(|v| plan_day(v, zone))
                .transpose()?
                .is_some_and(|d| d.as_str() > date)
            {
                continue;
            }
            let plans: Vec<(String, String)> = sqlx::query_as(
                "SELECT id,execution_date FROM daily_plan_items WHERE owner_id=? AND task_id=? AND removed=0 AND is_summary=0 ORDER BY execution_date DESC,created_at DESC,id")
                .bind(&self.owner_id).bind(&id).fetch_all(&mut **tx).await.map_err(|e| e.to_string())?;
            if plans.iter().any(|(_, d)| d.as_str() > date) {
                continue;
            }
            let past: Vec<_> = plans.iter().filter(|(_, d)| d.as_str() < date).collect();
            let old_plan = plan
                .as_ref()
                .map(|v| plan_day(v, zone))
                .transpose()?
                .is_some_and(|d| d.as_str() < date);
            if past.is_empty() && !old_plan {
                continue;
            }
            if !past.is_empty() {
                let existing: Option<(String, bool)> = sqlx::query_as("SELECT id,removed FROM daily_plan_items WHERE owner_id=? AND task_id=? AND execution_date=?")
                    .bind(&self.owner_id).bind(&id).bind(date).fetch_optional(&mut **tx).await.map_err(|e| e.to_string())?;
                if let Some((existing, removed)) = existing {
                    if removed {
                        sqlx::query("UPDATE daily_plan_items SET (is_focus,focus_rank,day_period,day_rank,estimated_minutes)=(SELECT is_focus,focus_rank,day_period,day_rank,estimated_minutes FROM daily_plan_items WHERE id=? AND owner_id=?),time_zone=? WHERE id=? AND owner_id=?")
                            .bind(&past[0].0).bind(&self.owner_id).bind(time_zone).bind(&existing).bind(&self.owner_id)
                            .execute(&mut **tx).await.map_err(|e| e.to_string())?;
                    }
                    sqlx::query("UPDATE daily_plan_items SET removed=0,is_summary=0 WHERE id=? AND owner_id=?")
                        .bind(existing).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e| e.to_string())?;
                } else {
                    sqlx::query("UPDATE daily_plan_items SET execution_date=?,time_zone=? WHERE id=? AND owner_id=?")
                        .bind(date).bind(time_zone).bind(&past[0].0).bind(&self.owner_id).execute(&mut **tx).await.map_err(|e| e.to_string())?;
                }
                sqlx::query("UPDATE daily_plan_items SET removed=1 WHERE owner_id=? AND task_id=? AND execution_date<? AND removed=0 AND is_summary=0")
                    .bind(&self.owner_id).bind(&id).bind(date).execute(&mut **tx).await.map_err(|e| e.to_string())?;
            }
            let next = if old_plan {
                Some(
                    serde_json::to_string(&advance(plan.as_ref().unwrap(), target, zone)?)
                        .map_err(|e| e.to_string())?,
                )
            } else {
                raw.clone()
            };
            sqlx::query(
                "UPDATE tasks SET plan_value=?,version=version+1 WHERE id=? AND owner_id=?",
            )
            .bind(&next)
            .bind(&id)
            .bind(&self.owner_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,'plan_updated',?,?)")
                .bind(Uuid::new_v4().to_string()).bind(&self.owner_id).bind(&id).bind(at)
                .bind(json!({"reason":"automatic_postponement","beforePlan":plan,"beforeArrangements":past,"date":date,"timeZone":time_zone,"afterPlan":next.as_deref().map(serde_json::from_str::<serde_json::Value>).transpose().map_err(|e| e.to_string())?}).to_string())
                .execute(&mut **tx).await.map_err(|e| e.to_string())?;
            changed += 1;
        }
        Ok(changed)
    }
}
