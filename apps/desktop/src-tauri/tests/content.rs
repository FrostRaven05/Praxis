use praxis_desktop_lib::store::{
    backup, CompletionCommand, ContentAction, ContentCommand, Link, NewProject, Output,
    ScheduleCommand, Store,
};
use serde_json::Value;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(action: ContentAction) -> ContentCommand {
    ContentCommand {
        operation_id: id(),
        occurred_at: "2026-10-08T02:00:00Z".into(),
        action,
    }
}
fn capture() -> ContentCommand {
    command(ContentAction::Capture {
        id: id(),
        raw_text: "  原文\n两个任务与证据  ".into(),
    })
}
fn capture_id(c: &ContentCommand) -> String {
    match &c.action {
        ContentAction::Capture { id, .. } => id.clone(),
        _ => panic!(),
    }
}
fn resolve(c: &ContentCommand) -> ContentCommand {
    command(ContentAction::Resolve {
        capture_id: capture_id(c),
        expected_version: 0,
        outputs: vec![
            Output {
                id: id(),
                kind: "task".into(),
                title: "写初稿".into(),
                body: "任务说明".into(),
            },
            Output {
                id: id(),
                kind: "task".into(),
                title: "校对".into(),
                body: "".into(),
            },
            Output {
                id: id(),
                kind: "record".into(),
                title: "证据".into(),
                body: "独立正文".into(),
            },
        ],
        project_id: None,
        new_project: Some(NewProject {
            id: id(),
            name: "发布文章".into(),
        }),
    })
}
fn array_len(v: &Value, key: &str) -> usize {
    v[key].as_array().unwrap().len()
}

#[tokio::test]
async fn gantt_changes_protect_outputs_even_without_task_version_change() {
    use praxis_desktop_lib::store::{ScheduleEntry, WorkspaceAction, WorkspaceCommand};
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    let project = s.list_projects().await.unwrap().remove(0);
    let tasks = s.project_tasks(&project.id).await.unwrap();
    s.project_workspace(&WorkspaceCommand {
        operation_id: id(),
        occurred_at: c.occurred_at.clone(),
        action: WorkspaceAction::Schedule {
            project_id: project.id.clone(),
            expected_plan_version: project.plan_version,
            entries: tasks
                .iter()
                .map(|t| ScheduleEntry {
                    task_id: t.task_id.clone(),
                    start: Some("2026-10-08".into()),
                    end: Some("2026-10-09".into()),
                    dependencies: vec![],
                })
                .collect(),
        },
    })
    .await
    .unwrap();
    assert!(s
        .content_command(&command(ContentAction::Undo {
            resolution_id: r.operation_id,
            keep_outputs: false
        }))
        .await
        .unwrap_err()
        .starts_with("USER:"));
    assert_eq!(
        s.project_tasks(&project.id).await.unwrap()[0]
            .planned_start
            .as_deref(),
        Some("2026-10-08")
    );
    s.close().await;
}

#[tokio::test]
async fn failed_outbox_insert_rolls_back_capture_and_event() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let s = Store::open(&path).await.unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER reject_content BEFORE INSERT ON sync_outbox WHEN NEW.kind='content' BEGIN SELECT RAISE(ABORT,'simulated failure'); END").execute(&pool).await.unwrap();
    let c = capture();
    assert!(s.content_command(&c).await.is_err());
    let d = s.content_snapshot().await.unwrap();
    assert_eq!(array_len(&d, "captures"), 0);
    assert_eq!(array_len(&d, "events"), 0);
    sqlx::query("DROP TRIGGER reject_content")
        .execute(&pool)
        .await
        .unwrap();
    s.content_command(&c).await.unwrap();
    assert_eq!(
        array_len(&s.content_snapshot().await.unwrap(), "captures"),
        1
    );
    pool.close().await;
    s.close().await;
}

