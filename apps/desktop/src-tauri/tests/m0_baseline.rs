//! Synthetic M0 fixture only. Uses the real schema and backup/restore path, never user data.
use praxis_desktop_lib::store::{
    backup, AddProjectTasksCommand, AddSubtasksCommand, AiApplyCommand, InboxCommand,
    NewProjectTask, SaveProjectCommand, ScheduleCommand, Store, TaskDetailsCommand,
    WorkspaceAction, WorkspaceCommand,
};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::path::Path;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

async fn tables(pool: &SqlitePool) -> BTreeMap<String, Vec<String>> {
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(pool).await.unwrap();
    let mut result = BTreeMap::new();
    for name in names {
        let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as(&format!("PRAGMA table_info({})", quote(&name)))
                .fetch_all(pool)
                .await
                .unwrap();
        let fields = columns.iter().map(|column| {
            let identifier = quote(&column.1);
            format!("'{}',CASE WHEN typeof({identifier})='blob' THEN hex({identifier}) ELSE {identifier} END", column.1.replace('\'', "''"))
        }).collect::<Vec<_>>().join(",");
        let mut rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({fields}) FROM {}",
            quote(&name)
        ))
        .fetch_all(pool)
        .await
        .unwrap();
        rows.sort();
        result.insert(name, rows);
    }
    result
}

