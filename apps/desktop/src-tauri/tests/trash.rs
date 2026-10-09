use praxis_desktop_lib::store::*;
use serde_json::json;
use sqlx::Connection;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
async fn fixture() -> (tempfile::TempDir, Store, sqlx::SqliteConnection) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("test.db");
    let s = Store::open(&p).await.unwrap();
    let db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", p.display()))
        .await
        .unwrap();
    (d, s, db)
}
async fn task(s: &Store, title: &str, p: Option<&str>) -> String {
    let t = id();
    let c:ProductivityCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T00:00:00Z","action":{"type":"task","id":t,"expectedVersion":null,"title":title,"notes":"","projectId":p,"plan":null,"deadline":null,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[]}})).unwrap();
    s.productivity_command(&c).await.unwrap();
    t
}
async fn project(s: &Store) -> String {
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-10-09T00:00:00Z".into(),
    })
    .await
    .unwrap();
    p
}
async fn delete(s: &Store, kind: &str, id: &str, mode: &str, confirm: bool) -> TrashCommand {
    let v = s.trash_snapshot().await.unwrap();
    let row = v[if kind == "task" { "tasks" } else { "projects" }]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .unwrap();
    serde_json::from_value(json!({"operationId":self::id(),"occurredAt":"2026-10-09T00:00:00Z","action":{"type":"delete","targetType":kind,"id":id,"expectedVersion":row["version"],"mode":mode,"confirmAll":confirm,"expectedTasks":v["tasks"].as_array().unwrap().iter().map(|t|json!([t["id"],t["version"]])).collect::<Vec<_>>()}})).unwrap()
}
async fn restore(s: &Store, batch: &str) {
    let c:TrashCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T01:00:00Z","action":{"type":"restore","batchId":batch}})).unwrap();
    s.trash_command(&c).await.unwrap();
}
async fn parent(db: &mut sqlx::SqliteConnection, child: &str, parent: &str) {
    sqlx::query("UPDATE tasks SET parent_task_id=?,version=version+1 WHERE id=?")
        .bind(parent)
        .bind(child)
        .execute(db)
        .await
        .unwrap();
}
#[tokio::test]
async fn cascade_is_atomic_idempotent_and_restores_parent_tree() {
    let (_d, s, mut db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "父", Some(&p)).await;
    let b = task(&s, "子", Some(&p)).await;
    parent(&mut db, &b, &a).await;
    let c = delete(&s, "task", &a, "cascade", false).await;
    s.trash_command(&c).await.unwrap();
    s.trash_command(&c).await.unwrap();
    assert_eq!(s.trash_snapshot().await.unwrap()["tasks"], json!([]));
    assert_eq!(s.project_tasks(&p).await.unwrap().len(), 0);
    restore(&s, &c.operation_id).await;
    let snap = s.trash_snapshot().await.unwrap();
    assert_eq!(snap["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(
        snap["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == b)
            .unwrap()["parentTaskId"],
        a
    );
    let tomb: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM deletion_tombstones WHERE restored_at IS NOT NULL",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(tomb, 2);
}
#[tokio::test]
async fn promote_keeps_live_child_and_restore_does_not_move_it_back() {
    let (_d, s, mut db) = fixture().await;
    let a = task(&s, "父", None).await;
    let b = task(&s, "子", None).await;
    parent(&mut db, &b, &a).await;
    let c = delete(&s, "task", &a, "promote", false).await;
    s.trash_command(&c).await.unwrap();
    restore(&s, &c.operation_id).await;
    let parent: Option<String> = sqlx::query_scalar("SELECT parent_task_id FROM tasks WHERE id=?")
        .bind(b)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(parent, None);
}
#[tokio::test]
async fn project_default_detaches_tree_preserves_records_and_unlinks() {
    let (_d, s, mut db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "父", Some(&p)).await;
    let b = task(&s, "子", Some(&p)).await;
    parent(&mut db, &b, &a).await;
    sqlx::query("INSERT INTO records(id,owner_id,title,body,record_type,created_at,updated_at) SELECT 'record',owner_id,'记录','保留正文','note','now','now' FROM local_profile").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO record_links VALUES('record','project',?)")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    let c = delete(&s, "project", &p, "detach", false).await;
    s.trash_command(&c).await.unwrap();
    assert_eq!(s.list_projects().await.unwrap().len(), 0);
    let snap = s.trash_snapshot().await.unwrap();
    assert!(snap["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["projectId"].is_null()));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records WHERE deleted_at IS NULL")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM record_links")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    restore(&s, &c.operation_id).await;
    assert_eq!(s.list_projects().await.unwrap().len(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM record_links")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        1
    );
    assert!(s.trash_snapshot().await.unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["projectId"].is_null()));
}
#[tokio::test]
async fn whole_project_requires_confirmation_and_stale_preview_is_rejected() {
    let (_d, s, _db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "任务", Some(&p)).await;
    let c = delete(&s, "project", &p, "cascade", false).await;
    assert!(s.trash_command(&c).await.unwrap_err().contains("确认"));
    assert_eq!(s.project_tasks(&p).await.unwrap().len(), 1);
    let stale = delete(&s, "task", &a, "cascade", false).await;
    task(&s, "新增", None).await;
    assert_eq!(s.trash_command(&stale).await.unwrap_err(), "STATE_CONFLICT");
    let valid = delete(&s, "project", &p, "cascade", true).await;
    s.trash_command(&valid).await.unwrap();
    restore(&s, &valid.operation_id).await;
    assert_eq!(s.project_tasks(&p).await.unwrap().len(), 1);
}
#[tokio::test]
async fn restoring_task_after_project_deletion_uses_independent_fallback() {
    let (_d, s, mut db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "任务", Some(&p)).await;
    let first = delete(&s, "task", &a, "cascade", false).await;
    s.trash_command(&first).await.unwrap();
    let second = delete(&s, "project", &p, "detach", false).await;
    s.trash_command(&second).await.unwrap();
    restore(&s, &first.operation_id).await;
    let row: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT project_id,deleted_at FROM tasks WHERE id=?")
            .bind(&a)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(row, (None, None));
}

#[tokio::test]
async fn failed_outbox_rolls_back_deletion_and_next_action() {
    let (_d, s, mut db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "下一步", Some(&p)).await;
    sqlx::query(
        "INSERT INTO project_context(project_id,next_action_task_id,updated_at) VALUES(?,?,'now')",
    )
    .bind(&p)
    .bind(&a)
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_trash_outbox BEFORE INSERT ON sync_outbox WHEN NEW.kind='trash' BEGIN SELECT RAISE(ABORT,'test outbox failure'); END").execute(&mut db).await.unwrap();
    let c = delete(&s, "task", &a, "cascade", false).await;
    assert!(s.trash_command(&c).await.is_err());
    assert_eq!(s.project_tasks(&p).await.unwrap().len(), 1);
    assert_eq!(s.trash_snapshot().await.unwrap()["entries"], json!([]));
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT next_action_task_id FROM project_context WHERE project_id=?"
        )
        .bind(&p)
        .fetch_one(&mut db)
        .await
        .unwrap(),
        a
    );
    sqlx::query("DROP TRIGGER fail_trash_outbox")
        .execute(&mut db)
        .await
        .unwrap();
    s.trash_command(&c).await.unwrap();
    restore(&s, &c.operation_id).await;
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT next_action_task_id FROM project_context WHERE project_id=?"
        )
        .bind(&p)
        .fetch_one(&mut db)
        .await
        .unwrap(),
        None
    );
}

