use super::planning::{replay, validate_operation};
use super::*;
use serde_json::{json, Value};
use sqlx::Row;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCommand {
    pub operation_id: String,
    pub occurred_at: String,
    pub action: ReviewAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReviewAction {
    Settings {
        stale_days: i64,
        expected_version: Option<i64>,
    },
    Save {
        id: String,
        expected_version: Option<i64>,
        start: String,
        end: String,
        achievements: String,
        blockers: String,
        stop_pause: String,
        next_focus: String,
        project_ids: Vec<String>,
    },
}

impl Store {
    pub async fn review_command(&self, c: &ReviewCommand) -> StoreResult<()> {
        validate_operation(&c.operation_id, &c.occurred_at)?;
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(&mut tx, &self.owner_id, &c.operation_id, "review", &payload).await? {
            return Ok(());
        }
        let entity = match &c.action {
            ReviewAction::Settings {
                stale_days,
                expected_version,
            } => {
                if !(1..=365).contains(stale_days) {
                    return Err("USER:未记录推进的检查天数应为 1–365".into());
                }
                let current: Option<i64> =
                    sqlx::query_scalar("SELECT version FROM review_settings WHERE owner_id=?")
                        .bind(&self.owner_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                if current != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("INSERT INTO review_settings(owner_id,stale_days) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET stale_days=excluded.stale_days,version=review_settings.version+1").bind(&self.owner_id).bind(stale_days).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                self.owner_id.clone()
            }
            ReviewAction::Save {
                id,
                expected_version,
                start,
                end,
                achievements,
                blockers,
                stop_pause,
                next_focus,
                project_ids,
            } => {
                Uuid::parse_str(id).map_err(|_| "USER:回顾标识无效")?;
                validate_date(start)?;
                validate_date(end)?;
                if start > end
                    || project_ids.len() > 100
                    || [achievements, blockers, stop_pause, next_focus]
                        .iter()
                        .any(|v| v.len() > 100_000)
                {
                    return Err("USER:回顾期间或内容无效".into());
                }
                let current:Option<(i64,String,String,String)>=sqlx::query_as("SELECT r.version,r.title,w.period_start,w.period_end FROM records r JOIN weekly_reviews w ON w.record_id=r.id WHERE r.id=? AND r.owner_id=? AND r.deleted_at IS NULL AND r.record_type='review'").bind(id).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                if current.as_ref().map(|r| r.0) != *expected_version {
                    return Err("STATE_CONFLICT".into());
                }
                let mut seen = std::collections::HashSet::new();
                for p in project_ids {
                    if !seen.insert(p) {
                        return Err("USER:关联项目重复".into());
                    }
                    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL)").bind(p).bind(&self.owner_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                    if !valid {
                        return Err("USER:关联项目已删除或不存在，请刷新".into());
                    }
                }
                // The mobile editor allows custom titles. Only an existing generated
                // title follows period changes; editing fields must keep custom text.
                let title = match &current {
                    Some((_, title, old_start, old_end))
                        if title != &format!("周回顾 {old_start} — {old_end}") => title.clone(),
                    _ => format!("周回顾 {start} — {end}"),
                };
                let body=format!("期间：{start} — {end}\n\n推进成果\n{achievements}\n\n阻塞\n{blockers}\n\n停止 / 暂停\n{stop_pause}\n\n下周重点\n{next_focus}");
                if current.is_some() {
                    sqlx::query("UPDATE weekly_reviews SET period_start=?,period_end=?,achievements=?,blockers=?,stop_pause=?,next_focus=? WHERE record_id=?").bind(start).bind(end).bind(achievements).bind(blockers).bind(stop_pause).bind(next_focus).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    sqlx::query("UPDATE records SET title=?,body=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=?").bind(&title).bind(&body).bind(&c.occurred_at).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                } else {
                    sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,created_at,updated_at) VALUES(?,?,?,?,'review',?,?)").bind(id).bind(&self.owner_id).bind(&title).bind(&body).bind(&c.occurred_at).bind(&c.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    sqlx::query("INSERT INTO weekly_reviews VALUES(?,?,?,?,?,?,?)")
                        .bind(id)
                        .bind(start)
                        .bind(end)
                        .bind(achievements)
                        .bind(blockers)
                        .bind(stop_pause)
                        .bind(next_focus)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                sqlx::query("DELETE FROM record_links WHERE record_id=? AND target_type='project'")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                for p in project_ids {
                    sqlx::query("INSERT INTO record_links VALUES(?,'project',?)")
                        .bind(id)
                        .bind(p)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                id.clone()
            }
        };
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(&c.operation_id)
            .bind(&self.owner_id)
            .bind(entity)
            .bind("review")
            .bind(&c.occurred_at)
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_operation(&mut tx, &c.operation_id, "review", &payload, &c.occurred_at)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn review_snapshot(&self, as_of: &str) -> StoreResult<Value> {
        let now = DateTime::parse_from_rfc3339(as_of).map_err(|_| "Invalid timestamp")?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let zone: Option<String> =
            sqlx::query_scalar("SELECT time_zone FROM workspace_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        let zone = zone.unwrap_or_else(|| "UTC".into());
        let tz: chrono_tz::Tz = zone.parse().map_err(|_| "Invalid timezone")?;
        let today = now.with_timezone(&tz).date_naive();
        let settings: Option<(i64, i64)> =
            sqlx::query_as("SELECT stale_days,version FROM review_settings WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        let stale_days = settings.map(|s| s.0).unwrap_or(7);
        let projects=sqlx::query("SELECT p.id,p.name,p.status,p.archived_at,p.created_at,c.review_date,c.next_action_task_id,(SELECT MAX(strftime('%Y-%m-%dT%H:%M:%fZ',at)) FROM (SELECT r.updated_at AS at FROM records r JOIN record_links l ON l.record_id=r.id WHERE l.target_type='project' AND l.target_id=p.id AND r.owner_id=p.owner_id AND r.record_type='progress' AND r.deleted_at IS NULL UNION ALL SELECT e.occurred_at AS at FROM content_events e WHERE e.entity_id=p.id AND e.owner_id=p.owner_id AND json_extract(e.payload,'$.action.type')='context' UNION ALL SELECT t.completed_at AS at FROM tasks t WHERE t.project_id=p.id AND t.owner_id=p.owner_id AND t.status='completed' AND t.deleted_at IS NULL)) AS last_progress FROM projects p LEFT JOIN project_context c ON c.project_id=p.id WHERE p.owner_id=? AND p.deleted_at IS NULL ORDER BY p.name,p.id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let tasks=sqlx::query("SELECT project_id,deadline_value FROM tasks WHERE owner_id=? AND deleted_at IS NULL AND status NOT IN('completed','cancelled') AND project_id IS NOT NULL AND deadline_value IS NOT NULL").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let mut overdue = std::collections::HashMap::<String, i64>::new();
        for t in tasks {
            let raw: String = t.get("deadline_value");
            let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let late = if value["kind"] == "date" {
                value["date"]
                    .as_str()
                    .is_some_and(|d| d < today.to_string().as_str())
            } else {
                value["atUtc"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|d| d < now)
            };
            if late {
                *overdue.entry(t.get("project_id")).or_default() += 1;
            }
        }
        let mut rows = Vec::new();
        let mut checks = Vec::new();
        for p in projects {
            let id: String = p.get("id");
            let name: String = p.get("name");
            let status: String = p.get("status");
            let archived: Option<String> = p.get("archived_at");
            rows.push(json!({"id":id,"name":name,"status":status,"archived":archived.is_some()}));
            if status != "active" || archived.is_some() {
                continue;
            }
            let next: Option<String> = p.get("next_action_task_id");
            let review: Option<String> = p.get("review_date");
            let last: Option<String> = p.get("last_progress");
            let created: String = p.get("created_at");
            let since = DateTime::parse_from_rfc3339(last.as_deref().unwrap_or(&created))
                .map_err(|e| e.to_string())?
                .with_timezone(&tz)
                .date_naive();
            let days = today.signed_duration_since(since).num_days().max(0);
            let mut reasons = Vec::new();
            if next.is_none() {
                reasons.push("活跃项目未指定下一步".to_string());
            }
            if review.as_ref().is_some_and(|d| d <= &today.to_string()) {
                reasons.push("复查日期已到".into());
            }
            let count = *overdue.get(&id).unwrap_or(&0);
            if count > 0 {
                reasons.push(format!("有 {count} 项任务超过真实期限"));
            }
            if days >= stale_days {
                reasons.push(format!("已 {days} 天未记录推进"));
            }
            if !reasons.is_empty() {
                checks.push(json!({"id":id,"name":name,"reasons":reasons,"lastProgressAt":last,"daysWithoutRecordedProgress":days,"overdueCount":count}));
            }
        }
        let reviews:Vec<String>=sqlx::query_scalar("SELECT json_object('id',r.id,'version',r.version,'start',w.period_start,'end',w.period_end,'achievements',w.achievements,'blockers',w.blockers,'stopPause',w.stop_pause,'nextFocus',w.next_focus,'updatedAt',r.updated_at,'projectIds',json((SELECT json_group_array(target_id) FROM record_links WHERE record_id=r.id AND target_type='project'))) FROM weekly_reviews w JOIN records r ON r.id=w.record_id WHERE r.owner_id=? AND r.deleted_at IS NULL AND r.record_type='review' ORDER BY w.period_start DESC,r.id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let reviews = reviews
            .iter()
            .map(|v| serde_json::from_str::<Value>(v).map_err(|e| e.to_string()))
            .collect::<StoreResult<Vec<_>>>()?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(
            json!({"today":today.to_string(),"timeZone":zone,"settings":{"staleDays":stale_days,"version":settings.map(|s|s.1)},"projects":rows,"checks":checks,"reviews":reviews}),
        )
    }
}