#[tokio::test]
async fn resolve_is_atomic_idempotent_and_preserves_source_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let s = Store::open(&path).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    s.content_command(&r).await.unwrap();
    let snapshot = s.content_snapshot().await.unwrap();
    assert_eq!(array_len(&snapshot, "tasks"), 2);
    assert_eq!(array_len(&snapshot, "records"), 1);
    assert_eq!(
        snapshot["captures"][0]["rawText"],
        "  原文\n两个任务与证据  "
    );
    assert_eq!(snapshot["records"][0]["sourceCaptureId"], capture_id(&c));
    assert_eq!(snapshot["records"][0]["links"][0]["targetType"], "project");
    assert_eq!(s.pending_operations().await.unwrap().len(), 2);
    s.close().await;
    let s = Store::open(&path).await.unwrap();
    assert_eq!(s.content_snapshot().await.unwrap(), snapshot);
    s.close().await;
}
#[tokio::test]
async fn invalid_output_rolls_back_project_capture_and_all_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let mut r = resolve(&c);
    if let ContentAction::Resolve { outputs, .. } = &mut r.action {
        outputs[1].title = "".into();
    }
    assert!(s.content_command(&r).await.is_err());
    let d = s.content_snapshot().await.unwrap();
    assert_eq!(d["captures"][0]["state"], "pending");
    assert_eq!(array_len(&d, "tasks"), 0);
    assert!(s.list_projects().await.unwrap().is_empty());
    assert_eq!(s.pending_operations().await.unwrap().len(), 1);
    s.close().await;
}
#[tokio::test]
async fn undo_removes_only_unedited_outputs_and_can_preserve_edited_records() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    let d = s.content_snapshot().await.unwrap();
    let record = d["records"][0]["id"].as_str().unwrap();
    s.content_command(&command(ContentAction::Record {
        id: record.into(),
        expected_version: Some(0),
        title: "改过的证据".into(),
        body: "不能丢失".into(),
        record_type: "evidence".into(),
        links: vec![],
    }))
    .await
    .unwrap();
    assert!(s
        .content_command(&command(ContentAction::Undo {
            resolution_id: r.operation_id.clone(),
            keep_outputs: false
        }))
        .await
        .unwrap_err()
        .starts_with("USER:"));
    let undo = command(ContentAction::Undo {
        resolution_id: r.operation_id,
        keep_outputs: true,
    });
    s.content_command(&undo).await.unwrap();
    s.content_command(&undo).await.unwrap();
    let d = s.content_snapshot().await.unwrap();
    assert_eq!(d["captures"][0]["retainedOutputs"], 1);
    assert_eq!(d["records"][0]["body"], "不能丢失");
    assert_eq!(array_len(&d, "tasks"), 2);
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    s.content_command(&command(ContentAction::Undo {
        resolution_id: r.operation_id,
        keep_outputs: false,
    }))
    .await
    .unwrap();
    assert_eq!(array_len(&s.content_snapshot().await.unwrap(), "tasks"), 2);
    assert_eq!(s.list_projects().await.unwrap().len(), 2);
    s.close().await;
}
#[tokio::test]
async fn next_action_clear_and_resume_survive_completion_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let s = Store::open(&path).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    let d = s.content_snapshot().await.unwrap();
    let task = d["tasks"][0]["id"].as_str().unwrap().to_string();
    let project = d["tasks"][0]["projectId"].as_str().unwrap().to_string();
    let context = command(ContentAction::Context {
        project_id: project.clone(),
        expected_version: None,
        definition_of_done: "文章发布".into(),
        blocker_text: "".into(),
        review_date: Some("2026-10-09".into()),
        next_action_task_id: Some(task.clone()),
        last_context: "整理完材料".into(),
        restart_hint: "打开草稿".into(),
        waiting_note: "等反馈".into(),
    });
    s.content_command(&context).await.unwrap();
    let plan = id();
    s.schedule_task(&ScheduleCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: plan.clone(),
        expected_version: 0,
        execution_date: "2026-10-08".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: context.occurred_at.clone(),
    })
    .await
    .unwrap();
    s.change_completion(&CompletionCommand {
        operation_id: id(),
        task_id: task,
        plan_id: plan,
        action: "complete".into(),
        expected_version: 1,
        completion_id: None,
        execution_date: "2026-10-08".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: context.occurred_at,
    })
    .await
    .unwrap();
    let d = s.content_snapshot().await.unwrap();
    assert!(d["contexts"][0]["nextActionTaskId"].is_null());
    assert_eq!(d["contexts"][0]["nextActionCleared"], 1);
    assert_eq!(d["contexts"][0]["restartHint"], "打开草稿");
    s.close().await;
    let s = Store::open(&path).await.unwrap();
    assert_eq!(
        s.content_snapshot().await.unwrap()["contexts"],
        d["contexts"]
    );
    s.close().await;
}
#[tokio::test]
async fn record_links_validate_ownership_and_unlink_preserves_body() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    let d = s.content_snapshot().await.unwrap();
    let record = d["records"][0]["id"].as_str().unwrap().to_string();
    let mut edit = command(ContentAction::Record {
        id: record,
        expected_version: Some(0),
        title: "".into(),
        body: "正文只存一份".into(),
        record_type: "note".into(),
        links: vec![Link {
            target_type: "task".into(),
            target_id: id(),
        }],
    });
    assert!(s.content_command(&edit).await.is_err());
    if let ContentAction::Record { links, .. } = &mut edit.action {
        *links = d["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| Link {
                target_type: "task".into(),
                target_id: t["id"].as_str().unwrap().into(),
            })
            .collect()
    };
    s.content_command(&edit).await.unwrap();
    let d = s.content_snapshot().await.unwrap();
    assert_eq!(d["records"][0]["links"].as_array().unwrap().len(), 2);
    edit.operation_id = id();
    if let ContentAction::Record {
        expected_version,
        links,
        ..
    } = &mut edit.action
    {
        *expected_version = Some(1);
        links.pop();
    }
    s.content_command(&edit).await.unwrap();
    assert_eq!(
        s.content_snapshot().await.unwrap()["records"][0]["body"],
        "正文只存一份"
    );
    s.close().await;
}
#[tokio::test]
async fn backup_restore_preserves_history_outbox_and_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let s = Store::open(&path).await.unwrap();
    let c = capture();
    s.content_command(&c).await.unwrap();
    let r = resolve(&c);
    s.content_command(&r).await.unwrap();
    let before = s.content_snapshot().await.unwrap();
    let pending = s.pending_operations().await.unwrap().len();
    s.create_backup(dir.path()).await.unwrap();
    s.content_command(&capture()).await.unwrap();
    let backups = backup::list_backups(dir.path()).unwrap();
    let restored = backup::prepare_restore(dir.path(), &backups[0].name)
        .await
        .unwrap();
    assert_ne!(std::path::Path::new(&restored), path);
    assert_eq!(
        backup::selected_database(dir.path()),
        std::path::PathBuf::from(&restored)
    );
    let copy = Store::open(std::path::Path::new(&restored)).await.unwrap();
    assert_eq!(copy.content_snapshot().await.unwrap(), before);
    assert_eq!(copy.pending_operations().await.unwrap().len(), pending);
    assert_eq!(
        array_len(&s.content_snapshot().await.unwrap(), "captures"),
        2
    );
    assert!(backup::prepare_restore(dir.path(), "../praxis.db")
        .await
        .is_err());
    copy.close().await;
    let second = backup::prepare_restore(dir.path(), &backups[0].name)
        .await
        .unwrap();
    assert_eq!(
        backup::selected_database(dir.path()),
        std::path::PathBuf::from(second)
    );
    s.close().await;
}
#[tokio::test]
async fn unicode_and_stale_version_rejection_do_not_mutate_data() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let record = id();
    let c = command(ContentAction::Record {
        id: record,
        expected_version: None,
        title: "😀".repeat(500),
        body: "".into(),
        record_type: "note".into(),
        links: vec![],
    });
    s.content_command(&c).await.unwrap();
    let mut stale = c.clone();
    stale.operation_id = id();
    if let ContentAction::Record {
        expected_version,
        body,
        ..
    } = &mut stale.action
    {
        *expected_version = Some(8);
        *body = "过期内容".into()
    }
    assert!(s.content_command(&stale).await.is_err());
    let mut long = c;
    long.operation_id = id();
    if let ContentAction::Record { title, .. } = &mut long.action {
        title.push('字')
    }
    assert!(s.content_command(&long).await.is_err());
    assert_eq!(
        array_len(&s.content_snapshot().await.unwrap(), "records"),
        1
    );
    s.close().await;
}