#[tokio::test]
async fn valid_dependencies_recover_and_project_deletion_stops_templates() {
    let (_d, s, mut db) = fixture().await;
    let p = project(&s).await;
    let a = task(&s, "先做", Some(&p)).await;
    let b = task(&s, "后做", Some(&p)).await;
    sqlx::query("INSERT INTO task_dependencies(owner_id,task_id,predecessor_id) SELECT owner_id,?,? FROM local_profile").bind(&b).bind(&a).execute(&mut db).await.unwrap();
    let c = delete(&s, "task", &a, "cascade", false).await;
    s.trash_command(&c).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM task_dependencies")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    restore(&s, &c.operation_id).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM task_dependencies")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        1
    );
    sqlx::query("INSERT INTO recurrence_templates(id,owner_id,title,project_id,start_date,time_zone,interval_days,weekdays,enabled,version) SELECT 'template',owner_id,'重复',?,'2026-10-09','UTC',1,'[]',1,0 FROM local_profile").bind(&p).execute(&mut db).await.unwrap();
    let c = delete(&s, "project", &p, "detach", false).await;
    s.trash_command(&c).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT enabled FROM recurrence_templates WHERE id='template'"
        )
        .fetch_one(&mut db)
        .await
        .unwrap(),
        0
    );
    restore(&s, &c.operation_id).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT enabled FROM recurrence_templates WHERE id='template'"
        )
        .fetch_one(&mut db)
        .await
        .unwrap(),
        0
    );
}

