use praxis_desktop_lib::store::{CaptureCommand, PlanChange, PlanCommand, Store};
use uuid::Uuid;
#[tokio::test]
async fn focus_and_estimate_persist_without_duplicating_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let store = Store::open(&path).await.unwrap();
    let c = CaptureCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        plan_id: Uuid::new_v4().to_string(),
        title: "重点任务".into(),
        execution_date: "2026-09-17".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-09-17T01:00:00Z".into(),
    };
    store.capture(&c).await.unwrap();
    let cmd = PlanCommand {
        habit_changes: vec![],
        operation_id: Uuid::new_v4().to_string(),
        date: c.execution_date.clone(),
        occurred_at: c.occurred_at.clone(),
        changes: vec![PlanChange {
            task_id: c.task_id.clone(),
            plan_id: c.plan_id.clone(),
            expected_version: 0,
            is_focus: true,
            estimated_minutes: Some(45),
            focus_rank: 1,
            day_period: Some("afternoon".into()),
            day_rank: Some(2),
        }],
    };
    store.update_plan(&cmd).await.unwrap();
    store.update_plan(&cmd).await.unwrap();
    store.close().await;
    let store = Store::open(&path).await.unwrap();
    let rows = store.list_day(&c.execution_date).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].is_focus);
    assert_eq!(rows[0].estimated_minutes, Some(45));
    assert_eq!(rows[0].version, 1);
    assert_eq!(rows[0].day_period, "afternoon");
    assert_eq!(rows[0].day_rank, 2);
    assert_eq!(store.pending_operations().await.unwrap().len(), 2);
    store.close().await;
}

#[tokio::test]
async fn inbox_stays_unscheduled_until_explicit_assignment() {
    use praxis_desktop_lib::store::{InboxCommand, ScheduleCommand};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("inbox.db")).await.unwrap();
    let c = InboxCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        title: "随手记录".into(),
        occurred_at: "2026-09-17T01:00:00Z".into(),
    };
    store.capture_inbox(&c).await.unwrap();
    store.capture_inbox(&c).await.unwrap();
    assert!(store.list_day("2026-09-17").await.unwrap().is_empty());
    assert_eq!(store.list_inbox().await.unwrap().len(), 1);
    let schedule = ScheduleCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: c.task_id.clone(),
        plan_id: Uuid::new_v4().to_string(),
        expected_version: 0,
        execution_date: "2026-09-18".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: c.occurred_at.clone(),
    };
    store.schedule_task(&schedule).await.unwrap();
    store.schedule_task(&schedule).await.unwrap();
    assert!(store.list_inbox().await.unwrap().is_empty());
    let tasks = store.list_day("2026-09-18").await.unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].task_id, c.task_id);
    assert_eq!(store.pending_operations().await.unwrap().len(), 2);
    store.close().await;
}