#[tokio::test]
async fn old_schema_upgrade_backups_include_wal_and_restore_can_upgrade_copy() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("old-migrations");
    std::fs::create_dir(&migrations).unwrap();
    for entry in
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
    {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy()[..4].parse::<i64>().unwrap() >= 10 {
            continue;
        }
        std::fs::copy(entry.path(), migrations.join(entry.file_name())).unwrap();
    }
    let path = dir.path().join("praxis.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
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
    let owner = id();
    let device = id();
    let task = id();
    sqlx::query("INSERT INTO local_profile VALUES(1,?,?)")
        .bind(&owner)
        .bind(&device)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at) VALUES(?,?,'旧任务','temporary','2026-10-01T00:00:00Z')").bind(&task).bind(&owner).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO sync_outbox VALUES(?,?,?,1,'capture_inbox','{}','2026-10-01T00:00:00Z')",
    )
    .bind(id())
    .bind(&owner)
    .bind(&device)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    // Refuse an upgrade when the backup destination cannot be created.
    std::fs::write(dir.path().join("backups"), "blocked destination").unwrap();
    assert!(Store::open(&path).await.is_err());
    std::fs::remove_file(dir.path().join("backups")).unwrap();
    let store = Store::open(&path).await.unwrap();
    assert_eq!(store.list_inbox().await.unwrap()[0].title, "旧任务");
    let backups = backup::list_backups(dir.path()).unwrap();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].name.contains("before-upgrade"));
    let restored = backup::prepare_restore(dir.path(), &backups[0].name)
        .await
        .unwrap();
    let restored = Store::open(std::path::Path::new(&restored)).await.unwrap();
    assert_eq!(restored.list_inbox().await.unwrap()[0].task_id, task);
    assert_eq!(restored.pending_operations().await.unwrap().len(), 1);
    restored.close().await;
    store.close().await;
}

#[tokio::test]
async fn interrupted_migration_rolls_back_and_saved_snapshot_restores() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    store.content_command(&capture()).await.unwrap();
    let before = store.content_snapshot().await.unwrap();
    store.create_backup(dir.path()).await.unwrap();
    store.close().await;
    let migrations = dir.path().join("failed-migrations");
    std::fs::create_dir(&migrations).unwrap();
    for entry in
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
    {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), migrations.join(entry.file_name())).unwrap();
    }
    std::fs::write(migrations.join("9999_simulated_failure.sql"),"UPDATE captures SET raw_text='must rollback'; CREATE TABLE partial_upgrade(id INTEGER); INSERT INTO nonexistent_table VALUES(1);").unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert!(sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .is_err());
    pool.close().await;
    let reopened = Store::open(&path).await.unwrap();
    assert_eq!(reopened.content_snapshot().await.unwrap(), before);
    reopened.close().await;
    let b = backup::list_backups(dir.path()).unwrap();
    let recovered = backup::prepare_restore(dir.path(), &b[0].name)
        .await
        .unwrap();
    let restored = Store::open(std::path::Path::new(&recovered)).await.unwrap();
    assert_eq!(restored.content_snapshot().await.unwrap(), before);
    restored.close().await;
}


