use praxis_desktop_lib::store::{CaptureCommand, EditTaskCommand, Store};
use uuid::Uuid;
fn capture() -> CaptureCommand {
    CaptureCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        plan_id: Uuid::new_v4().to_string(),
        title: "原任务".into(),
        execution_date: "2026-09-16".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-09-16T12:00:00Z".into(),
    }
}
fn edit(c: &CaptureCommand) -> EditTaskCommand {
    EditTaskCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: c.task_id.clone(),
        plan_id: c.plan_id.clone(),
        expected_version: 0,
        title: "编辑后的任务".into(),
        execution_date: "2026-09-18".into(),
        time_zone: c.time_zone.clone(),
        occurred_at: c.occurred_at.clone(),
        undo_of: None,
    }
}
#[tokio::test]
async fn edit_and_reschedule_keep_identity_history_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit.db");
    let store = Store::open(&path).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let change = edit(&c);
    let result = store.edit_task(&change).await.unwrap();
    assert_eq!(result.plan_id, c.plan_id);
    assert_eq!(result.version, 1);
    store.edit_task(&change).await.unwrap();
    assert!(store.list_day(&c.execution_date).await.unwrap().is_empty());
    store.close().await;
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.list_day("2026-09-18").await.unwrap()[0].title,
        "编辑后的任务"
    );
    let undo = EditTaskCommand {
        operation_id: Uuid::new_v4().to_string(),
        expected_version: 1,
        title: c.title.clone(),
        execution_date: c.execution_date.clone(),
        undo_of: Some(change.operation_id.clone()),
        ..change.clone()
    };
    store.edit_task(&undo).await.unwrap();
    assert_eq!(
        store.list_day(&c.execution_date).await.unwrap()[0].title,
        c.title
    );
    assert_eq!(store.task_history(&c.task_id).await.unwrap().len(), 3);
    assert_eq!(store.pending_operations().await.unwrap().len(), 3);
    store.close().await;
}

#[tokio::test]
async fn stale_edits_and_undo_cannot_overwrite_newer_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("edit.db")).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let first = edit(&c);
    store.edit_task(&first).await.unwrap();
    let later = EditTaskCommand {
        operation_id: Uuid::new_v4().to_string(),
        expected_version: 1,
        title: "更新的标题".into(),
        ..first.clone()
    };
    store.edit_task(&later).await.unwrap();
    let stale = EditTaskCommand {
        operation_id: Uuid::new_v4().to_string(),
        ..first.clone()
    };
    assert_eq!(store.edit_task(&stale).await.unwrap_err(), "STATE_CONFLICT");
    let undo = EditTaskCommand {
        operation_id: Uuid::new_v4().to_string(),
        expected_version: 1,
        title: c.title.clone(),
        execution_date: c.execution_date.clone(),
        undo_of: Some(first.operation_id.clone()),
        ..first.clone()
    };
    assert_eq!(store.edit_task(&undo).await.unwrap_err(), "STATE_CONFLICT");
    store.edit_task(&first).await.unwrap();
    assert_eq!(
        store.list_day("2026-09-18").await.unwrap()[0].title,
        "更新的标题"
    );
    assert_eq!(store.pending_operations().await.unwrap().len(), 3);
    store.close().await;
}
#[tokio::test]
async fn failure_in_last_write_rolls_back_title_and_date() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit.db");
    let store = Store::open(&path).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_edit BEFORE INSERT ON sync_outbox WHEN NEW.kind='edit_task' BEGIN SELECT RAISE(ABORT,'test failure'); END;").execute(&mut db).await.unwrap();
    let change = edit(&c);
    assert!(store.edit_task(&change).await.is_err());
    let row = &store.list_day(&c.execution_date).await.unwrap()[0];
    assert_eq!(row.title, c.title);
    assert_eq!(row.version, 0);
    assert!(store.list_day("2026-09-18").await.unwrap().is_empty());
    assert_eq!(store.task_history(&c.task_id).await.unwrap().len(), 1);
    sqlx::query("DROP TRIGGER fail_edit")
        .execute(&mut db)
        .await
        .unwrap();
    store.edit_task(&change).await.unwrap();
    store.close().await;
}
#[tokio::test]
async fn completed_task_title_edit_preserves_execution_facts_and_rejects_rescheduling() {
    use praxis_desktop_lib::store::CompletionCommand;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("edit.db")).await.unwrap();
    let c = capture();
    store.capture(&c).await.unwrap();
    let done = CompletionCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: c.task_id.clone(),
        plan_id: c.plan_id.clone(),
        expected_version: 0,
        action: "complete".into(),
        completion_id: None,
        execution_date: c.execution_date.clone(),
        time_zone: c.time_zone.clone(),
        occurred_at: c.occurred_at.clone(),
    };
    store.change_completion(&done).await.unwrap();
    let move_it = EditTaskCommand {
        expected_version: 1,
        ..edit(&c)
    };
    assert_eq!(
        store.edit_task(&move_it).await.unwrap_err(),
        "COMPLETED_PLAN"
    );
    let rename = EditTaskCommand {
        execution_date: c.execution_date.clone(),
        ..move_it
    };
    store.edit_task(&rename).await.unwrap();
    let facts = store.execution_history(&c.task_id).await.unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].execution_date, c.execution_date);
    assert!(facts[0].revoked_at.is_none());
    store.close().await;
}

#[tokio::test]
async fn upgrade_from_completion_schema_keeps_history_and_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("v2");
    std::fs::create_dir(&migrations).unwrap();
    std::fs::write(
        migrations.join("0001_capture.sql"),
        include_str!("../migrations/0001_capture.sql"),
    )
    .unwrap();
    std::fs::write(
        migrations.join("0002_completion.sql"),
        include_str!("../migrations/0002_completion.sql"),
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
    let payload = serde_json::to_string(&c).unwrap();
    sqlx::query("INSERT INTO local_profile VALUES(1,?,?)")
        .bind(&owner)
        .bind(&device)
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
    sqlx::query("INSERT INTO domain_events VALUES(?,?,?,'task_captured',?,?)")
        .bind(&c.operation_id)
        .bind(&owner)
        .bind(&c.task_id)
        .bind(&c.occurred_at)
        .bind(&payload)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sync_outbox VALUES(?,?,?,1,'capture_task',?,?)")
        .bind(&c.operation_id)
        .bind(&owner)
        .bind(&device)
        .bind(&payload)
        .bind(&c.occurred_at)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.pending_operations().await.unwrap()[0].payload,
        payload
    );
    assert_eq!(
        store.task_history(&c.task_id).await.unwrap()[0].payload,
        payload
    );
    store.edit_task(&edit(&c)).await.unwrap();
    assert_eq!(store.pending_operations().await.unwrap().len(), 2);
    store.close().await;
}
