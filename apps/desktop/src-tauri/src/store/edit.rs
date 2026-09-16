use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditTaskCommand {
    pub operation_id: String,
    pub task_id: String,
    pub plan_id: String,
    pub expected_version: i64,
    pub title: String,
    pub execution_date: String,
    pub time_zone: String,
    pub occurred_at: String,
    pub undo_of: Option<String>,
}
impl Store {
    pub async fn edit_task(&self, command: &EditTaskCommand) -> StoreResult<DailyTask> {
        for id in [&command.operation_id, &command.task_id, &command.plan_id] {
            Uuid::parse_str(id).map_err(|_| "Invalid identifier")?;
        }
        validate_date(&command.execution_date)?;
        command
            .time_zone
            .parse::<Tz>()
            .map_err(|_| "Invalid time zone")?;
        DateTime::parse_from_rfc3339(&command.occurred_at)
            .map_err(|_| "Invalid event timestamp")?;
        if command.title.trim().is_empty() || command.expected_version < 0 {
            return Err("Invalid task edit".into());
        }
        let payload = serde_json::to_string(command).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let prior: Option<(String, String)> = sqlx::query_as(
            "SELECT payload,kind FROM sync_outbox WHERE operation_id=? AND owner_id=?",
        )
        .bind(&command.operation_id)
        .bind(&self.owner_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((original, kind)) = prior {
            if original != payload || kind != "edit_task" {
                return Err("Operation reused with different content".into());
            }
        } else {
            let current = sqlx::query_as::<_, DailyTask>(&format!(
                "{TASK_PROJECTION} WHERE p.id=? AND t.id=? AND p.owner_id=?"
            ))
            .bind(&command.plan_id)
            .bind(&command.task_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if current.version != command.expected_version {
                return Err("STATE_CONFLICT".into());
            }
            if current.status == "completed" && current.execution_date != command.execution_date {
                return Err("COMPLETED_PLAN".into());
            }

            let before_zone: String = sqlx::query_scalar(
                "SELECT time_zone FROM daily_plan_items WHERE id=? AND owner_id=?",
            )
            .bind(&command.plan_id)
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            let mut target_zone = if current.execution_date == command.execution_date {
                before_zone.clone()
            } else {
                command.time_zone.clone()
            };
            if let Some(original_id) = &command.undo_of {
                let event:Option<String>=sqlx::query_scalar("SELECT payload FROM domain_events WHERE id=? AND owner_id=? AND task_id=? AND kind='task_edited'")
     .bind(original_id).bind(&self.owner_id).bind(&command.task_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                let original: serde_json::Value =
                    serde_json::from_str(&event.ok_or("STATE_CONFLICT")?)
                        .map_err(|e| e.to_string())?;
                target_zone = original["beforeTimeZone"]
                    .as_str()
                    .ok_or("STATE_CONFLICT")?
                    .to_owned();
                if original["afterVersion"].as_i64() != Some(command.expected_version)
                    || original["before"]["title"].as_str() != Some(command.title.trim())
                    || original["before"]["executionDate"].as_str()
                        != Some(command.execution_date.as_str())
                    || original["before"]["planId"].as_str() != Some(command.plan_id.as_str())
                {
                    return Err("STATE_CONFLICT".into());
                }
            }

            let collision:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM daily_plan_items WHERE owner_id=? AND task_id=? AND execution_date=? AND id<>?)")
             .bind(&self.owner_id).bind(&command.task_id).bind(&command.execution_date).bind(&command.plan_id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if collision {
                return Err("PLAN_CONFLICT".into());
            }
            // Same stable plan ID; the natural unique constraint rejects a conflicting target day atomically.
            sqlx::query("UPDATE daily_plan_items SET execution_date=?,time_zone=? WHERE id=? AND owner_id=?")
    .bind(&command.execution_date).bind(&target_zone).bind(&command.plan_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("UPDATE tasks SET title=?,version=version+1 WHERE id=? AND owner_id=?")
                .bind(command.title.trim())
                .bind(&command.task_id)
                .bind(&self.owner_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            let history=serde_json::json!({"before":current,"beforeTimeZone":before_zone,"afterVersion":current.version+1,"command":command}).to_string();
            sqlx::query("INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES(?,?,?,?,?,?)")
    .bind(&command.operation_id).bind(&self.owner_id).bind(&command.task_id).bind(if command.undo_of.is_some() {"task_edit_undone"} else {"task_edited"})
    .bind(&command.occurred_at).bind(history).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO sync_outbox(operation_id,owner_id,device_id,protocol_version,kind,payload,created_at) VALUES(?,?,?,1,'edit_task',?,?)")
    .bind(&command.operation_id).bind(&self.owner_id).bind(&self.device_id).bind(payload).bind(&command.occurred_at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        }
        let result = sqlx::query_as::<_, DailyTask>(&format!(
            "{TASK_PROJECTION} WHERE p.id=? AND p.owner_id=?"
        ))
        .bind(&command.plan_id)
        .bind(&self.owner_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
}