#[tokio::test]
async fn load_keeps_unknown_estimates_and_capacity_zero_distinct() {
    use praxis_desktop_lib::store::CapacityCommand;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("load.db");
    let store = Store::open(&path).await.unwrap();
    for n in 0..2 {
        store
            .capture(&CaptureCommand {
                operation_id: Uuid::new_v4().to_string(),
                task_id: Uuid::new_v4().to_string(),
                plan_id: Uuid::new_v4().to_string(),
                title: format!("task {n}"),
                execution_date: "2026-09-17".into(),
                time_zone: "Asia/Hong_Kong".into(),
                occurred_at: "2026-09-17T01:00:00Z".into(),
            })
            .await
            .unwrap();
    }
    let before = store.day_load("2026-09-17").await.unwrap();
    assert_eq!(before.unknown_count, 2);
    assert_eq!(before.capacity_minutes, None);
    let rows = store.list_day("2026-09-17").await.unwrap();
    let cmd = PlanCommand {
        habit_changes: vec![],
        operation_id: Uuid::new_v4().to_string(),
        date: "2026-09-17".into(),
        occurred_at: "2026-09-17T01:00:00Z".into(),
        changes: vec![PlanChange {
            task_id: rows[0].task_id.clone(),
            plan_id: rows[0].plan_id.clone(),
            expected_version: 0,
            is_focus: true,
            focus_rank: 1,
            day_period: None,
            day_rank: None,
            estimated_minutes: Some(45),
        }],
    };
    store.update_plan(&cmd).await.unwrap();
    let capacity = CapacityCommand {
        operation_id: Uuid::new_v4().to_string(),
        date: cmd.date.clone(),
        occurred_at: cmd.occurred_at.clone(),
        expected_version: 0,
        minutes: Some(0),
    };
    store.set_capacity(&capacity).await.unwrap();
    store.set_capacity(&capacity).await.unwrap();
    store.close().await;
    let store = Store::open(&path).await.unwrap();
    let load = store.day_load("2026-09-17").await.unwrap();
    assert_eq!(load.estimated_minutes, 45);
    assert_eq!(load.unknown_count, 1);
    assert_eq!(load.capacity_minutes, Some(0));
    assert_eq!(load.capacity_version, 1);
    assert_eq!(store.list_day("2026-09-17").await.unwrap().len(), 2);
    let stale = CapacityCommand {
        operation_id: Uuid::new_v4().to_string(),
        minutes: Some(60),
        ..capacity
    };
    assert_eq!(
        store.set_capacity(&stale).await.unwrap_err(),
        "STATE_CONFLICT"
    );
    store.close().await;
}
#[tokio::test]
async fn batch_focus_reorder_rolls_back_all_changes_if_one_version_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sort.db")).await.unwrap();
    for title in ["a", "b"] {
        store
            .capture(&CaptureCommand {
                operation_id: Uuid::new_v4().to_string(),
                task_id: Uuid::new_v4().to_string(),
                plan_id: Uuid::new_v4().to_string(),
                title: title.into(),
                execution_date: "2026-09-17".into(),
                time_zone: "Asia/Hong_Kong".into(),
                occurred_at: "2026-09-17T01:00:00Z".into(),
            })
            .await
            .unwrap();
    }
    let rows = store.list_day("2026-09-17").await.unwrap();
    let mut changes: Vec<PlanChange> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| PlanChange {
            task_id: r.task_id.clone(),
            plan_id: r.plan_id.clone(),
            expected_version: 0,
            is_focus: true,
            focus_rank: i as i64,
            day_period: Some("evening".into()),
            day_rank: Some(i as i64 + 1),
            estimated_minutes: None,
        })
        .collect();
    changes[1].expected_version = 99;
    let mut cmd = PlanCommand {
        habit_changes: vec![],
        operation_id: Uuid::new_v4().to_string(),
        date: "2026-09-17".into(),
        occurred_at: "2026-09-17T01:00:00Z".into(),
        changes,
    };
    assert_eq!(store.update_plan(&cmd).await.unwrap_err(), "STATE_CONFLICT");
    assert!(store
        .list_day(&cmd.date)
        .await
        .unwrap()
        .iter()
        .all(|r| !r.is_focus && r.version == 0));
    assert!(store
        .list_day(&cmd.date)
        .await
        .unwrap()
        .iter()
        .all(|r| r.day_period == "morning" && r.day_rank == 0));
    assert_eq!(store.pending_operations().await.unwrap().len(), 2);
    cmd.changes[1].expected_version = 0;
    store.update_plan(&cmd).await.unwrap();
    assert!(store
        .list_day(&cmd.date)
        .await
        .unwrap()
        .iter()
        .all(|r| r.is_focus && r.version == 1));
    assert!(store
        .list_day(&cmd.date)
        .await
        .unwrap()
        .iter()
        .all(|r| r.day_period == "evening" && r.day_rank > 0));
    store.close().await;
}
#[tokio::test]
async fn inbox_last_write_failure_does_not_leave_orphan_task() {
    use praxis_desktop_lib::store::InboxCommand;
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fail.db");
    let store = Store::open(&path).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_inbox BEFORE INSERT ON sync_outbox WHEN NEW.kind='capture_inbox' BEGIN SELECT RAISE(ABORT,'test failure'); END").execute(&mut db).await.unwrap();
    let cmd = InboxCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        title: "retry".into(),
        occurred_at: "2026-09-17T01:00:00Z".into(),
    };
    assert!(store.capture_inbox(&cmd).await.is_err());
    assert!(store.list_inbox().await.unwrap().is_empty());
    assert!(store.task_history(&cmd.task_id).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER fail_inbox")
        .execute(&mut db)
        .await
        .unwrap();
    store.capture_inbox(&cmd).await.unwrap();
    assert_eq!(store.list_inbox().await.unwrap().len(), 1);
    store.close().await;
}
