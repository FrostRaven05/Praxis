use praxis_desktop_lib::store::{CaptureCommand, CompletionCommand, Store};
use uuid::Uuid;
fn capture() -> CaptureCommand {
    CaptureCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        plan_id: Uuid::new_v4().to_string(),
        title: "桌面任务".into(),
        execution_date: "2026-09-16".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-09-16T10:00:00Z".into(),
    }
}
fn complete(c: &CaptureCommand) -> CompletionCommand {
    CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: c.task_id.clone(),
        plan_id: c.plan_id.clone(),
        action: "complete".into(),
        expected_version: 0,
        completion_id: None,
        execution_date: "2026-09-17".into(),
        time_zone: c.time_zone.clone(),
        occurred_at: "2026-09-16T16:01:00Z".into(),
    }
}
#[tokio::test]
async fn completion_and_undo_persist_facts_and_history_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let done = complete(&c);
    let row = store.change_completion(&done).await.unwrap();
    assert_eq!(row.status, "completed");
    assert_eq!(row.version, 1);
    store.change_completion(&done).await.unwrap();
    assert_eq!(store.execution_history(&c.task_id).await.unwrap().len(), 1);
    store.close().await;
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.list_day("2026-09-17").await.unwrap()[0].status,
        "completed"
    );
    assert!(store.list_day("2026-09-16").await.unwrap().is_empty());
    let undo = CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        action: "undo".into(),
        expected_version: 1,
        completion_id: Some(done.operation_id.clone()),
        occurred_at: "2026-09-16T16:02:00Z".into(),
        ..done.clone()
    };
    let restored = store.change_completion(&undo).await.unwrap();
    assert_eq!(restored.status, "todo");
    assert_eq!(restored.version, 2);
    let facts = store.execution_history(&c.task_id).await.unwrap();
    assert_eq!(facts[0].execution_date, "2026-09-17");
    assert!(facts[0].revoked_at.is_some());
    assert_eq!(store.task_history(&c.task_id).await.unwrap().len(), 3);
    assert_eq!(store.pending_operations().await.unwrap().len(), 3);
    store.close().await;
}

#[tokio::test]
async fn stale_undo_cannot_revert_a_later_completion() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let first = complete(&c);
    store.change_completion(&first).await.unwrap();
    let undo = CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        action: "undo".into(),
        expected_version: 1,
        completion_id: Some(first.operation_id.clone()),
        ..first.clone()
    };
    store.change_completion(&undo).await.unwrap();
    let later = CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        expected_version: 2,
        ..first.clone()
    };
    store.change_completion(&later).await.unwrap();
    // Even replaying an old successful completion/undo does not apply it a second time.
    store.change_completion(&undo).await.unwrap();
    store.change_completion(&first).await.unwrap();
    let stale = CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        ..undo
    };
    assert_eq!(
        store.change_completion(&stale).await.unwrap_err(),
        "STATE_CONFLICT"
    );
    let tasks = store.list_day("2026-09-17").await.unwrap();
    assert_eq!(tasks[0].status, "completed");
    assert_eq!(tasks[0].version, 3);
    let facts = store.execution_history(&c.task_id).await.unwrap();
    assert_eq!(facts.len(), 2);
    assert_eq!(facts.iter().filter(|f| f.revoked_at.is_none()).count(), 1);
    assert_eq!(store.pending_operations().await.unwrap().len(), 4);
    store.close().await;
}
#[tokio::test]
async fn outbox_failure_rolls_back_completion_and_execution_fact() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let store = Store::open(&path).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let mut fault = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    // Inject a storage failure at the last write, after task/fact/history mutations.
    sqlx::query("CREATE TRIGGER fail_completion BEFORE INSERT ON sync_outbox WHEN NEW.kind='complete_task' BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;").execute(&mut fault).await.unwrap();
    let done = complete(&c);
    assert!(store.change_completion(&done).await.is_err());
    assert_eq!(
        store.list_day(&c.execution_date).await.unwrap()[0].status,
        "todo"
    );
    assert!(store
        .execution_history(&c.task_id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(store.task_history(&c.task_id).await.unwrap().len(), 1);
    assert_eq!(store.pending_operations().await.unwrap().len(), 1);
    sqlx::query("DROP TRIGGER fail_completion")
        .execute(&mut fault)
        .await
        .unwrap();
    store.change_completion(&done).await.unwrap();
    store.close().await;
}
#[tokio::test]
async fn upgrade_preserves_existing_capture_and_enables_completion() {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("old_migrations");
    std::fs::create_dir(&migrations).unwrap();
    std::fs::write(
        migrations.join("0001_capture.sql"),
        include_str!("../migrations/0001_capture.sql"),
    )
    .unwrap();
    let path = dir.path().join("upgrade.db");
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    let c = capture();
    let owner = Uuid::new_v4().to_string();
    let device = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO local_profile VALUES(1,?,?)")
        .bind(&owner)
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES(?,?,?,'todo','temporary',?)").bind(&c.task_id).bind(&owner).bind(&c.title).bind(&c.occurred_at).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO daily_plan_items VALUES(?,?,?,?,?,?)")
        .bind(&c.plan_id)
        .bind(&owner)
        .bind(&c.task_id)
        .bind(&c.execution_date)
        .bind(&c.time_zone)
        .bind(&c.occurred_at)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let store = Store::open(&path).await.unwrap();
    let row = &store.list_day(&c.execution_date).await.unwrap()[0];
    assert_eq!(row.title, c.title);
    assert_eq!(row.version, 0);
    store.change_completion(&complete(&c)).await.unwrap();
    assert_eq!(store.execution_history(&c.task_id).await.unwrap().len(), 1);
    store.close().await;
}

#[tokio::test]
async fn execution_fact_cannot_reference_another_tasks_plan() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.db");
    let store = Store::open(&path).await.unwrap();
    let a = capture();
    let b = capture();
    store.capture(&a).await.unwrap();
    store.capture(&b).await.unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true);
    let mut db = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let bad=sqlx::query("INSERT INTO execution_records(id,owner_id,task_id,plan_id,execution_date,time_zone,occurred_at) SELECT ?,owner_id,?,?,?, ?,? FROM local_profile WHERE singleton=1")
  .bind(Uuid::new_v4().to_string()).bind(&a.task_id).bind(&b.plan_id).bind(&a.execution_date).bind(&a.time_zone).bind(&a.occurred_at)
  .execute(&mut db).await;
    assert!(bad.is_err());
    assert!(store
        .execution_history(&a.task_id)
        .await
        .unwrap()
        .is_empty());
    store.close().await;
}
