//! P1-03 uses existing productivity transactions, receipts and typed dates.
use praxis_desktop_lib::store::{ProductivityCommand, SaveProjectCommand, Store};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::Connection;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
const AT: &str = "2026-11-11T04:00:00Z";
fn command(action: Value) -> ProductivityCommand {
    serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":action})).unwrap()
}
fn task(
    task_id: &str,
    version: Option<i64>,
    project: Option<&str>,
    notes: &str,
    deadline: Value,
) -> ProductivityCommand {
    command(
        json!({"type":"task","id":task_id,"expectedVersion":version,"title":"行内任务","notes":notes,"projectId":project,
        "plan":null,"deadline":deadline,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[],"arrangeOnCreate":false}),
    )
}
#[tokio::test]
async fn inline_creation_edit_and_three_states_keep_one_unplanned_identity_and_old_typed_time() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("inline.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize_workspace_zone("Asia/Hong_Kong")
        .await
        .unwrap();
    let task_id = id();
    let original = json!({"kind":"instant","atUtc":"2026-11-11T02:00:00Z","displayTimezone":"America/Los_Angeles"});
    let create = task(&task_id, None, None, "说明", original.clone());
    store.productivity_command(&create).await.unwrap();
    store.productivity_command(&create).await.unwrap();
    let snapshot = store.productivity_snapshot().await.unwrap();
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["tasks"][0]["version"], json!(1));
    assert!(snapshot["legacyPlans"].as_array().unwrap().is_empty());
    assert!(snapshot["tasks"][0]["plan"].is_null());
    store
        .productivity_command(&task(&task_id, Some(1), None, "更新说明", original.clone()))
        .await
        .unwrap();
    assert_eq!(
        store.productivity_snapshot().await.unwrap()["tasks"][0]["deadline"],
        original
    );
    let stale = task(&task_id, Some(1), None, "过期编辑", Value::Null);
    assert!(store
        .productivity_command(&stale)
        .await
        .unwrap_err()
        .starts_with("STATE_CONFLICT"));
    for status in ["in_progress", "completed", "todo"] {
        let version = store.productivity_snapshot().await.unwrap()["tasks"][0]["version"]
            .as_i64()
            .unwrap();
        store.productivity_command(&command(json!({"type":"status","id":task_id,"expectedVersion":version,"status":status,"confirmRelated":false,"expectedTasks":[[task_id,version]]}))).await.unwrap();
    }
    let after = store.productivity_snapshot().await.unwrap();
    assert_eq!(after["tasks"][0]["id"], json!(task_id));
    assert_eq!(after["tasks"][0]["notes"], json!("更新说明"));
    assert_eq!(after["tasks"][0]["status"], json!("todo"));
    assert_eq!(after["tasks"][0]["deadline"], original);
    assert!(after["tasks"][0]["completedAt"].is_null());
    assert!(after["legacyPlans"].as_array().unwrap().is_empty());
    store.close().await;
}
#[tokio::test]
async fn closed_project_rejects_new_tasks_atomically_but_keeps_existing_task_edits_available() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("closed.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize_workspace_zone("Asia/Hong_Kong")
        .await
        .unwrap();
    let project = id();
    let task_id = id();
    store
        .save_project(&SaveProjectCommand {
            operation_id: id(),
            project_id: project.clone(),
            expected_version: None,
            name: "个人项目".into(),
            outcome: "".into(),
            target_date: None,
            priority: 1,
            occurred_at: AT.into(),
        })
        .await
        .unwrap();
    store
        .productivity_command(&task(&task_id, None, Some(&project), "原说明", Value::Null))
        .await
        .unwrap();
    store.productivity_command(&command(json!({"type":"status","id":task_id,"expectedVersion":1,"status":"completed","confirmRelated":false,"expectedTasks":[[task_id,1]]}))).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::query("UPDATE projects SET status='completed',version=version+1 WHERE id=?")
        .bind(&project)
        .execute(&mut db)
        .await
        .unwrap();
    let before = store.productivity_snapshot().await.unwrap();
    let new_id = id();
    assert!(store
        .productivity_command(&task(&new_id, None, Some(&project), "新任务", Value::Null))
        .await
        .unwrap_err()
        .starts_with("USER:"));
    assert_eq!(store.productivity_snapshot().await.unwrap(), before);
    store
        .productivity_command(&task(
            &task_id,
            before["tasks"][0]["version"].as_i64(),
            Some(&project),
            "旧任务说明仍可编辑",
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(
        store.productivity_snapshot().await.unwrap()["tasks"][0]["notes"],
        json!("旧任务说明仍可编辑")
    );
    store.close().await;
}
