use praxis_desktop_lib::store::{
    AddProjectTasksCommand, NewProjectTask, SaveProjectCommand, ScheduleCommand, Store,
};
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn project() -> SaveProjectCommand {
    SaveProjectCommand {
        operation_id: id(),
        project_id: id(),
        expected_version: None,
        name: "发布网站".into(),
        outcome: "让用户能完成报名".into(),
        target_date: None,
        priority: 1,
        occurred_at: "2026-09-17T01:00:00Z".into(),
    }
}
#[tokio::test]
async fn project_tasks_share_identity_with_daily_plan_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let s = Store::open(&path).await.unwrap();
    let p = project();
    s.save_project(&p).await.unwrap();
    s.save_project(&p).await.unwrap();
    let c = AddProjectTasksCommand {
        operation_id: id(),
        project_id: p.project_id.clone(),
        tasks: vec![
            NewProjectTask {
                task_id: id(),
                title: "设计报名页".into(),
            },
            NewProjectTask {
                task_id: id(),
                title: "实现报名".into(),
            },
        ],
        occurred_at: p.occurred_at.clone(),
    };
    s.add_project_tasks(&c).await.unwrap();
    s.add_project_tasks(&c).await.unwrap();
    assert!(s.list_inbox().await.unwrap().is_empty());
    assert_eq!(s.project_tasks(&p.project_id).await.unwrap().len(), 2);
    let schedule = ScheduleCommand {
        operation_id: id(),
        task_id: c.tasks[0].task_id.clone(),
        plan_id: id(),
        expected_version: 0,
        execution_date: "2026-09-17".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: p.occurred_at.clone(),
    };
    s.schedule_task(&schedule).await.unwrap();
    s.close().await;
    let s = Store::open(&path).await.unwrap();
    assert_eq!(s.list_projects().await.unwrap()[0].outcome, p.outcome);
    let daily = s.list_day("2026-09-17").await.unwrap();
    assert_eq!(daily[0].task_id, c.tasks[0].task_id);
    assert_eq!(daily[0].project_id, Some(p.project_id.clone()));
    assert_eq!(s.project_tasks(&p.project_id).await.unwrap().len(), 2);
    assert_eq!(s.pending_operations().await.unwrap().len(), 3);
    s.close().await;
}

#[tokio::test]
async fn assigning_existing_task_preserves_history_and_rejects_stale_changes() {
    use praxis_desktop_lib::store::{AssignProjectCommand, InboxCommand};
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("a.db")).await.unwrap();
    let p = project();
    s.save_project(&p).await.unwrap();
    let capture = InboxCommand {
        operation_id: id(),
        task_id: id(),
        title: "原始事项".into(),
        occurred_at: p.occurred_at.clone(),
    };
    s.capture_inbox(&capture).await.unwrap();
    let c = AssignProjectCommand {
        operation_id: id(),
        project_id: p.project_id.clone(),
        task_id: capture.task_id.clone(),
        expected_version: 0,
        occurred_at: p.occurred_at.clone(),
    };
    s.assign_project(&c).await.unwrap();
    s.assign_project(&c).await.unwrap();
    assert!(s.list_inbox().await.unwrap().is_empty());
    assert_eq!(
        s.project_tasks(&p.project_id).await.unwrap()[0].task_id,
        capture.task_id
    );
    assert_eq!(s.task_history(&capture.task_id).await.unwrap().len(), 2);
    let mut stale = c.clone();
    stale.operation_id = id();
    assert_eq!(
        s.assign_project(&stale).await.unwrap_err(),
        "STATE_CONFLICT"
    );
    let mut edit = p.clone();
    edit.operation_id = id();
    edit.expected_version = Some(0);
    edit.name = "新名称".into();
    s.save_project(&edit).await.unwrap();
    edit.operation_id = id();
    assert_eq!(s.save_project(&edit).await.unwrap_err(), "STATE_CONFLICT");
    assert_eq!(s.list_projects().await.unwrap()[0].name, "新名称");
    s.close().await;
}