async fn seed(store: &Store, pool: &SqlitePool, fixture: &Value) {
    let legacy = &fixture["legacy"];
    let independent = &legacy["independent"];
    let at = text(&fixture["clock"], "now");
    store
        .capture_inbox(&InboxCommand {
            operation_id: id(),
            task_id: text(independent, "id").into(),
            title: text(independent, "title").into(),
            occurred_at: at.into(),
        })
        .await
        .unwrap();
    store
        .save_task_details(&TaskDetailsCommand {
            operation_id: id(),
            task_id: text(independent, "id").into(),
            expected_version: 0,
            title: text(independent, "title").into(),
            notes: text(independent, "notes").into(),
            completion_criteria: "保留全部旧字段".into(),
            important: true,
            deadline: Some(text(independent, "deadline").into()),
            deadline_time_zone: Some(text(independent, "deadlineTimeZone").into()),
            estimated_minutes: Some(45),
            occurred_at: at.into(),
        })
        .await
        .unwrap();
    store
        .schedule_task(&ScheduleCommand {
            operation_id: id(),
            task_id: text(independent, "id").into(),
            plan_id: id(),
            expected_version: 1,
            execution_date: text(independent, "planDate").into(),
            time_zone: "Asia/Hong_Kong".into(),
            occurred_at: at.into(),
        })
        .await
        .unwrap();
    let project = &legacy["project"];
    store
        .save_project(&SaveProjectCommand {
            operation_id: id(),
            project_id: text(project, "id").into(),
            expected_version: None,
            name: text(project, "name").into(),
            outcome: text(project, "outcome").into(),
            target_date: Some(text(project, "targetDate").into()),
            priority: 1,
            occurred_at: at.into(),
        })
        .await
        .unwrap();
    let tasks = legacy["tasks"].as_array().unwrap();
    store
        .add_project_tasks(&AddProjectTasksCommand {
            operation_id: id(),
            project_id: text(project, "id").into(),
            occurred_at: at.into(),
            tasks: tasks
                .iter()
                .filter(|task| task["parentId"].is_null())
                .map(|task| NewProjectTask {
                    task_id: text(task, "id").into(),
                    title: text(task, "title").into(),
                })
                .collect(),
        })
        .await
        .unwrap();
    store
        .add_subtasks(&AddSubtasksCommand {
            operation_id: id(),
            parent_task_id: text(&tasks[0], "id").into(),
            expected_version: 0,
            confirm_summary_plan: false,
            occurred_at: at.into(),
            tasks: tasks
                .iter()
                .filter(|task| !task["parentId"].is_null())
                .map(|task| NewProjectTask {
                    task_id: text(task, "id").into(),
                    title: text(task, "title").into(),
                })
                .collect(),
        })
        .await
        .unwrap();
    for task in tasks {
        let status = text(task, "status");
        if status == "waiting" {
            sqlx::query("UPDATE tasks SET waiting=1,waiting_for='外部确认',waiting_note='保留等待语义' WHERE id=?")
                .bind(text(task, "id")).execute(pool).await.unwrap();
        } else if status != "todo" {
            store
                .project_workspace(&WorkspaceCommand {
                    operation_id: id(),
                    occurred_at: at.into(),
                    action: WorkspaceAction::Status {
                        task_id: text(task, "id").into(),
                        expected_version: 0,
                        status: status.into(),
                        reason: "隔离样本中的历史状态".into(),
                        date: "2026-11-10".into(),
                        time_zone: "Asia/Hong_Kong".into(),
                    },
                })
                .await
                .unwrap();
        }
    }
    let ai = &legacy["ai"];
    let command: AiApplyCommand = serde_json::from_value(json!({
        "operationId":ai["operationId"],"runId":ai["runId"],"input":"M0 隔离 AI 回执样本",
        "source":null,"project":null,"newProject":{"id":ai["projectId"],"name":"旧 AI 采用样本","outcome":"保留回执"},
        "basisTasks":[],"tasks":[{"id":ai["taskId"],"key":"s1","title":"已有 AI 任务","criteria":"可找到采用回执","estimatedMinutes":null,"dependsOn":[]}],"reward":null
    })).unwrap();
    store.ai_apply(&command).await.unwrap();
    assert_eq!(store.ai_apply(&command).await.unwrap().task_ids.len(), 1);
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM local_profile")
        .fetch_one(pool)
        .await
        .unwrap();
    let reward = &legacy["reward"];
    // Direct inserts represent already-existing legacy history, not new product behavior.
    sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at,deleted_at,completed_at) VALUES(?,?,'旧已删除完成任务','completed','temporary',?,?,?)")
        .bind(text(legacy, "oldCreditTaskId")).bind(&owner).bind(text(reward, "claimedAt")).bind(at).bind(text(reward, "claimedAt")).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO cultivation_credits(owner_id,task_id,awarded_at,active) VALUES(?,?,?,1)",
    )
    .bind(&owner)
    .bind(text(legacy, "oldCreditTaskId"))
    .bind(text(reward, "claimedAt"))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,created_at,unlocked_at,claimed_at) VALUES(?,?,?,?,'claimed','all',?,?,?)")
        .bind(text(reward, "id")).bind(&owner).bind(text(reward, "milestone")).bind(text(reward, "reward"))
        .bind(text(reward, "claimedAt")).bind(text(reward, "claimedAt")).bind(text(reward, "claimedAt")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cultivation_achievements(id,owner_id,milestone,reward,created_at,claimed_at,reward_id) VALUES(?,?,?,?,?,?,?)")
        .bind(text(reward, "id")).bind(&owner).bind(text(reward, "milestone")).bind(text(reward, "reward"))
        .bind(text(reward, "claimedAt")).bind(text(reward, "claimedAt")).bind(text(reward, "id")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cultivation_state(owner_id,breakthroughs,milestone,reward,achieved_at,claimed_at,goal_id,rules_version) VALUES(?,1,?,?,?,?,?,2)")
        .bind(&owner).bind(text(reward, "milestone")).bind(text(reward, "reward"))
        .bind(text(reward, "claimedAt")).bind(text(reward, "claimedAt")).bind(text(reward, "id")).execute(pool).await.unwrap();
    assert_eq!(
        store.cultivation_snapshot().await.unwrap()["experience"],
        10
    );
}

#[tokio::test]
async fn m0_full_legacy_fixture_roundtrips_all_tables_and_failed_restore_keeps_original() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../docs/m0/fixtures.json")).unwrap();
    assert_eq!(fixture["synthetic"], true);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    seed(&store, &pool, &fixture).await;
    let before = tables(&pool).await;
    assert!(!before["sync_outbox"].is_empty());
    assert_eq!(before["ai_applications"].len(), 1);
    assert_eq!(before["cultivation_achievements"].len(), 1);
    let backup_path = store.create_backup(dir.path()).await.unwrap();
    let backup_name = Path::new(&backup_path)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    let broken_path = dir.path().join("backups").join("m0-broken.db");
    std::fs::write(&broken_path, b"not a sqlite backup").unwrap();
    assert!(backup::prepare_restore(dir.path(), "m0-broken.db")
        .await
        .is_err());
    assert!(backup::prepare_restore(dir.path(), "../praxis.db")
        .await
        .is_err());
    assert_eq!(backup::selected_database(dir.path()), path);
    assert_eq!(tables(&pool).await, before);
    let restored_path = backup::prepare_restore(dir.path(), backup_name)
        .await
        .unwrap();
    assert_ne!(Path::new(&restored_path), path);
    assert_eq!(
        backup::selected_database(dir.path()),
        Path::new(&restored_path)
    );
    let restored = Store::open(Path::new(&restored_path)).await.unwrap();
    let restored_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&restored_path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    assert_eq!(tables(&restored_pool).await, before);
    assert_eq!(tables(&pool).await, before);
    let detail = restored
        .task_details(text(&fixture["legacy"]["independent"], "id"))
        .await
        .unwrap();
    assert_eq!(
        detail.notes,
        text(&fixture["legacy"]["independent"], "notes")
    );
    assert_eq!(
        detail.deadline_time_zone.as_deref(),
        Some("America/Los_Angeles")
    );
    assert_eq!(
        restored
            .ai_receipt(text(&fixture["legacy"]["ai"], "operationId"))
            .await
            .unwrap()
            .unwrap()
            .task_ids
            .len(),
        1
    );
    restored_pool.close().await;
    restored.close().await;
    pool.close().await;
    store.close().await;
    if let Ok(export) = std::env::var("PRAXIS_M0_EXPORT_DIR") {
        let export = Path::new(&export);
        std::fs::create_dir_all(export.join("backups")).unwrap();
        std::fs::copy(&path, export.join("praxis.db")).unwrap();
        std::fs::copy(&backup_path, export.join("backups").join(backup_name)).unwrap();
        let recovered_name = Path::new(&restored_path).file_name().unwrap();
        std::fs::copy(&restored_path, export.join(recovered_name)).unwrap();
        std::fs::copy(
            dir.path().join("active-database.txt"),
            export.join("active-database.txt"),
        )
        .unwrap();
        std::fs::write(
            export.join("table-snapshot.json"),
            serde_json::to_vec_pretty(&before).unwrap(),
        )
        .unwrap();
        std::fs::write(export.join("fixture-manifest.json"), serde_json::to_vec_pretty(&json!({
            "synthetic":true,"fixtureVersion":fixture["version"],"schemaVersion":praxis_desktop_lib::store::current_schema_version(),
            "tables":before.len(),"outboxRows":before["sync_outbox"].len(),"aiReceipts":before["ai_applications"].len(),
            "claimedRewards":before["cultivation_reward_agreements"].len(),"allTablesEqualAfterRestore":true,"originalUnchanged":true
        })).unwrap()).unwrap();
    }
}
