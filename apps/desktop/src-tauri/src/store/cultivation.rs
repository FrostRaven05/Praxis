use super::planning::replay;
use super::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CultivationCommand {
    pub operation_id: String,
    pub expected_version: i64,
    pub action: String,
    #[serde(default)]
    pub milestone: String,
    #[serde(default)]
    pub reward: String,
    pub target: Option<i64>,
    pub achievement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reward_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_application_id: Option<String>,
}
#[derive(FromRow)]
struct TaskRow {
    id: String,
    parent_task_id: Option<String>,
    status: String,
    deleted_at: Option<String>,
    title: String,
    project_name: Option<String>,
}
struct Package {
    title: String,
    project_name: Option<String>,
    completed: bool,
}
#[derive(FromRow)]
struct Goal {
    version: i64,
    breakthroughs: i64,
    baseline: i64,
    target: i64,
    milestone: String,
    reward: String,
    achieved_at: Option<String>,
    claimed_at: Option<String>,
    goal_id: Option<String>,
    source_application_id: Option<String>,
    rules_version: i64,
}
#[derive(FromRow)]
struct Agreement {
    id: String,
    milestone: String,
    reward: String,
    status: String,
    binding_mode: String,
    task_ids: String,
    source_application_id: Option<String>,
    created_at: String,
    unlocked_at: Option<String>,
    claimed_at: Option<String>,
}
async fn packages(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
) -> StoreResult<HashMap<String, Package>> {
    let rows: Vec<TaskRow> = sqlx::query_as("SELECT t.id,t.parent_task_id,t.status,t.deleted_at,t.title,p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id AND p.owner_id=t.owner_id WHERE t.owner_id=?")
        .bind(owner).fetch_all(&mut **tx).await.map_err(|e| e.to_string())?;
    let by_id: HashMap<_, _> = rows.iter().map(|r| (&r.id, r)).collect();
    let parents: HashSet<_> = rows
        .iter()
        .filter(|r| r.deleted_at.is_none())
        .filter_map(|r| r.parent_task_id.as_ref())
        .collect();
    let mut result: HashMap<String, Package> = HashMap::new();
    for row in &rows {
        if row.deleted_at.is_some() || parents.contains(&row.id) {
            continue;
        }
        let mut root = row;
        let mut seen = HashSet::new();
        while let Some(parent) = root
            .parent_task_id
            .as_ref()
            .and_then(|id| by_id.get(id))
            .copied()
        {
            if !seen.insert(&parent.id) {
                return Err("任务层级异常，无法读取修炼进展。".into());
            }
            root = parent;
        }
        if root.deleted_at.is_some() || root.parent_task_id.is_some() || root.status == "cancelled"
        {
            continue;
        }
        let package = result.entry(root.id.clone()).or_insert_with(|| Package {
            title: root.title.clone(),
            project_name: root.project_name.clone(),
            completed: true,
        });
        package.completed &= row.status == "completed";
    }
    // A live action moved under another root no longer counts as an independent package.
    // Deleted/archived completed tasks retain their previously earned global experience.
    sqlx::query("UPDATE cultivation_credits SET active=0 WHERE owner_id=? AND task_id IN (SELECT id FROM tasks WHERE owner_id=? AND deleted_at IS NULL AND (parent_task_id IS NOT NULL OR status='cancelled'))")
        .bind(owner).bind(owner).execute(&mut **tx).await.map_err(|e|e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    for (id, package) in &result {
        if package.completed {
            sqlx::query("INSERT INTO cultivation_credits(owner_id,task_id,awarded_at,active) VALUES(?,?,?,1) ON CONFLICT(owner_id,task_id) DO UPDATE SET active=1")
                .bind(owner).bind(id).bind(&now).execute(&mut **tx).await.map_err(|e| e.to_string())?;
        } else {
            sqlx::query("UPDATE cultivation_credits SET active=0 WHERE owner_id=? AND task_id=?")
                .bind(owner)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}
async fn credit_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
) -> StoreResult<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM cultivation_credits WHERE owner_id=? AND active=1")
        .bind(owner)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())
}
async fn goal(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, owner: &str) -> StoreResult<Goal> {
    sqlx::query("INSERT OR IGNORE INTO cultivation_state(owner_id) VALUES(?)")
        .bind(owner)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let mut state: Goal = sqlx::query_as("SELECT version,breakthroughs,baseline,target,milestone,reward,achieved_at,claimed_at,goal_id,source_application_id,rules_version FROM cultivation_state WHERE owner_id=?")
        .bind(owner).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
    if state.goal_id.is_none() && !state.milestone.is_empty() {
        let previous: Option<(String, Option<String>)> = if let Some(at) = &state.achieved_at {
            sqlx::query_as("SELECT id,claimed_at FROM cultivation_achievements WHERE owner_id=? AND created_at=? AND milestone=? AND reward=? ORDER BY rowid DESC LIMIT 1")
                .bind(owner).bind(at).bind(&state.milestone).bind(&state.reward).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())?
        } else {
            None
        };
        let id = previous
            .as_ref()
            .map(|r| r.0.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let claimed = previous.and_then(|r| r.1).or(state.claimed_at.clone());
        let status = if claimed.is_some() {
            "claimed"
        } else if state.achieved_at.is_some() {
            "available"
        } else {
            "locked"
        };
        let at = state
            .achieved_at
            .clone()
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        sqlx::query("INSERT OR IGNORE INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,created_at,unlocked_at,claimed_at) VALUES(?,?,?,?,?,'all',?,?,?)")
            .bind(&id).bind(owner).bind(&state.milestone).bind(&state.reward).bind(status).bind(&at).bind(&state.achieved_at).bind(&claimed).execute(&mut **tx).await.map_err(|e|e.to_string())?;
        sqlx::query("UPDATE cultivation_state SET goal_id=?,claimed_at=? WHERE owner_id=?")
            .bind(&id)
            .bind(&claimed)
            .bind(owner)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        state.goal_id = Some(id);
        state.claimed_at = claimed;
    }
    Ok(state)
}
async fn consumed(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
) -> StoreResult<HashSet<String>> {
    let ids: Vec<String> =
        sqlx::query_scalar("WITH RECURSIVE used(id) AS (SELECT task_id FROM cultivation_achievement_tasks WHERE owner_id=? UNION SELECT t.parent_task_id FROM tasks t JOIN used u ON t.id=u.id WHERE t.owner_id=? AND t.parent_task_id IS NOT NULL) SELECT id FROM used")
            .bind(owner).bind(owner)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    Ok(ids.into_iter().collect())
}
async fn bound_tasks(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
) -> StoreResult<Vec<String>> {
    sqlx::query_scalar(
        "SELECT task_id FROM cultivation_goal_tasks WHERE owner_id=? ORDER BY task_id",
    )
    .bind(owner)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())
}
async fn global_candidates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &str,
    legacy: bool,
) -> StoreResult<Vec<String>> {
    let sql = if legacy {
        "SELECT c.task_id FROM cultivation_credits c WHERE c.owner_id=? AND c.active=1 AND NOT EXISTS(SELECT 1 FROM cultivation_achievement_tasks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id) ORDER BY c.awarded_at DESC,c.task_id"
    } else {
        "SELECT c.task_id FROM cultivation_credits c WHERE c.owner_id=? AND c.active=1 AND NOT EXISTS(SELECT 1 FROM cultivation_goal_baseline_tasks b WHERE b.owner_id=c.owner_id AND b.task_id=c.task_id) AND NOT EXISTS(SELECT 1 FROM cultivation_achievement_tasks a WHERE a.owner_id=c.owner_id AND a.task_id=c.task_id) ORDER BY c.awarded_at,c.task_id"
    };
    let ids: Vec<String> = sqlx::query_scalar(sql)
        .bind(owner)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let used = consumed(tx, owner).await?;
    Ok(ids.into_iter().filter(|id| !used.contains(id)).collect())
}
fn task_progress(
    ids: &[String],
    available: &HashMap<String, Package>,
    used: &HashSet<String>,
) -> Vec<Value> {
    ids.iter().map(|id| { let p=available.get(id); json!({"id":id,"title":p.map(|p|p.title.as_str()).unwrap_or("关联行动已删除、取消或移入其他行动包"),"completed":p.is_some_and(|p|p.completed),"unavailable":p.is_none(),"consumed":used.contains(id)}) }).collect()
}
impl Store {
    pub async fn cultivation_snapshot(&self) -> StoreResult<Value> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let available = packages(&mut tx, &self.owner_id).await?;
        let count = credit_count(&mut tx, &self.owner_id).await?;
        let state = goal(&mut tx, &self.owner_id).await?;
        let used = consumed(&mut tx, &self.owner_id).await?;
        let ids = bound_tasks(&mut tx, &self.owner_id).await?;
        let mode = if ids.is_empty() { "all" } else { "tasks" };
        let progress = if state.achieved_at.is_some() {
            state.target
        } else if !ids.is_empty() {
            ids.iter()
                .filter(|id| available.get(*id).is_some_and(|p| p.completed) && !used.contains(*id))
                .count() as i64
        } else if state.rules_version < 2 {
            (count - state.baseline).max(0)
        } else {
            global_candidates(&mut tx, &self.owner_id, false)
                .await?
                .len() as i64
        };
        let history:Vec<(String,String,String,String,Option<String>)>=sqlx::query_as("SELECT id,milestone,reward,created_at,claimed_at FROM cultivation_achievements WHERE owner_id=? ORDER BY created_at DESC LIMIT 20").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let agreements:Vec<Agreement>=sqlx::query_as("SELECT id,milestone,reward,status,binding_mode,task_ids,source_application_id,created_at,unlocked_at,claimed_at FROM cultivation_reward_agreements WHERE owner_id=? ORDER BY created_at DESC,id").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        let reward_status = agreements
            .iter()
            .find(|a| Some(&a.id) == state.goal_id.as_ref() && !a.reward.is_empty())
            .map(|a| a.status.clone());
        let mut candidates:Vec<_>=available.iter().map(|(id,p)|json!({"id":id,"title":p.title,"projectName":p.project_name,"completed":p.completed,"consumed":used.contains(id)})).collect();
        candidates.sort_by(|a, b| {
            a["title"]
                .as_str()
                .cmp(&b["title"].as_str())
                .then(a["id"].as_str().cmp(&b["id"].as_str()))
        });
        let realms = ["炼气", "筑基", "结丹", "元婴", "化神"];
        let result = json!({"version":state.version,"breakthroughs":state.breakthroughs,"realm":realms[(state.breakthroughs as usize).min(realms.len()-1)],"experience":count*10,"completedPackages":count,
            "goal":{"id":state.goal_id,"target":state.target,"milestone":state.milestone,"reward":state.reward,"progress":progress,"achievedAt":state.achieved_at,"claimedAt":state.claimed_at,"bindingMode":mode,"taskIds":ids,"sourceApplicationId":state.source_application_id,"rewardStatus":reward_status,"taskProgress":task_progress(&ids,&available,&used)},
            "availableTasks":candidates,
            "rewardAgreements":agreements.into_iter().map(|a|json!({"id":a.id,"milestone":a.milestone,"reward":a.reward,"status":a.status,"bindingMode":a.binding_mode,"taskIds":serde_json::from_str::<Vec<String>>(&a.task_ids).unwrap_or_default(),"createdAt":a.created_at,"unlockedAt":a.unlocked_at,"claimedAt":a.claimed_at,"sourceApplicationId":a.source_application_id})).collect::<Vec<_>>(),
            "achievements":history.into_iter().map(|h|json!({"id":h.0,"milestone":h.1,"reward":h.2,"achievedAt":h.3,"claimedAt":h.4})).collect::<Vec<_>>()});
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub async fn cultivation_command(&self, c: &CultivationCommand) -> StoreResult<()> {
        if Uuid::parse_str(&c.operation_id).is_err()
            || c.expected_version < 0
            || c.milestone.chars().count() > 500
            || c.reward.chars().count() > 200
            || c.task_ids.len() > 100
            || c.task_ids.iter().any(|id| Uuid::parse_str(id).is_err())
            || c.task_ids.iter().collect::<HashSet<_>>().len() != c.task_ids.len()
            || c.reward_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
            || c.source_application_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
        {
            return Err("修炼设置无效。".into());
        }
        let payload = serde_json::to_string(c).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        if replay(
            &mut tx,
            &self.owner_id,
            &c.operation_id,
            "cultivation",
            &payload,
        )
        .await?
        {
            return Ok(());
        }
        let available = packages(&mut tx, &self.owner_id).await?;
        let count = credit_count(&mut tx, &self.owner_id).await?;
        let state = goal(&mut tx, &self.owner_id).await?;
        if state.version != c.expected_version {
            return Err("修炼目标已变化，请刷新后再操作。".into());
        }
        let at = chrono::Utc::now().to_rfc3339();
        if let Some(application) = &c.source_application_id {
            let raw: Option<String> = sqlx::query_scalar(
                "SELECT receipt_json FROM ai_applications WHERE owner_id=? AND operation_id=?",
            )
            .bind(&self.owner_id)
            .bind(application)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            let valid = raw
                .and_then(|s| serde_json::from_str::<AiApplyReceipt>(&s).ok())
                .is_some_and(|r| !r.undone);
            if !valid {
                return Err("规划来源已变化，请重新选择修炼内容。".into());
            }
        }
        match c.action.as_str() {
            "save_wish" => {
                if c.reward.trim().is_empty() || !c.task_ids.is_empty() || c.reward_id.is_some() {
                    return Err("请填写想要的奖励，心愿设置无效。".into());
                }
                sqlx::query("INSERT INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,created_at,source_application_id) VALUES(?,?,?,?,'wish','wish',?,?)")
                    .bind(&c.operation_id).bind(&self.owner_id).bind(c.milestone.trim()).bind(c.reward.trim()).bind(&at).bind(&c.source_application_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE cultivation_state SET version=version+1 WHERE owner_id=?")
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "set_goal" => {
                let target = c.target.ok_or("请设置行动数量。")?;
                if c.milestone.trim().is_empty()
                    || !(1..=100).contains(&target)
                    || (!c.task_ids.is_empty() && target != c.task_ids.len() as i64)
                {
                    return Err("请填写阶段成果和有效行动数量。".into());
                }
                let used = consumed(&mut tx, &self.owner_id).await?;
                if c.task_ids
                    .iter()
                    .any(|id| !available.contains_key(id) || used.contains(id))
                {
                    return Err("关联行动包已变化或已用于突破，请重新选择独立行动包。".into());
                }
                let id = c
                    .reward_id
                    .clone()
                    .unwrap_or_else(|| c.operation_id.clone());
                let mut source = c.source_application_id.clone();
                if let Some(existing) = &c.reward_id {
                    let row:Option<(String,Option<String>)>=sqlx::query_as("SELECT status,source_application_id FROM cultivation_reward_agreements WHERE id=? AND owner_id=?").bind(existing).bind(&self.owner_id).fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
                    let (status, previous_source) =
                        row.ok_or("所选心愿已变化，请刷新后再操作。")?;
                    if !["wish", "paused"].contains(&status.as_str())
                        && !(status == "locked" && state.goal_id.as_ref() == Some(existing))
                    {
                        return Err("奖励已经解锁或领取，请设置新的心愿。".into());
                    }
                    if source.is_none() {
                        source = previous_source;
                    }
                }
                if let Some(old) = &state.goal_id {
                    if old != &id {
                        sqlx::query("UPDATE cultivation_reward_agreements SET status='paused' WHERE id=? AND owner_id=? AND status='locked'").bind(old).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                    }
                }
                let ids = serde_json::to_string(&c.task_ids).map_err(|e| e.to_string())?;
                let mode = if c.task_ids.is_empty() {
                    "all"
                } else {
                    "tasks"
                };
                if c.reward_id.is_some() {
                    sqlx::query("UPDATE cultivation_reward_agreements SET milestone=?,reward=?,status='locked',binding_mode=?,task_ids=?,source_application_id=?,unlocked_at=NULL,claimed_at=NULL WHERE id=? AND owner_id=?").bind(c.milestone.trim()).bind(c.reward.trim()).bind(mode).bind(&ids).bind(&source).bind(&id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                } else {
                    sqlx::query("INSERT INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,task_ids,source_application_id,created_at) VALUES(?,?,?,?,'locked',?,?,?,?)").bind(&id).bind(&self.owner_id).bind(c.milestone.trim()).bind(c.reward.trim()).bind(mode).bind(&ids).bind(&source).bind(&at).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                sqlx::query("DELETE FROM cultivation_goal_tasks WHERE owner_id=?")
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("DELETE FROM cultivation_goal_baseline_tasks WHERE owner_id=?")
                    .bind(&self.owner_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                for task in &c.task_ids {
                    sqlx::query("INSERT INTO cultivation_goal_tasks(owner_id,task_id) VALUES(?,?)")
                        .bind(&self.owner_id)
                        .bind(task)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                sqlx::query("INSERT INTO cultivation_goal_baseline_tasks(owner_id,task_id) SELECT owner_id,task_id FROM cultivation_credits WHERE owner_id=?").bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE cultivation_state SET milestone=?,reward=?,target=?,baseline=?,goal_id=?,source_application_id=?,rules_version=2,achieved_at=NULL,claimed_at=NULL,version=version+1 WHERE owner_id=?")
                    .bind(c.milestone.trim()).bind(c.reward.trim()).bind(target).bind(count).bind(&id).bind(&source).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            "breakthrough" => {
                if state.achieved_at.is_some() || state.milestone.is_empty() {
                    return Err("尚未设置阶段成果，或已经突破。".into());
                }
                let ids = bound_tasks(&mut tx, &self.owner_id).await?;
                let used = consumed(&mut tx, &self.owner_id).await?;
                let mut eligible = if ids.is_empty() {
                    global_candidates(&mut tx, &self.owner_id, state.rules_version < 2).await?
                } else {
                    ids.iter()
                        .filter(|id| {
                            available.get(*id).is_some_and(|p| p.completed) && !used.contains(*id)
                        })
                        .cloned()
                        .collect::<Vec<_>>()
                };
                let progress = if state.rules_version < 2 && ids.is_empty() {
                    (count - state.baseline).max(0)
                } else {
                    eligible.len() as i64
                };
                if progress < state.target || eligible.len() < state.target as usize {
                    return Err("尚未满足本次行动积累，关联行动也可能已变化。".into());
                }
                eligible.truncate(state.target as usize);
                sqlx::query("INSERT INTO cultivation_achievements(id,owner_id,milestone,reward,created_at,reward_id) VALUES(?,?,?,?,?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(&state.milestone).bind(&state.reward).bind(&at).bind(&state.goal_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                // Freeze every member identity, so later splitting or wrapping the same work
                // cannot make its subtasks eligible for a second stage.
                let selected = serde_json::to_string(&eligible).map_err(|e| e.to_string())?;
                let members:Vec<String>=sqlx::query_scalar("WITH RECURSIVE members(id) AS (SELECT value FROM json_each(?) UNION SELECT t.id FROM tasks t JOIN members m ON t.parent_task_id=m.id WHERE t.owner_id=?) SELECT id FROM members")
                    .bind(&selected).bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
                for task in &members {
                    sqlx::query("INSERT INTO cultivation_achievement_tasks(achievement_id,owner_id,task_id) VALUES(?,?,?)").bind(&c.operation_id).bind(&self.owner_id).bind(task).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                }
                sqlx::query("UPDATE cultivation_reward_agreements SET status='available',unlocked_at=? WHERE id=? AND owner_id=? AND status='locked'").bind(&at).bind(&state.goal_id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE cultivation_state SET breakthroughs=breakthroughs+1,achieved_at=?,version=version+1 WHERE owner_id=?").bind(&at).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            "claim" => {
                let id = if let Some(id) = &c.reward_id {
                    id.clone()
                } else {
                    let achievement = c.achievement_id.as_ref().ok_or("请选择奖励。")?;
                    sqlx::query_scalar::<_, Option<String>>(
                        "SELECT reward_id FROM cultivation_achievements WHERE id=? AND owner_id=?",
                    )
                    .bind(achievement)
                    .bind(&self.owner_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .ok_or("奖励不存在。")?
                };
                let changed=sqlx::query("UPDATE cultivation_reward_agreements SET status='claimed',claimed_at=? WHERE id=? AND owner_id=? AND status='available' AND reward<>''").bind(&at).bind(&id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
                if changed != 1 {
                    return Err("奖励尚未解锁、已领取或不存在。".into());
                }
                sqlx::query("UPDATE cultivation_achievements SET claimed_at=? WHERE reward_id=? AND owner_id=?").bind(&at).bind(&id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("UPDATE cultivation_state SET claimed_at=CASE WHEN goal_id=? THEN ? ELSE claimed_at END,version=version+1 WHERE owner_id=?").bind(&id).bind(&at).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            _ => return Err("不支持的修炼操作。".into()),
        }
        self.queue_operation(&mut tx, &c.operation_id, "cultivation", &payload, &at)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn splitting_a_completed_package_does_not_multiply_experience() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let project = Uuid::new_v4().to_string();
        let root = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,'项目','成果',1,0,'2026-10-25T00:00:00Z')").bind(&project).bind(&s.owner_id).execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO tasks(id,owner_id,project_id,title,status,source,created_at) VALUES(?,?,?,'行动包','completed','temporary','2026-10-25T00:00:00Z')").bind(&root).bind(&s.owner_id).bind(&project).execute(&s.pool).await.unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 10);
        sqlx::query("UPDATE tasks SET status='todo' WHERE id=?")
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        for _ in 0..3 {
            sqlx::query("INSERT INTO tasks(id,owner_id,project_id,parent_task_id,title,status,source,created_at) VALUES(?,?,?,?,'子步骤','completed','temporary','2026-10-25T00:00:00Z')").bind(Uuid::new_v4().to_string()).bind(&s.owner_id).bind(&project).bind(&root).execute(&s.pool).await.unwrap();
        }
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 10);
    }
    #[tokio::test]
    async fn work_packages_conserve_credit_and_breakthrough_needs_accumulation() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let owner = &s.owner_id;
        let root = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES(?,?,'行动包','todo','temporary','2026-10-25T00:00:00Z')").bind(&root).bind(owner).execute(&s.pool).await.unwrap();
        // Independent source tasks have no project; nesting is tested through a project to satisfy native invariants.
        sqlx::query("UPDATE tasks SET status='completed' WHERE id=?")
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 10);
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 10);
        let goal = CultivationCommand {
            operation_id: Uuid::new_v4().to_string(),
            expected_version: 0,
            action: "set_goal".into(),
            milestone: "第一组作品".into(),
            reward: "出游".into(),
            target: Some(1),
            achievement_id: None,
            ..Default::default()
        };
        s.cultivation_command(&goal).await.unwrap();
        let breakthrough = CultivationCommand {
            operation_id: Uuid::new_v4().to_string(),
            expected_version: 1,
            action: "breakthrough".into(),
            milestone: "".into(),
            reward: "".into(),
            target: None,
            achievement_id: None,
            ..Default::default()
        };
        assert!(s.cultivation_command(&breakthrough).await.is_err());
        let second = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES(?,?,'第二个行动','completed','temporary','2026-10-25T00:00:00Z')").bind(&second).bind(owner).execute(&s.pool).await.unwrap();
        s.cultivation_command(&breakthrough).await.unwrap();
        s.cultivation_command(&breakthrough).await.unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["breakthroughs"], 1);
        sqlx::query(
            "UPDATE tasks SET deleted_at='2026-10-26T00:00:00Z',status='cancelled' WHERE id=?",
        )
        .bind(&second)
        .execute(&s.pool)
        .await
        .unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 20);
        sqlx::query("UPDATE tasks SET status='todo' WHERE id=?")
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 10);
    }

    async fn add_task(s: &Store, status: &str) -> String {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES(?,?,'关联行动',?,'temporary','2026-10-25T00:00:00Z')").bind(&id).bind(&s.owner_id).bind(status).execute(&s.pool).await.unwrap();
        id
    }
    async fn update_status(s: &Store, id: &str, status: &str) {
        sqlx::query("UPDATE tasks SET status=? WHERE id=? AND owner_id=?")
            .bind(status)
            .bind(id)
            .bind(&s.owner_id)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    async fn action(s: &Store, name: &str) -> CultivationCommand {
        CultivationCommand {
            operation_id: Uuid::new_v4().to_string(),
            expected_version: s.cultivation_snapshot().await.unwrap()["version"]
                .as_i64()
                .unwrap(),
            action: name.into(),
            ..Default::default()
        }
    }
    async fn set_bound_goal(
        s: &Store,
        ids: Vec<String>,
        reward: Option<String>,
    ) -> CultivationCommand {
        let mut c = action(s, "set_goal").await;
        c.milestone = "发布第一组作品并自评".into();
        c.reward = "一次摄影出游".into();
        c.target = Some(ids.len() as i64);
        c.task_ids = ids;
        c.reward_id = reward;
        s.cultivation_command(&c).await.unwrap();
        c
    }
    #[tokio::test]
    async fn wish_binding_unlock_claim_and_retry_use_one_persistent_agreement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.db");
        let s = Store::open(&path).await.unwrap();
        let first = add_task(&s, "todo").await;
        let unrelated = add_task(&s, "todo").await;
        let mut wish = action(&s, "save_wish").await;
        wish.reward = "一次摄影出游".into();
        wish.milestone = "发布作品并自评".into();
        s.cultivation_command(&wish).await.unwrap();
        s.cultivation_command(&wish).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["rewardAgreements"].as_array().unwrap().len(), 1);
        assert_eq!(snap["rewardAgreements"][0]["status"], "wish");
        assert_eq!(snap["goal"]["milestone"], "");
        let mut early = action(&s, "claim").await;
        early.reward_id = Some(wish.operation_id.clone());
        assert!(s
            .cultivation_command(&early)
            .await
            .unwrap_err()
            .contains("尚未解锁"));
        set_bound_goal(&s, vec![first.clone()], Some(wish.operation_id.clone())).await;
        update_status(&s, &unrelated, "completed").await;
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["progress"], 0);
        assert_eq!(snap["goal"]["rewardStatus"], "locked");
        assert!(s
            .cultivation_command(&action(&s, "breakthrough").await)
            .await
            .is_err());
        update_status(&s, &first, "completed").await;
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["goal"]["progress"],
            1
        );
        let breakthrough = action(&s, "breakthrough").await;
        s.cultivation_command(&breakthrough).await.unwrap();
        s.cultivation_command(&breakthrough).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["breakthroughs"], 1);
        assert_eq!(snap["rewardAgreements"][0]["id"], wish.operation_id);
        assert_eq!(snap["rewardAgreements"][0]["status"], "available");
        let mut claim = action(&s, "claim").await;
        claim.reward_id = Some(wish.operation_id.clone());
        s.cultivation_command(&claim).await.unwrap();
        s.cultivation_command(&claim).await.unwrap();
        drop(s);
        let s = Store::open(&path).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["rewardStatus"], "claimed");
        assert!(!snap["goal"]["claimedAt"].is_null());
        assert_eq!(snap["rewardAgreements"].as_array().unwrap().len(), 1);
        let mut twice = action(&s, "claim").await;
        twice.reward_id = Some(wish.operation_id);
        assert!(s.cultivation_command(&twice).await.is_err());
    }
    #[tokio::test]
    async fn consumed_actions_cannot_support_a_second_breakthrough() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let root = add_task(&s, "completed").await;
        set_bound_goal(&s, vec![root.clone()], None).await;
        s.cultivation_command(&action(&s, "breakthrough").await)
            .await
            .unwrap();
        let mut repeat = action(&s, "set_goal").await;
        repeat.milestone = "重复成果".into();
        repeat.target = Some(1);
        repeat.task_ids = vec![root.clone()];
        assert!(s
            .cultivation_command(&repeat)
            .await
            .unwrap_err()
            .contains("已用于突破"));
        let mut global = action(&s, "set_goal").await;
        global.milestone = "下一阶段".into();
        global.target = Some(1);
        s.cultivation_command(&global).await.unwrap();
        update_status(&s, &root, "todo").await;
        s.cultivation_snapshot().await.unwrap();
        update_status(&s, &root, "completed").await;
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["goal"]["progress"],
            0
        );
        add_task(&s, "completed").await;
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["goal"]["progress"],
            1
        );
        s.cultivation_command(&action(&s, "breakthrough").await)
            .await
            .unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["breakthroughs"], 2);
    }
    #[tokio::test]
    async fn replacing_a_stage_preserves_and_reactivates_the_original_wish_id() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let a = add_task(&s, "todo").await;
        let b = add_task(&s, "todo").await;
        let first = set_bound_goal(&s, vec![a], None).await;
        let second = set_bound_goal(&s, vec![b], None).await;
        let snap = s.cultivation_snapshot().await.unwrap();
        let records = snap["rewardAgreements"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(
            records
                .iter()
                .find(|r| r["id"] == first.operation_id)
                .unwrap()["status"],
            "paused"
        );
        let mut restore = action(&s, "set_goal").await;
        restore.milestone = first.milestone;
        restore.reward = first.reward;
        restore.target = first.target;
        restore.task_ids = first.task_ids;
        restore.reward_id = Some(first.operation_id.clone());
        s.cultivation_command(&restore).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["id"], first.operation_id);
        let records = snap["rewardAgreements"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(
            records
                .iter()
                .find(|r| r["id"] == second.operation_id)
                .unwrap()["status"],
            "paused"
        );
    }
    #[tokio::test]
    async fn deleted_bound_work_does_not_unlock_but_confirmed_rewards_survive_later_undo() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let root = add_task(&s, "todo").await;
        set_bound_goal(&s, vec![root.clone()], None).await;
        update_status(&s, &root, "completed").await;
        s.cultivation_snapshot().await.unwrap();
        sqlx::query("UPDATE tasks SET deleted_at='2026-10-25T01:00:00Z' WHERE id=?")
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["progress"], 0);
        assert_eq!(snap["goal"]["taskProgress"][0]["unavailable"], true);
        assert_eq!(snap["experience"], 10);
        assert!(s
            .cultivation_command(&action(&s, "breakthrough").await)
            .await
            .is_err());
        sqlx::query("UPDATE tasks SET deleted_at=NULL WHERE id=?")
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        s.cultivation_command(&action(&s, "breakthrough").await)
            .await
            .unwrap();
        update_status(&s, &root, "todo").await;
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["rewardStatus"], "available");
        assert_eq!(snap["goal"]["progress"], 1);
        assert_eq!(snap["experience"], 0);
    }
    #[tokio::test]
    async fn parent_packages_need_all_live_leaves_and_subtasks_cannot_be_bound_separately() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let project = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,'项目','成果',1,0,'2026-10-25T00:00:00Z')").bind(&project).bind(&s.owner_id).execute(&s.pool).await.unwrap();
        let root = add_task(&s, "todo").await;
        sqlx::query("UPDATE tasks SET project_id=? WHERE id=?")
            .bind(&project)
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        for child in [&a, &b] {
            sqlx::query("INSERT INTO tasks(id,owner_id,project_id,parent_task_id,title,status,source,created_at) VALUES(?,?,?,?,'子行动','todo','temporary','2026-10-25T00:00:00Z')").bind(child).bind(&s.owner_id).bind(&project).bind(&root).execute(&s.pool).await.unwrap();
        }
        let mut invalid = action(&s, "set_goal").await;
        invalid.milestone = "子行动".into();
        invalid.target = Some(1);
        invalid.task_ids = vec![a.clone()];
        assert!(s.cultivation_command(&invalid).await.is_err());
        set_bound_goal(&s, vec![root.clone()], None).await;
        update_status(&s, &a, "completed").await;
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["goal"]["progress"],
            0
        );
        update_status(&s, &b, "completed").await;
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["progress"], 1);
        assert_eq!(snap["experience"], 10);
        assert_eq!(snap["availableTasks"].as_array().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn foreign_or_missing_work_and_wishes_cannot_be_used_and_stale_writes_leave_no_records() {
        let dir = tempfile::tempdir().unwrap();
        let a = Store::open(&dir.path().join("a.db")).await.unwrap();
        let b = Store::open(&dir.path().join("b.db")).await.unwrap();
        let foreign = add_task(&b, "completed").await;
        let mut bad = action(&a, "set_goal").await;
        bad.milestone = "成果".into();
        bad.target = Some(1);
        bad.task_ids = vec![foreign];
        assert!(a.cultivation_command(&bad).await.is_err());
        let mut wish = action(&b, "save_wish").await;
        wish.reward = "别人的奖励".into();
        b.cultivation_command(&wish).await.unwrap();
        bad.task_ids.clear();
        bad.reward_id = Some(wish.operation_id);
        assert!(a.cultivation_command(&bad).await.is_err());
        let mut stale = action(&a, "save_wish").await;
        stale.reward = "心愿".into();
        stale.expected_version = 1;
        assert!(a.cultivation_command(&stale).await.is_err());
        assert!(a.cultivation_snapshot().await.unwrap()["rewardAgreements"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn final_queue_failure_rolls_back_wish_and_stage_changes() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let mut wish = action(&s, "save_wish").await;
        wish.reward = "一支镜头".into();
        sqlx::query(&format!("CREATE TRIGGER fail_reward_outbox BEFORE INSERT ON sync_outbox WHEN NEW.operation_id='{}' BEGIN SELECT RAISE(ABORT,'forced_queue_failure'); END",wish.operation_id)).execute(&s.pool).await.unwrap();
        assert!(s.cultivation_command(&wish).await.is_err());
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["version"], 0);
        assert!(snap["rewardAgreements"].as_array().unwrap().is_empty());
    }
    #[tokio::test]
    async fn old_command_payload_and_legacy_reward_claim_remain_compatible() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let achievement = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cultivation_achievements(id,owner_id,milestone,reward,created_at,reward_id) VALUES(?,?,'旧成果','旧奖励','2026-10-24T00:00:00Z',?)").bind(&achievement).bind(&s.owner_id).bind(&achievement).execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO cultivation_state(owner_id,milestone,reward,achieved_at,breakthroughs) VALUES(?,'旧成果','旧奖励','2026-10-24T00:00:00Z',1)").bind(&s.owner_id).execute(&s.pool).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["id"], achievement);
        assert_eq!(snap["goal"]["rewardStatus"], "available");
        let mut claim = action(&s, "claim").await;
        claim.achievement_id = Some(achievement);
        let encoded = serde_json::to_string(&claim).unwrap();
        assert!(!encoded.contains("taskIds"));
        assert!(!encoded.contains("rewardId"));
        assert!(!encoded.contains("sourceApplicationId"));
        s.cultivation_command(&claim).await.unwrap();
        s.cultivation_command(&claim).await.unwrap();
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["goal"]["rewardStatus"],
            "claimed"
        );
    }

    #[tokio::test]
    async fn schema_24_upgrade_preserves_historical_reward_identity_and_legacy_claim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.db");
        let s = Store::open(&path).await.unwrap();
        let old = Uuid::new_v4().to_string();
        sqlx::raw_sql("DROP TABLE cultivation_achievement_tasks; DROP TABLE cultivation_goal_baseline_tasks; DROP TABLE cultivation_goal_tasks; DROP TABLE cultivation_reward_agreements; ALTER TABLE cultivation_state DROP COLUMN goal_id; ALTER TABLE cultivation_state DROP COLUMN source_application_id; ALTER TABLE cultivation_state DROP COLUMN rules_version; ALTER TABLE cultivation_achievements DROP COLUMN reward_id; DELETE FROM _sqlx_migrations WHERE version=25;").execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO cultivation_achievements(id,owner_id,milestone,reward,created_at) VALUES(?,?,'旧版成果','旧版奖励','2026-10-24T00:00:00Z')").bind(&old).bind(&s.owner_id).execute(&s.pool).await.unwrap();
        sqlx::query("INSERT INTO cultivation_state(owner_id,version,breakthroughs,milestone,reward,achieved_at) VALUES(?,3,1,'旧版成果','旧版奖励','2026-10-24T00:00:00Z')").bind(&s.owner_id).execute(&s.pool).await.unwrap();
        s.pool.close().await;
        drop(s);
        let s = Store::open(&path).await.unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["id"], old);
        assert_eq!(snap["rewardAgreements"][0]["status"], "available");
        assert_eq!(snap["rewardAgreements"][0]["taskIds"], json!([]));
        assert_eq!(snap["version"], 3);
        let mut claim = action(&s, "claim").await;
        claim.achievement_id = Some(old);
        s.cultivation_command(&claim).await.unwrap();
        assert_eq!(
            s.cultivation_snapshot().await.unwrap()["rewardAgreements"][0]["status"],
            "claimed"
        );
    }
    #[tokio::test]
    async fn stage_queue_failure_keeps_previous_stage_and_reward_locked() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let a = add_task(&s, "todo").await;
        let b = add_task(&s, "todo").await;
        let old = set_bound_goal(&s, vec![a], None).await;
        let mut next = action(&s, "set_goal").await;
        next.milestone = "另一个成果".into();
        next.reward = "另一个奖励".into();
        next.target = Some(1);
        next.task_ids = vec![b];
        sqlx::query(&format!("CREATE TRIGGER fail_stage_queue BEFORE INSERT ON sync_outbox WHEN NEW.operation_id='{}' BEGIN SELECT RAISE(ABORT,'forced_queue_failure'); END",next.operation_id)).execute(&s.pool).await.unwrap();
        assert!(s.cultivation_command(&next).await.is_err());
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["goal"]["id"], old.operation_id);
        assert_eq!(snap["rewardAgreements"].as_array().unwrap().len(), 1);
        assert_eq!(snap["rewardAgreements"][0]["status"], "locked");
        assert_eq!(snap["version"], 1);
    }
    #[tokio::test]
    async fn merging_completed_roots_does_not_duplicate_package_experience() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let project = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,'项目','成果',1,0,'2026-10-25T00:00:00Z')").bind(&project).bind(&s.owner_id).execute(&s.pool).await.unwrap();
        let a = add_task(&s, "completed").await;
        let b = add_task(&s, "completed").await;
        sqlx::query("UPDATE tasks SET project_id=? WHERE id IN (?,?)")
            .bind(&project)
            .bind(&a)
            .bind(&b)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(s.cultivation_snapshot().await.unwrap()["experience"], 20);
        update_status(&s, &b, "todo").await;
        sqlx::query("UPDATE tasks SET parent_task_id=? WHERE id=?")
            .bind(&b)
            .bind(&a)
            .execute(&s.pool)
            .await
            .unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        assert_eq!(snap["experience"], 10);
        assert_eq!(snap["availableTasks"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn splitting_or_wrapping_consumed_work_does_not_make_it_eligible_again() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("p.db")).await.unwrap();
        let project = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at) VALUES(?,?,'项目','成果',1,0,'2026-10-25T00:00:00Z')").bind(&project).bind(&s.owner_id).execute(&s.pool).await.unwrap();
        let root = add_task(&s, "todo").await;
        sqlx::query("UPDATE tasks SET project_id=? WHERE id=?")
            .bind(&project)
            .bind(&root)
            .execute(&s.pool)
            .await
            .unwrap();
        let child = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO tasks(id,owner_id,project_id,parent_task_id,title,status,source,created_at) VALUES(?,?,?,?,'已完成子行动','completed','temporary','2026-10-25T00:00:00Z')").bind(&child).bind(&s.owner_id).bind(&project).bind(&root).execute(&s.pool).await.unwrap();
        set_bound_goal(&s, vec![root.clone()], None).await;
        s.cultivation_command(&action(&s, "breakthrough").await)
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET parent_task_id=NULL WHERE id=?")
            .bind(&child)
            .execute(&s.pool)
            .await
            .unwrap();
        let snap = s.cultivation_snapshot().await.unwrap();
        let child_row = snap["availableTasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == child)
            .unwrap();
        assert_eq!(child_row["consumed"], true);
        let mut next = action(&s, "set_goal").await;
        next.milestone = "不能重复用子行动".into();
        next.target = Some(1);
        next.task_ids = vec![child.clone()];
        assert!(s.cultivation_command(&next).await.is_err());
        let wrapper = add_task(&s, "todo").await;
        sqlx::query("UPDATE tasks SET project_id=? WHERE id=?")
            .bind(&project)
            .bind(&wrapper)
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET parent_task_id=? WHERE id=?")
            .bind(&wrapper)
            .bind(&child)
            .execute(&s.pool)
            .await
            .unwrap();
        next.operation_id = Uuid::new_v4().to_string();
        next.task_ids = vec![wrapper.clone()];
        assert!(s.cultivation_command(&next).await.is_err());
        let snap = s.cultivation_snapshot().await.unwrap();
        let row = snap["availableTasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == wrapper)
            .unwrap();
        assert_eq!(row["consumed"], true);
    }
}
