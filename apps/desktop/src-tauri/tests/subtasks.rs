use praxis_desktop_lib::store::{
    AddProjectTasksCommand, AddSubtasksCommand, CaptureCommand, NewProjectTask, SaveProjectCommand,
    ScheduleCommand, Store,
};
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
#[tokio::test]
async fn nested_subtasks_keep_identity_and_summary_parent_cannot_be_scheduled() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("tree.db");
    let s = Store::open(&path).await.unwrap();
    let at = "2026-09-19T01:00:00Z".to_string();
    let project = id();
    let parent = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: project.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "结果".into(),
        target_date: None,
        priority: 1,
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.add_project_tasks(&AddProjectTasksCommand {
        operation_id: id(),
        project_id: project.clone(),
        tasks: vec![NewProjectTask {
            task_id: parent.clone(),
            title: "父任务".into(),
        }],
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    let c = AddSubtasksCommand {
        operation_id: id(),
        parent_task_id: parent.clone(),
        expected_version: 0,
        confirm_summary_plan: false,
        tasks: vec![NewProjectTask {
            task_id: id(),
            title: "子任务".into(),
        }],
        occurred_at: at.clone(),
    };
    s.add_subtasks(&c).await.unwrap();
    s.add_subtasks(&c).await.unwrap();
    let nested = AddSubtasksCommand {
        operation_id: id(),
        parent_task_id: c.tasks[0].task_id.clone(),
        expected_version: 0,
        confirm_summary_plan: false,
        tasks: vec![NewProjectTask {
            task_id: id(),
            title: "叶子".into(),
        }],
        occurred_at: at.clone(),
    };
    s.add_subtasks(&nested).await.unwrap();
    let schedule = ScheduleCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: id(),
        expected_version: 1,
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at,
    };
    assert!(s.schedule_task(&schedule).await.is_err());
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    assert_eq!(s.task_details(&parent).await.unwrap().version, 1);
    s.close().await;
    let s = Store::open(&path).await.unwrap();
    let rows = s.project_tasks(&project).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .find(|r| r.task_id == nested.tasks[0].task_id)
            .unwrap()
            .parent_task_id,
        Some(c.tasks[0].task_id.clone())
    );
    s.close().await;
}