fn retention_command(days: i64, version: i64) -> TrashCommand {
    serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T00:00:00Z","action":{"type":"settings","recoveryDays":days,"expectedVersion":version}})).unwrap()
}

#[tokio::test]
async fn retention_defaults_to_thirty_days_is_read_only_and_versioned() {
    let (_d, s, mut db) = fixture().await;
    assert_eq!(
        s.trash_snapshot().await.unwrap()["settings"],
        json!({"recoveryDays":30,"version":0})
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM trash_settings")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    for invalid in [0, -1, 3651] {
        assert!(s
            .trash_command(&retention_command(invalid, 0))
            .await
            .is_err());
    }
    let c = retention_command(60, 0);
    s.trash_command(&c).await.unwrap();
    s.trash_command(&c).await.unwrap();
    assert_eq!(
        s.trash_snapshot().await.unwrap()["settings"],
        json!({"recoveryDays":60,"version":1})
    );
    assert_eq!(
        s.trash_command(&retention_command(90, 0))
            .await
            .unwrap_err(),
        "STATE_CONFLICT"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sync_outbox WHERE kind='trash'")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn expired_recovery_rejects_fake_command_time_but_retains_tombstone_and_content() {
    let (_d, s, mut db) = fixture().await;
    let t = task(&s, "超期任务", None).await;
    let mut c = delete(&s, "task", &t, "cascade", false).await;
    c.occurred_at = "2199-01-01T00:00:00Z".into();
    s.trash_command(&c).await.unwrap();
    let current = s.trash_snapshot().await.unwrap();
    let entry = &current["entries"][0];
    let started =
        chrono::DateTime::parse_from_rfc3339(entry["recoveryStartedAt"].as_str().unwrap()).unwrap();
    assert!(
        (chrono::Utc::now() - started.with_timezone(&chrono::Utc))
            .num_seconds()
            .abs()
            < 10
    );
    let expires =
        chrono::DateTime::parse_from_rfc3339(entry["expiresAt"].as_str().unwrap()).unwrap();
    assert_eq!((expires - started).num_days(), 30);
    assert_eq!(entry["canRestore"], true);
    let old = (chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339();
    sqlx::query("UPDATE trash_batches SET recovery_started_at=? WHERE id=?")
        .bind(&old)
        .bind(&c.operation_id)
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(
        s.trash_snapshot().await.unwrap()["entries"][0]["canRestore"],
        false
    );
    let restore:TrashCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":old,"action":{"type":"restore","batchId":c.operation_id}})).unwrap();
    assert!(s
        .trash_command(&restore)
        .await
        .unwrap_err()
        .contains("恢复窗口"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sync_outbox WHERE operation_id=?")
            .bind(&restore.operation_id)
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM tasks WHERE id=? AND deleted_at IS NOT NULL"
        )
        .bind(&t)
        .fetch_one(&mut db)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM deletion_tombstones WHERE entity_id=? AND restored_at IS NULL"
        )
        .bind(&t)
        .fetch_one(&mut db)
        .await
        .unwrap(),
        1
    );
    s.trash_command(&retention_command(60, 0)).await.unwrap();
    assert_eq!(
        s.trash_snapshot().await.unwrap()["entries"][0]["canRestore"],
        true
    );
    s.trash_command(&restore).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM deletion_tombstones WHERE entity_id=? AND restored_at IS NOT NULL").bind(&t).fetch_one(&mut db).await.unwrap(),1);
}