#[tokio::test]
async fn project_batch_failure_rolls_back_tasks_history_and_outbox() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.db");
    let s = Store::open(&path).await.unwrap();
    let p = project();
    s.save_project(&p).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_batch BEFORE INSERT ON sync_outbox WHEN NEW.kind='add_project_tasks' BEGIN SELECT RAISE(ABORT,'failure'); END").execute(&mut db).await.unwrap();
    let c = AddProjectTasksCommand {
        operation_id: id(),
        project_id: p.project_id.clone(),
        tasks: vec![
            NewProjectTask {
                task_id: id(),
                title: "一".into(),
            },
            NewProjectTask {
                task_id: id(),
                title: "二".into(),
            },
        ],
        occurred_at: p.occurred_at.clone(),
    };
    assert!(s.add_project_tasks(&c).await.is_err());
    assert!(s.project_tasks(&p.project_id).await.unwrap().is_empty());
    assert!(s
        .task_history(&c.tasks[0].task_id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(s.pending_operations().await.unwrap().len(), 1);
    sqlx::query("DROP TRIGGER fail_batch")
        .execute(&mut db)
        .await
        .unwrap();
    s.add_project_tasks(&c).await.unwrap();
    assert_eq!(s.project_tasks(&p.project_id).await.unwrap().len(), 2);
    s.close().await;
}
#[tokio::test]
async fn missing_project_cannot_take_a_task_or_create_partial_batch() {
    use praxis_desktop_lib::store::{AssignProjectCommand, InboxCommand};
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("missing.db")).await.unwrap();
    let p = project();
    let c = InboxCommand {
        operation_id: id(),
        task_id: id(),
        title: "保留在收件箱".into(),
        occurred_at: p.occurred_at.clone(),
    };
    s.capture_inbox(&c).await.unwrap();
    let assignment = AssignProjectCommand {
        operation_id: id(),
        project_id: p.project_id.clone(),
        task_id: c.task_id.clone(),
        expected_version: 0,
        occurred_at: p.occurred_at.clone(),
    };
    assert!(s.assign_project(&assignment).await.is_err());
    assert_eq!(s.list_inbox().await.unwrap()[0].version, 0);
    assert_eq!(s.task_history(&c.task_id).await.unwrap().len(), 1);
    s.close().await;
}

#[tokio::test]
async fn project_query_exposes_actual_completion_day_separately_from_plan() {
    use praxis_desktop_lib::store::CompletionCommand;
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("complete.db")).await.unwrap();
    let p = project();
    s.save_project(&p).await.unwrap();
    let c = AddProjectTasksCommand {
        operation_id: id(),
        project_id: p.project_id.clone(),
        tasks: vec![NewProjectTask {
            task_id: id(),
            title: "跨日完成".into(),
        }],
        occurred_at: p.occurred_at.clone(),
    };
    s.add_project_tasks(&c).await.unwrap();
    let schedule = ScheduleCommand {
        operation_id: id(),
        task_id: c.tasks[0].task_id.clone(),
        plan_id: id(),
        expected_version: 0,
        execution_date: "2026-09-16".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: p.occurred_at.clone(),
    };
    s.schedule_task(&schedule).await.unwrap();
    s.change_completion(&CompletionCommand {
        operation_id: id(),
        task_id: schedule.task_id.clone(),
        plan_id: schedule.plan_id.clone(),
        expected_version: 1,
        action: "complete".into(),
        completion_id: None,
        execution_date: "2026-09-17".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: p.occurred_at.clone(),
    })
    .await
    .unwrap();
    let rows = s.project_tasks(&p.project_id).await.unwrap();
    assert_eq!(rows[0].execution_date.as_deref(), Some("2026-09-16"));
    assert_eq!(rows[0].completion_date.as_deref(), Some("2026-09-17"));
    assert_eq!(rows[0].status, "completed");
    s.close().await;
}