#[tokio::test]
async fn splitting_scheduled_parent_requires_confirmation_and_preserves_plan_history() {
    use praxis_desktop_lib::store::{AssignProjectCommand, CompletionCommand};
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("scheduled.db")).await.unwrap();
    let at = "2026-09-19T01:00:00Z".to_string();
    let project = id();
    let parent = id();
    let plan = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: project.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "".into(),
        target_date: None,
        priority: 1,
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: plan.clone(),
        title: "已安排父项".into(),
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.assign_project(&AssignProjectCommand {
        operation_id: id(),
        project_id: project.clone(),
        task_id: parent.clone(),
        expected_version: 0,
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    let mut c = AddSubtasksCommand {
        operation_id: id(),
        parent_task_id: parent.clone(),
        expected_version: 1,
        confirm_summary_plan: false,
        tasks: vec![NewProjectTask {
            task_id: id(),
            title: "执行叶子".into(),
        }],
        occurred_at: at.clone(),
    };
    assert_eq!(
        s.add_subtasks(&c).await.unwrap_err(),
        "SUMMARY_CONFIRMATION_REQUIRED"
    );
    assert_eq!(s.project_tasks(&project).await.unwrap().len(), 1);
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 1);
    c.confirm_summary_plan = true;
    s.add_subtasks(&c).await.unwrap();
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    assert_eq!(s.day_load("2026-09-19").await.unwrap().unknown_count, 0);
    assert!(
        s.project_tasks(&project)
            .await
            .unwrap()
            .iter()
            .find(|t| t.task_id == parent)
            .unwrap()
            .has_summary_plan
    );
    assert_eq!(s.task_history(&parent).await.unwrap().len(), 3);
    assert_eq!(
        s.change_completion(&CompletionCommand {
            operation_id: id(),
            task_id: parent,
            plan_id: plan,
            action: "complete".into(),
            expected_version: 2,
            completion_id: None,
            execution_date: "2026-09-19".into(),
            time_zone: "Asia/Hong_Kong".into(),
            occurred_at: at
        })
        .await
        .unwrap_err(),
        "SUMMARY_TASK"
    );
    s.close().await;
}
#[tokio::test]
async fn last_write_failure_rolls_back_split_and_parent_plan_conversion() {
    use sqlx::Connection;
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("rollback.db");
    let s = Store::open(&path).await.unwrap();
    let at = "2026-09-19T01:00:00Z".to_string();
    let project = id();
    let parent = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: project.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "".into(),
        target_date: None,
        priority: 1,
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.add_project_tasks(&AddProjectTasksCommand {
        operation_id: id(),
        project_id: project.clone(),
        tasks: vec![NewProjectTask {
            task_id: parent.clone(),
            title: "父".into(),
        }],
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    s.schedule_task(&ScheduleCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: id(),
        expected_version: 0,
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_split BEFORE INSERT ON sync_outbox WHEN NEW.kind='add_subtasks' BEGIN SELECT RAISE(ABORT,'failure'); END").execute(&mut db).await.unwrap();
    let c = AddSubtasksCommand {
        operation_id: id(),
        parent_task_id: parent.clone(),
        expected_version: 1,
        confirm_summary_plan: true,
        tasks: vec![NewProjectTask {
            task_id: id(),
            title: "子".into(),
        }],
        occurred_at: at,
    };
    assert!(s.add_subtasks(&c).await.is_err());
    assert_eq!(s.project_tasks(&project).await.unwrap().len(), 1);
    assert_eq!(s.task_details(&parent).await.unwrap().version, 1);
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 1);
    assert!(s
        .task_history(&c.tasks[0].task_id)
        .await
        .unwrap()
        .is_empty());
    sqlx::query("DROP TRIGGER fail_split")
        .execute(&mut db)
        .await
        .unwrap();
    s.add_subtasks(&c).await.unwrap();
    assert_eq!(s.project_tasks(&project).await.unwrap().len(), 2);
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    s.close().await;
}

#[tokio::test]
async fn finished_children_can_complete_the_parent_on_the_day_list() {
    use praxis_desktop_lib::store::CompletionCommand;
    use sqlx::Connection;
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("finished-children.db");
    let s = Store::open(&path).await.unwrap();
    let at = "2026-09-19T01:00:00Z".to_string();
    let parent = id();
    let plan = id();
    let child = id();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: plan.clone(),
        title: "父任务".into(),
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at.clone(),
    })
    .await
    .unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    let owner: String =
        sqlx::query_scalar("SELECT owner_id FROM local_profile WHERE singleton=1")
            .fetch_one(&mut db)
            .await
            .unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,parent_task_id,status,source,created_at) VALUES(?,?,?,?,'todo','temporary',?)")
        .bind(&child)
        .bind(&owner)
        .bind("子任务")
        .bind(&parent)
        .bind(&at)
        .execute(&mut db)
        .await
        .unwrap();
    let command = |action: &str| CompletionCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: plan.clone(),
        action: action.into(),
        expected_version: 0,
        completion_id: None,
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: at.clone(),
    };
    assert_eq!(
        s.change_completion(&command("complete")).await.unwrap_err(),
        "SUMMARY_TASK"
    );
    sqlx::query("UPDATE tasks SET status='completed' WHERE id=?")
        .bind(&child)
        .execute(&mut db)
        .await
        .unwrap();
    let done = s.change_completion(&command("complete")).await.unwrap();
    assert_eq!(done.status, "completed");
    assert_eq!(s.list_day("2026-09-19").await.unwrap()[0].status, "completed");
    s.close().await;
}
