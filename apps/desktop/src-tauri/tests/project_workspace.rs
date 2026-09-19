use praxis_desktop_lib::store::*;
use sqlx::Connection;
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
const AT: &str = "2026-09-19T01:00:00Z";
fn command(action: WorkspaceAction) -> WorkspaceCommand {
    WorkspaceCommand {
        operation_id: id(),
        occurred_at: AT.into(),
        action,
    }
}
async fn fixture() -> (tempfile::TempDir, Store, String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.db")).await.unwrap();
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "结果".into(),
        target_date: None,
        priority: 1,
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    let ids = vec![id(), id(), id()];
    s.add_project_tasks(&AddProjectTasksCommand {
        operation_id: id(),
        project_id: p.clone(),
        tasks: ids
            .iter()
            .enumerate()
            .map(|(i, t)| NewProjectTask {
                task_id: t.clone(),
                title: format!("task{i}"),
            })
            .collect(),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    (dir, s, p, ids)
}
async fn revision(s: &Store, p: &str) -> i64 {
    s.list_projects()
        .await
        .unwrap()
        .iter()
        .find(|x| x.id == p)
        .unwrap()
        .plan_version
}
async fn version(s: &Store, t: &str) -> i64 {
    s.task_details(t).await.unwrap().version
}
async fn status(s: &Store, t: &str, state: &str, reason: &str) -> WorkspaceCommand {
    command(WorkspaceAction::Status {
        task_id: t.into(),
        expected_version: version(s, t).await,
        status: state.into(),
        reason: reason.into(),
        date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
    })
}
async fn schedule(s: &Store, t: &str) {
    s.schedule_task(&ScheduleCommand {
        operation_id: id(),
        task_id: t.into(),
        plan_id: id(),
        expected_version: version(s, t).await,
        execution_date: "2026-09-19".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn lifecycle_keeps_or_removes_commitments_without_fabricating_facts() {
    let (_d, s, p, ids) = fixture().await;
    schedule(&s, &ids[0]).await;
    schedule(&s, &ids[1]).await;
    s.project_workspace(&status(&s, &ids[1], "completed", "").await)
        .await
        .unwrap();
    let c = command(WorkspaceAction::Lifecycle {
        project_id: p.clone(),
        expected_version: 0,
        status: "paused".into(),
        focused: true,
        arrangements: "keep".into(),
        date: "2026-09-19".into(),
    });
    s.project_workspace(&c).await.unwrap();
    s.project_workspace(&c).await.unwrap();
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 2);
    assert_eq!(
        s.list_day("2026-09-19").await.unwrap()[0]
            .project_status
            .as_deref(),
        Some("paused")
    );
    let c = command(WorkspaceAction::Lifecycle {
        project_id: p.clone(),
        expected_version: 1,
        status: "archived".into(),
        focused: true,
        arrangements: "remove".into(),
        date: "2026-09-19".into(),
    });
    s.project_workspace(&c).await.unwrap();
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 1);
    assert!(s.execution_history(&ids[0]).await.unwrap().is_empty());
    assert_eq!(s.execution_history(&ids[1]).await.unwrap().len(), 1);
    let stale = command(WorkspaceAction::Lifecycle {
        project_id: p,
        expected_version: 0,
        status: "active".into(),
        focused: false,
        arrangements: "keep".into(),
        date: "2026-09-19".into(),
    });
    assert!(s.project_workspace(&stale).await.is_err());
    // An explicitly rescheduled removed plan is reused, not duplicated.
    schedule(&s, &ids[0]).await;
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 2);
}
#[tokio::test]
async fn board_completion_undo_and_cancel_share_daily_facts_and_survive_reopen() {
    let (d, s, p, ids) = fixture().await;
    s.project_workspace(&status(&s, &ids[0], "in_progress", "").await)
        .await
        .unwrap();
    s.project_workspace(&status(&s, &ids[0], "blocked", "等待资料").await)
        .await
        .unwrap();
    let c = status(&s, &ids[0], "cancelled", "范围变化").await;
    s.project_workspace(&c).await.unwrap();
    s.project_workspace(&status(&s, &ids[0], "restore", "").await)
        .await
        .unwrap();
    let row = s
        .project_tasks(&p)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.task_id == ids[0])
        .unwrap();
    assert_eq!(row.status, "blocked");
    assert_eq!(row.status_reason, "等待资料");
    let c = status(&s, &ids[0], "completed", "").await;
    s.project_workspace(&c).await.unwrap();
    s.project_workspace(&c).await.unwrap();
    assert_eq!(s.execution_history(&ids[0]).await.unwrap().len(), 1);
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 1);
    s.project_workspace(&status(&s, &ids[0], "todo", "").await)
        .await
        .unwrap();
    assert!(s.execution_history(&ids[0]).await.unwrap()[0]
        .revoked_at
        .is_some());
    s.close().await;
    let s = Store::open(&d.path().join("workspace.db")).await.unwrap();
    assert_eq!(s.task_details(&ids[0]).await.unwrap().status, "todo");
}
#[tokio::test]
async fn subtree_move_checks_cycles_converts_parent_and_preserves_identity() {
    let (_d, s, p, ids) = fixture().await;
    schedule(&s, &ids[1]).await;
    let c = command(WorkspaceAction::Move {
        project_id: p.clone(),
        expected_plan_version: revision(&s, &p).await,
        task_id: ids[0].clone(),
        parent_task_id: Some(ids[1].clone()),
        before_task_id: None,
        confirm_summary_plan: false,
    });
    assert!(s.project_workspace(&c).await.is_err());
    assert_eq!(s.list_day("2026-09-19").await.unwrap().len(), 1);
    let mut c = c;
    if let WorkspaceAction::Move {
        confirm_summary_plan,
        ..
    } = &mut c.action
    {
        *confirm_summary_plan = true;
    }
    s.project_workspace(&c).await.unwrap();
    s.project_workspace(&c).await.unwrap();
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    let cycle = command(WorkspaceAction::Move {
        project_id: p.clone(),
        expected_plan_version: revision(&s, &p).await,
        task_id: ids[1].clone(),
        parent_task_id: Some(ids[0].clone()),
        before_task_id: None,
        confirm_summary_plan: true,
    });
    assert!(s.project_workspace(&cycle).await.is_err());
    let reorder = command(WorkspaceAction::Move {
        project_id: p.clone(),
        expected_plan_version: revision(&s, &p).await,
        task_id: ids[2].clone(),
        parent_task_id: None,
        before_task_id: Some(ids[1].clone()),
        confirm_summary_plan: false,
    });
    s.project_workspace(&reorder).await.unwrap();
    let rows = s.project_tasks(&p).await.unwrap();
    assert_eq!(
        rows.iter()
            .find(|r| r.task_id == ids[0])
            .unwrap()
            .parent_task_id,
        Some(ids[1].clone())
    );
    assert_eq!(
        rows.iter().find(|r| r.task_id == ids[2]).unwrap().task_rank,
        0
    );
}
fn entries(ids: &[String]) -> Vec<ScheduleEntry> {
    vec![
        ScheduleEntry {
            task_id: ids[0].clone(),
            start: Some("2026-09-20".into()),
            end: Some("2026-09-21".into()),
            dependencies: vec![],
        },
        ScheduleEntry {
            task_id: ids[1].clone(),
            start: Some("2026-09-22".into()),
            end: Some("2026-09-23".into()),
            dependencies: vec![ids[0].clone()],
        },
        ScheduleEntry {
            task_id: ids[2].clone(),
            start: None,
            end: None,
            dependencies: vec![],
        },
    ]
}
#[tokio::test]
async fn schedule_is_atomic_versioned_and_preserves_daily_dates() {
    let (d, s, p, ids) = fixture().await;
    schedule(&s, &ids[0]).await;
    let base = revision(&s, &p).await;
    let c = command(WorkspaceAction::Schedule {
        project_id: p.clone(),
        expected_plan_version: base,
        entries: entries(&ids),
    });
    s.project_workspace(&c).await.unwrap();
    s.project_workspace(&c).await.unwrap();
    assert_eq!(
        s.list_day("2026-09-19").await.unwrap()[0].execution_date,
        "2026-09-19"
    );
    let mut cyc = entries(&ids);
    cyc[0].dependencies = vec![ids[1].clone()];
    assert!(s
        .project_workspace(&command(WorkspaceAction::Schedule {
            project_id: p.clone(),
            expected_plan_version: base + 1,
            entries: cyc
        }))
        .await
        .is_err());
    let mut changed = entries(&ids);
    changed[0].end = Some("2026-09-20".into());
    let stale = command(WorkspaceAction::Schedule {
        project_id: p.clone(),
        expected_plan_version: base,
        entries: changed.clone(),
    });
    assert!(s.project_workspace(&stale).await.is_err());
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(d.path().join("workspace.db")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_workspace BEFORE INSERT ON sync_outbox WHEN NEW.kind='project_workspace' BEGIN SELECT RAISE(ABORT,'failure'); END").execute(&mut db).await.unwrap();
    let c = command(WorkspaceAction::Schedule {
        project_id: p.clone(),
        expected_plan_version: base + 1,
        entries: changed,
    });
    assert!(s.project_workspace(&c).await.is_err());
    let rows = s.project_tasks(&p).await.unwrap();
    assert_eq!(
        rows.iter()
            .find(|r| r.task_id == ids[0])
            .unwrap()
            .planned_end
            .as_deref(),
        Some("2026-09-21")
    );
    assert_eq!(revision(&s, &p).await, base + 1);
    sqlx::query("DROP TRIGGER fail_workspace")
        .execute(&mut db)
        .await
        .unwrap();
    s.project_workspace(&c).await.unwrap();
    s.close().await;
    let s = Store::open(&d.path().join("workspace.db")).await.unwrap();
    let rows = s.project_tasks(&p).await.unwrap();
    assert_eq!(
        rows.iter()
            .find(|r| r.task_id == ids[1])
            .unwrap()
            .dependencies
            .0,
        vec![ids[0].clone()]
    );
}

#[tokio::test]
async fn predecessors_gate_start_and_completion_and_restore() {
    let (_d, s, p, ids) = fixture().await;
    s.project_workspace(&status(&s, &ids[1], "in_progress", "").await)
        .await
        .unwrap();
    s.project_workspace(&status(&s, &ids[1], "cancelled", "暂缓").await)
        .await
        .unwrap();
    let c = command(WorkspaceAction::Schedule {
        project_id: p.clone(),
        expected_plan_version: revision(&s, &p).await,
        entries: entries(&ids),
    });
    s.project_workspace(&c).await.unwrap();
    assert!(s
        .project_workspace(&status(&s, &ids[1], "restore", "").await)
        .await
        .unwrap_err()
        .contains("前置"));
    assert!(s
        .project_workspace(&status(&s, &ids[1], "completed", "").await)
        .await
        .unwrap_err()
        .contains("前置"));
    s.project_workspace(&status(&s, &ids[0], "completed", "").await)
        .await
        .unwrap();
    s.project_workspace(&status(&s, &ids[1], "restore", "").await)
        .await
        .unwrap();
    assert_eq!(s.task_details(&ids[1]).await.unwrap().status, "in_progress");
}
#[tokio::test]
async fn default_estimate_is_only_inherited_on_first_plan_and_failed_completion_is_atomic() {
    let (d, s, p, ids) = fixture().await;
    s.save_task_details(&TaskDetailsCommand {
        operation_id: id(),
        task_id: ids[0].clone(),
        expected_version: 0,
        title: "带估时任务".into(),
        notes: "".into(),
        completion_criteria: "".into(),
        important: false,
        deadline: None,
        deadline_time_zone: None,
        estimated_minutes: Some(60),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(d.path().join("workspace.db")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_completion BEFORE INSERT ON sync_outbox WHEN NEW.kind='project_workspace' BEGIN SELECT RAISE(ABORT,'failure'); END").execute(&mut db).await.unwrap();
    let c = status(&s, &ids[0], "completed", "").await;
    assert!(s.project_workspace(&c).await.is_err());
    assert!(s.list_day("2026-09-19").await.unwrap().is_empty());
    assert!(s.execution_history(&ids[0]).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER fail_completion")
        .execute(&mut db)
        .await
        .unwrap();
    s.project_workspace(&c).await.unwrap();
    let daily = s.list_day("2026-09-19").await.unwrap().remove(0);
    assert_eq!(daily.estimated_minutes, Some(60));
    s.project_workspace(&status(&s, &ids[0], "todo", "").await)
        .await
        .unwrap();
    s.update_plan(&PlanCommand {
        operation_id: id(),
        date: "2026-09-19".into(),
        occurred_at: AT.into(),
        changes: vec![PlanChange {
            task_id: ids[0].clone(),
            plan_id: daily.plan_id.clone(),
            expected_version: version(&s, &ids[0]).await,
            is_focus: true,
            focus_rank: 0,
            estimated_minutes: Some(90),
        }],
    })
    .await
    .unwrap();
    s.project_workspace(&command(WorkspaceAction::Lifecycle {
        project_id: p,
        expected_version: 0,
        status: "paused".into(),
        focused: false,
        arrangements: "remove".into(),
        date: "2026-09-19".into(),
    }))
    .await
    .unwrap();
    schedule(&s, &ids[0]).await;
    let restored = s.list_day("2026-09-19").await.unwrap().remove(0);
    assert_eq!(restored.plan_id, daily.plan_id);
    assert_eq!(restored.estimated_minutes, Some(90));
}

#[tokio::test]
async fn all_project_states_preserve_task_status_and_completion_history() {
    let (_d, s, p, ids) = fixture().await;
    for (v, state) in [
        "draft",
        "active",
        "paused",
        "completed",
        "archived",
        "active",
    ]
    .iter()
    .enumerate()
    {
        s.project_workspace(&command(WorkspaceAction::Lifecycle {
            project_id: p.clone(),
            expected_version: v as i64,
            status: state.to_string(),
            focused: true,
            arrangements: "keep".into(),
            date: "2026-09-19".into(),
        }))
        .await
        .unwrap();
        assert_eq!(s.list_projects().await.unwrap()[0].status, *state);
        for id in &ids {
            assert_eq!(s.task_details(id).await.unwrap().status, "todo");
            assert!(s.execution_history(id).await.unwrap().is_empty());
        }
    }
}
