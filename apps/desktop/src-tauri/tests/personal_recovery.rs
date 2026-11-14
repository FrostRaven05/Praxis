//! Personal recovery reuses original transactions and never fabricates old completion dates.
use praxis_desktop_lib::store::{ProductivityCommand, Store, TrashCommand};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
const AT: &str = "2026-11-12T00:00:00Z";
fn cmd(action: Value) -> ProductivityCommand {
    serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":action})).unwrap()
}
async fn create(store: &Store, task: &str) {
    store.productivity_command(&cmd(json!({"type":"task","id":task,"expectedVersion":null,"title":"可恢复任务","notes":"旧内容","projectId":null,"plan":null,"deadline":{"kind":"date","date":"2026-12-01"},"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[],"arrangeOnCreate":false}))).await.unwrap();
}
async fn state(store: &Store) -> Value {
    store.productivity_snapshot().await.unwrap()["tasks"][0].clone()
}
async fn status(store: &Store, task: &str, target: &str) -> ProductivityCommand {
    let version = state(store).await["version"].as_i64().unwrap();
    let c = cmd(
        json!({"type":"status","id":task,"expectedVersion":version,"status":target,"confirmRelated":false,"expectedTasks":[[task,version]]}),
    );
    store.productivity_command(&c).await.unwrap();
    c
}
async fn undo(store: &Store, task: &str, original: &ProductivityCommand) -> Result<(), String> {
    let version = state(store).await["version"].as_i64().unwrap();
    store.productivity_command(&cmd(json!({"type":"undoStatus","id":task,"expectedVersion":version,"originalOperationId":original.operation_id,"expectedTasks":[[task,version]]}))).await
}
#[tokio::test]
async fn status_undo_restores_known_and_unknown_completion_facts_and_rejects_newer_edits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("undo.db");
    let store = Store::open(&path).await.unwrap();
    store
        .initialize_workspace_zone("Asia/Hong_Kong")
        .await
        .unwrap();
    let task = id();
    create(&store, &task).await;
    status(&store, &task, "completed").await;
    let completed = state(&store).await;
    let records = store.task_history(&task).await.unwrap();
    let reopen = status(&store, &task, "todo").await;
    undo(&store, &task, &reopen).await.unwrap();
    let restored = state(&store).await;
    assert_eq!(restored["completedAt"], completed["completedAt"]);
    assert_eq!(
        store.task_history(&task).await.unwrap().len(),
        records.len()
    );
    let second = status(&store, &task, "todo").await;
    let mut db = sqlx::SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET notes='其他新编辑',version=version+1 WHERE id=?")
        .bind(&task)
        .execute(&mut db)
        .await
        .unwrap();
    assert!(undo(&store, &task, &second)
        .await
        .unwrap_err()
        .starts_with("STATE_CONFLICT"));
    assert_eq!(state(&store).await["notes"], json!("其他新编辑"));
    sqlx::query("UPDATE tasks SET status='completed',completed_at=NULL,active_completion_id=NULL,version=version+1 WHERE id=?").bind(&task).execute(&mut db).await.unwrap();
    sqlx::query("UPDATE tasks SET completed_at=NULL WHERE id=?")
        .bind(&task)
        .execute(&mut db)
        .await
        .unwrap();
    let unknown = status(&store, &task, "todo").await;
    let count = store.task_history(&task).await.unwrap().len();
    undo(&store, &task, &unknown).await.unwrap();
    assert!(state(&store).await["completedAt"].is_null());
    assert_eq!(state(&store).await["status"], json!("completed"));
    assert_eq!(store.task_history(&task).await.unwrap().len(), count);
    store.close().await;
}
#[tokio::test]
async fn checked_leaf_restore_preserves_content_receipts_and_rejects_deleted_version_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("restore.db");
    let store = Store::open(&path).await.unwrap();
    let task = id();
    create(&store, &task).await;
    let original = state(&store).await;
    let version = original["version"].as_i64().unwrap();
    let delete:TrashCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"delete","targetType":"task","id":task,"expectedVersion":version,"mode":"cascade","confirmAll":false,"expectedTasks":[[task,version]]}})).unwrap();
    store.trash_command(&delete).await.unwrap();
    store.trash_command(&delete).await.unwrap();
    let snapshot = store.trash_snapshot().await.unwrap();
    let entry = &snapshot["entries"][0];
    assert_eq!(entry["taskId"], json!(task));
    assert!(entry["version"].as_i64().is_some());
    let stale:TrashCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"restoreChecked","batchId":delete.operation_id,"expectedDeletedTasks":[[task,version]]}})).unwrap();
    assert!(store
        .trash_command(&stale)
        .await
        .unwrap_err()
        .starts_with("STATE_CONFLICT"));
    let current = store.trash_snapshot().await.unwrap()["entries"][0]["version"].clone();
    let restore:TrashCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"restoreChecked","batchId":delete.operation_id,"expectedDeletedTasks":[[task,current]]}})).unwrap();
    store.trash_command(&restore).await.unwrap();
    store.trash_command(&restore).await.unwrap();
    let after = state(&store).await;
    assert_eq!(after["notes"], original["notes"]);
    assert_eq!(after["deadline"], original["deadline"]);
    store.close().await;
}
