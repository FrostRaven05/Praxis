use praxis_desktop_lib::store::*;
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn query() -> Value {
    json!({"text":"","entityType":"task","projectId":null,"status":null,"includeArchived":false,"groups":[],"sort":"title","groupBy":"project"})
}
fn command(a: Value) -> ViewCommand {
    serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":a}),
    )
    .unwrap()
}
async fn run(s: &Store, q: Value) -> Value {
    s.view_query(&serde_json::from_value(q).unwrap())
        .await
        .unwrap()
}
async fn fixture() -> (tempfile::TempDir, Store, SqliteConnection, String, String) {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("praxis.db");
    let s = Store::open(&path).await.unwrap();
    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: "测试项目".into(),
        outcome: "共同词 项目正文".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-10-09T12:00:00Z".into(),
    })
    .await
    .unwrap();
    let t = id();
    s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"task","id":t,"expectedVersion":null,"title":"任务A","notes":"共同词 任务正文","projectId":p,"plan":null,"deadline":null,"followUp":null,"priority":2,"waitingFor":"","waitingNote":"","labels":[]}})).unwrap()).await.unwrap();
    sqlx::query("UPDATE tasks SET default_estimated_minutes=10 WHERE id=?")
        .bind(&t)
        .execute(&mut db)
        .await
        .unwrap();
    (d, s, db, p, t)
}
#[tokio::test]
async fn search_four_types_body_project_scope_and_literal_input() {
    let (_d, s, _db, p, _t) = fixture().await;
    let record = id();
    s.content_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"record","id":record,"expectedVersion":null,"title":"记录","body":"共同词 记录正文","recordType":"note","links":[{"targetType":"project","targetId":p}]}})).unwrap()).await.unwrap();
    s.habit_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"create","id":id(),"name":"习惯","startDate":"2026-10-05","frequency":"daily","weekdays":[],"weeklyTarget":1,"triggerContext":"共同词","normalVersion":"完整","minimumVersion":"最小","notes":"","projectId":p}})).unwrap()).await.unwrap();
    let mut q = query();
    q["entityType"] = json!("all");
    q["text"] = json!("共同词");
    let r = run(&s, q.clone()).await;
    assert_eq!(r["rows"].as_array().unwrap().len(), 4);
    q["projectId"] = json!(p);
    assert_eq!(
        run(&s, q.clone()).await["rows"].as_array().unwrap().len(),
        4
    );
    q["text"] = json!("%' OR 1=1 --");
    assert_eq!(run(&s, q).await["rows"].as_array().unwrap().len(), 0);
}
#[tokio::test]
async fn saved_view_replay_restart_rename_and_stale_write_are_transactional() {
    let (d, s, mut db, p, t) = fixture().await;
    let label = id();
    sqlx::query(
        "INSERT INTO labels(id,owner_id,name) SELECT ?,owner_id,'旧标签' FROM local_profile",
    )
    .bind(&label)
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO task_labels(task_id,label_id) VALUES(?,?)")
        .bind(&t)
        .bind(&label)
        .execute(&mut db)
        .await
        .unwrap();
    let mut q = query();
    q["groups"] = json!([[{"field":"project","op":"eq","value":p},{"field":"label","op":"eq","value":label},{"field":"estimate","op":"lte","value":"15"}]]);
    let view = id();
    let save = command(
        json!({"type":"save","id":view,"expectedVersion":null,"name":"等待清单","query":q,"followed":true}),
    );
    s.view_command(&save).await.unwrap();
    s.view_command(&save).await.unwrap();
    sqlx::query("UPDATE projects SET name='新项目名' WHERE id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE labels SET name='新标签名' WHERE id=?")
        .bind(&label)
        .execute(&mut db)
        .await
        .unwrap();
    let s2 = Store::open(&d.path().join("praxis.db")).await.unwrap();
    let snap = s2.view_snapshot().await.unwrap();
    assert_eq!(snap["views"].as_array().unwrap().len(), 1);
    assert_eq!(snap["views"][0]["followed"], true);
    assert_eq!(snap["views"][0]["version"], 0);
    let found = run(&s2, snap["views"][0]["query"].clone()).await;
    assert_eq!(found["rows"][0]["id"], t);
    assert_eq!(found["rows"][0]["group"], "新项目名");
    let invalid = command(
        json!({"type":"save","id":view,"expectedVersion":null,"name":"stale","query":q,"followed":false}),
    );
    assert!(s
        .view_command(&invalid)
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM content_events WHERE kind='saved_view'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    let queued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sync_outbox WHERE kind='saved_view'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!((events, queued), (1, 1));
    s.view_command(&command(
        json!({"type":"delete","id":view,"expectedVersion":0}),
    ))
    .await
    .unwrap();
    assert!(s.view_snapshot().await.unwrap()["views"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(run(&s, q).await["rows"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn missing_reference_warns_and_archived_and_deleted_are_excluded() {
    let (_d, s, mut db, p, t) = fixture().await;
    sqlx::query("UPDATE tasks SET status='completed' WHERE id=?")
        .bind(&t)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE projects SET status='completed',archived_at='2026-10-09' WHERE id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    assert!(run(&s, query()).await["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    let mut q = query();
    q["includeArchived"] = json!(true);
    assert_eq!(
        run(&s, q.clone()).await["rows"].as_array().unwrap().len(),
        1
    );
    sqlx::query("UPDATE tasks SET deleted_at='2026-10-09' WHERE id=?")
        .bind(&t)
        .execute(&mut db)
        .await
        .unwrap();
    assert!(run(&s, q.clone()).await["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE projects SET deleted_at='2026-10-09' WHERE id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    q["groups"] = json!([[{"field":"project","op":"eq","value":p}]]);
    assert_eq!(run(&s, q).await["warnings"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn finite_or_and_typed_predicates_and_invalid_ast() {
    let (_d, s, _db, _p, t) = fixture().await;
    let mut q = query();
    q["groups"] = json!([[{"field":"priority","op":"eq","value":"1"}],[{"field":"priority","op":"lte","value":"2"},{"field":"estimate","op":"lte","value":"15"},{"field":"plan","op":"empty","value":""}]]);
    assert_eq!(run(&s, q.clone()).await["rows"][0]["id"], t);
    q["groups"][1][1]["value"] = json!("5");
    assert!(run(&s, q.clone()).await["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    for groups in [
        json!([[{"field":"code","op":"eval","value":"process.exit()"}]]),
        json!([[], [], [], []]),
        json!([[{"field":"deadline","op":"eq","value":"nonsense"}]]),
    ] {
        q["groups"] = groups;
        assert!(s
            .view_query(&serde_json::from_value(q.clone()).unwrap())
            .await
            .is_err());
    }
}
#[tokio::test]
async fn presets_are_dynamic_and_waiting_without_due_followup_is_not_returned() {
    let (_d, s, mut db, _p, t) = fixture().await;
    let snap = s.view_snapshot().await.unwrap();
    assert_eq!(snap["presets"].as_array().unwrap().len(), 5);
    let waiting = snap["presets"][3]["query"].clone();
    sqlx::query("UPDATE tasks SET waiting=1,follow_up_value=? WHERE id=?")
        .bind(json!({"kind":"date","date":"2099-01-01"}).to_string())
        .bind(&t)
        .execute(&mut db)
        .await
        .unwrap();
    assert!(run(&s, waiting.clone()).await["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE tasks SET follow_up_value=? WHERE id=?")
        .bind(
            json!({"kind":"instant","atUtc":"2000-01-01T23:59:00Z","displayTimezone":"UTC"})
                .to_string(),
        )
        .bind(&t)
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(run(&s, waiting).await["rows"][0]["id"], t);
}
