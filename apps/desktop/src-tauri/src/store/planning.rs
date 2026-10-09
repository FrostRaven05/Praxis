use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanChange {
    pub task_id: String,
    pub plan_id: String,
    pub expected_version: i64,
    pub is_focus: bool,
    pub estimated_minutes: Option<i64>,
    pub focus_rank: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_period: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_rank: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanCommand {
    pub operation_id: String,
    pub date: String,
    pub occurred_at: String,
    pub changes: Vec<PlanChange>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityCommand {
    pub operation_id: String,
    pub date: String,
    pub occurred_at: String,
    pub expected_version: i64,
    pub minutes: Option<i64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayLoad {
    pub capacity_minutes: Option<i64>,
    pub capacity_version: i64,
    pub estimated_minutes: i64,
    pub unknown_count: i64,
}
pub(super) fn validate_operation(id: &str, at: &str) -> StoreResult<()> {
    Uuid::parse_str(id).map_err(|_| "Invalid operation identifier")?;
    DateTime::parse_from_rfc3339(at).map_err(|_| "Invalid timestamp")?;
    Ok(())
}
pub(super) async fn replay(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
    id: &str,
    kind: &str,
    payload: &str,
) -> StoreResult<bool> {
    let old: Option<(String, String)> =
        sqlx::query_as("SELECT kind,payload FROM sync_outbox WHERE owner_id=? AND operation_id=?")
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    match old {
        Some((k, p)) if k == kind && p == payload => Ok(true),
        Some(_) => Err("Operation reused with different content".into()),
        None => Ok(false),
    }
}
impl Store {
    pub(super) async fn queue_operation(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        id: &str,
        kind: &str,
        payload: &str,
        at: &str,
    ) -> StoreResult<()> {
        sqlx::query("INSERT INTO sync_outbox(operation_id,owner_id,device_id,protocol_version,kind,payload,created_at) VALUES(?,?,?,1,?,?,?)")
 .bind(id).bind(&self.owner_id).bind(&self.device_id).bind(kind).bind(payload).bind(at).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        Ok(())
    }
    pub async fn update_plan(&self, command: &PlanCommand) -> StoreResult<()> {
        validate_operation(&command.operation_id, &command.occurred_at)?;
        validate_date(&command.date)?;
        if command.changes.is_empty() {
            return Err("Invalid plan changes".into());
        }
        let mut seen = std::collections::HashSet::new();
        for c in &command.changes {
            if !seen.insert(&c.plan_id)
                || c.expected_version < 0
                || c.focus_rank < 0
                || c.day_rank.is_some_and(|rank| rank < 0)
                || c.day_period.as_ref().is_some_and(|period| !["morning", "afternoon", "evening"].contains(&period.as_str()))
                || c.estimated_minutes
                    .is_some_and(|m| !(1..=1440).contains(&m))
            {
                return Err("Invalid plan values".into());
            }
        }
        let payload = serde_json::to_string(command).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &command.operation_id,
            "update_plan",
            &payload,
        )
        .await?
        {
            for c in &command.changes {
                let before = sqlx::query_as::<_, DailyTask>(&format!(
                    "{TASK_PROJECTION} WHERE p.is_summary=0 AND p.removed=0 AND p.id=? AND t.id=? AND p.owner_id=?"
                ))
                .bind(&c.plan_id)
                .bind(&c.task_id)
                .bind(&self.owner_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if before.version != c.expected_version
                    || before.execution_date != command.date
                    || !["todo", "in_progress", "blocked"].contains(&before.status.as_str())
                {
                    return Err("STATE_CONFLICT".into());
                }
                sqlx::query("UPDATE daily_plan_items SET is_focus=?,estimated_minutes=?,focus_rank=?,day_period=COALESCE(?,day_period),day_rank=COALESCE(?,day_rank) WHERE id=? AND owner_id=?")
    .bind(c.is_focus).bind(c.estimated_minutes).bind(c.focus_rank).bind(&c.day_period).bind(c.day_rank).bind(&c.plan_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE tasks SET version=version+1 WHERE id=? AND owner_id=?")
                    .bind(&c.task_id)
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                let event=serde_json::json!({"operationId":command.operation_id,"before":before,"after":c}).to_string();
                sqlx::query("INSERT INTO domain_events VALUES(?,?,?,'plan_updated',?,?)")
                    .bind(Uuid::new_v4().to_string())
                    .bind(&self.owner_id)
                    .bind(&c.task_id)
                    .bind(&command.occurred_at)
                    .bind(event)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            self.queue_operation(
                &mut tx,
                &command.operation_id,
                "update_plan",
                &payload,
                &command.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    pub async fn day_load(&self, date: &str) -> StoreResult<DayLoad> {
        validate_date(date)?;
        let capacity: Option<(Option<i64>, i64)> = sqlx::query_as(
            "SELECT minutes,version FROM day_preferences WHERE owner_id=? AND date=?",
        )
        .bind(&self.owner_id)
        .bind(date)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let (estimated,unknown):(i64,i64)=sqlx::query_as("SELECT COALESCE(SUM(p.estimated_minutes),0),COALESCE(SUM(CASE WHEN p.estimated_minutes IS NULL THEN 1 ELSE 0 END),0) FROM daily_plan_items p JOIN tasks t ON t.id=p.task_id AND t.owner_id=p.owner_id WHERE p.owner_id=? AND p.is_summary=0 AND p.removed=0 AND p.execution_date=? AND t.deleted_at IS NULL AND t.status<>'cancelled'")
 .bind(&self.owner_id).bind(date).fetch_one(&self.pool).await.map_err(|e|e.to_string())?;
        let (minutes, version) = capacity.unwrap_or((None, 0));
        Ok(DayLoad {
            capacity_minutes: minutes,
            capacity_version: version,
            estimated_minutes: estimated,
            unknown_count: unknown,
        })
    }
    pub async fn set_capacity(&self, command: &CapacityCommand) -> StoreResult<()> {
        validate_operation(&command.operation_id, &command.occurred_at)?;
        validate_date(&command.date)?;
        if command.expected_version < 0 || command.minutes.is_some_and(|m| !(0..=1440).contains(&m))
        {
            return Err("Invalid capacity".into());
        }
        let payload = serde_json::to_string(command).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if !replay(
            &mut tx,
            &self.owner_id,
            &command.operation_id,
            "set_capacity",
            &payload,
        )
        .await?
        {
            let before: Option<(Option<i64>, i64)> = sqlx::query_as(
                "SELECT minutes,version FROM day_preferences WHERE owner_id=? AND date=?",
            )
            .bind(&self.owner_id)
            .bind(&command.date)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if before.unwrap_or((None, 0)).1 != command.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            sqlx::query("INSERT INTO day_preferences(owner_id,date,minutes,version) VALUES(?,?,?,?) ON CONFLICT(owner_id,date) DO UPDATE SET minutes=excluded.minutes,version=excluded.version")
 .bind(&self.owner_id).bind(&command.date).bind(command.minutes).bind(command.expected_version+1).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO day_events VALUES(?,?,?,'capacity_changed',?,?)")
                .bind(&command.operation_id)
                .bind(&self.owner_id)
                .bind(&command.date)
                .bind(&command.occurred_at)
                .bind(serde_json::json!({"before":before,"command":command}).to_string())
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            self.queue_operation(
                &mut tx,
                &command.operation_id,
                "set_capacity",
                &payload,
                &command.occurred_at,
            )
            .await?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
