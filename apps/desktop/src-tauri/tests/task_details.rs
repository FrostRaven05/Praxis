use praxis_desktop_lib::store::{InboxCommand, ScheduleCommand, Store, TaskDetailsCommand};
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn edit(task_id: String) -> TaskDetailsCommand {
    TaskDetailsCommand {
        operation_id: id(),
        task_id,
        expected_version: 0,
        title: "完整任务".into(),
        notes: "备注\n第二行".into(),
        completion_criteria: "可以验证完成".into(),
        important: true,
        deadline: Some("2026-10-01T02:00:00Z".into()),
        deadline_time_zone: Some("Asia/Hong_Kong".into()),
        estimated_minutes: Some(45),
        occurred_at: "2026-09-19T01:00:00Z".into(),
    }
}
#[tokio::test]
async fn unscheduled_details_survive_restart_and_scheduling_preserves_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("d.db");
    let s = Store::open(&path).await.unwrap();
    let task = id();
    s.capture_inbox(&InboxCommand {
        operation_id: id(),
        task_id: task.clone(),
        title: "原始标题".into(),
        occurred_at: "2026-09-19T01:00:00Z".into(),
    })
    .await
    .unwrap();
    let c = edit(task.clone());
    s.save_task_details(&c).await.unwrap();
    s.save_task_details(&c).await.unwrap();
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    assert_eq!(s.list_inbox().await.unwrap()[0].title, "完整任务");
    s.close().await;
    let s = Store::open(&path).await.unwrap();
    let d = s.task_details(&task).await.unwrap();
    assert_eq!(d.notes, "备注\n第二行");
    assert_eq!(d.completion_criteria, "可以验证完成");
    assert!(d.important);
    assert_eq!(d.estimated_minutes, Some(45));
    assert_eq!(d.version, 1);
    assert_eq!(d.deadline_time_zone.as_deref(), Some("Asia/Hong_Kong"));
    s.schedule_task(&ScheduleCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: id(),
        expected_version: 1,
        execution_date: "2026-09-20".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: c.occurred_at.clone(),
    })
    .await
    .unwrap();
    let rows = s.list_day("2026-09-20").await.unwrap();
    assert_eq!(rows[0].estimated_minutes, Some(45));
    assert!(rows[0].important);
    assert!(!rows[0].is_focus);
    assert_eq!(s.task_details(&task).await.unwrap().deadline, c.deadline);
    assert_eq!(s.task_history(&task).await.unwrap().len(), 3);
    s.close().await;
}

#[tokio::test]
async fn stale_details_and_failed_outbox_cannot_overwrite_saved_work() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollback.db");
    let s = Store::open(&path).await.unwrap();
    let task = id();
    s.capture_inbox(&InboxCommand {
        operation_id: id(),
        task_id: task.clone(),
        title: "原始".into(),
        occurred_at: "2026-09-19T01:00:00Z".into(),
    })
    .await
    .unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_details BEFORE INSERT ON sync_outbox WHEN NEW.kind='save_task_details' BEGIN SELECT RAISE(ABORT,'failure'); END").execute(&mut db).await.unwrap();
    let c = edit(task.clone());
    assert!(s.save_task_details(&c).await.is_err());
    assert_eq!(s.task_details(&task).await.unwrap().title, "原始");
    assert_eq!(s.task_details(&task).await.unwrap().version, 0);
    assert_eq!(s.task_history(&task).await.unwrap().len(), 1);
    sqlx::query("DROP TRIGGER fail_details")
        .execute(&mut db)
        .await
        .unwrap();
    s.save_task_details(&c).await.unwrap();
    let mut stale = c.clone();
    stale.operation_id = id();
    stale.notes = "旧草稿覆盖".into();
    assert_eq!(
        s.save_task_details(&stale).await.unwrap_err(),
        "STATE_CONFLICT"
    );
    assert_eq!(s.task_details(&task).await.unwrap().notes, c.notes);
    stale.operation_id = c.operation_id.clone();
    assert!(s.save_task_details(&stale).await.is_err());
    assert_eq!(s.pending_operations().await.unwrap().len(), 2);
    s.close().await;
}
#[tokio::test]
async fn editing_completed_details_keeps_completion_facts_and_arrangement_estimate() {
    use praxis_desktop_lib::store::{CaptureCommand, CompletionCommand, PlanChange, PlanCommand};
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("facts.db")).await.unwrap();
    let task = id();
    let plan = id();
    let at = "2026-09-19T01:00:00Z".to_string();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: plan.clone(),
        title: "安排".into(),
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.update_plan(&PlanCommand {
        operation_id: id(),
        date: "2026-09-19".into(),
        occurred_at: at.clone(),
        changes: vec![PlanChange {
            task_id: task.clone(),
            plan_id: plan.clone(),
            expected_version: 0,
            is_focus: true,
            focus_rank: 1,
            day_period: None,
            day_rank: None,
            estimated_minutes: Some(20),
        }],
    })
    .await
    .unwrap();
    let completed = s
        .change_completion(&CompletionCommand {
            operation_id: id(),
            task_id: task.clone(),
            plan_id: plan.clone(),
            action: "complete".into(),
            expected_version: 1,
            completion_id: None,
            execution_date: "2026-09-19".into(),
            time_zone: "Asia/Hong_Kong".into(),
            occurred_at: at,
        })
        .await
        .unwrap();
    let mut c = edit(task.clone());
    c.expected_version = 2;
    c.estimated_minutes = None;
    c.deadline = None;
    c.deadline_time_zone = None;
    s.save_task_details(&c).await.unwrap();
    let rows = s.list_day("2026-09-19").await.unwrap();
    assert_eq!(rows[0].active_completion_id, completed.active_completion_id);
    assert_eq!(rows[0].plan_id, plan);
    assert_eq!(rows[0].estimated_minutes, Some(20));
    assert!(rows[0].is_focus);
    assert_eq!(s.execution_history(&task).await.unwrap().len(), 1);
    assert_eq!(s.task_details(&task).await.unwrap().estimated_minutes, None);
    s.close().await;
}
