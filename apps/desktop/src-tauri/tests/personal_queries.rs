//! P0-03 native projection/replication checks on synthetic temporary stores.
use praxis_desktop_lib::store::{
    entities::{Batch, Entity, Feed},
    InboxCommand, Store, TaskDetailsCommand,
};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
const AT: &str = "2026-11-11T04:00:00Z";
fn entity(data: Value) -> Entity {
    Entity {
        id: id(),
        kind: "task".into(),
        version: 200,
        data,
        deleted: false,
        created_at: AT.into(),
        updated_at: AT.into(),
    }
}
fn feed(entities: Vec<Entity>, cursor: i64) -> Feed {
    Feed {
        changes: vec![Batch {
            entities,
            cursor,
            operation_id: id(),
            device_id: id(),
        }],
        cursor,
        has_more: false,
    }
}
fn task<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id)
        .unwrap()
}

#[tokio::test]
async fn personal_snapshot_reads_unplanned_identity_raw_waiting_and_typed_deadline_without_writing()
{
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    let task_id = id();
    store
        .capture_inbox(&InboxCommand {
            operation_id: id(),
            task_id: task_id.clone(),
            title: "未安排到今日的个人任务".into(),
            occurred_at: AT.into(),
        })
        .await
        .unwrap();
    store
        .save_task_details(&TaskDetailsCommand {
            operation_id: id(),
            task_id: task_id.clone(),
            expected_version: 0,
            title: "原任务".into(),
            notes: "旧说明 😀".into(),
            completion_criteria: "旧标准".into(),
            important: true,
            deadline: Some("2026-11-11T02:00:00Z".into()),
            deadline_time_zone: Some("America/Los_Angeles".into()),
            estimated_minutes: Some(40),
            occurred_at: AT.into(),
        })
        .await
        .unwrap();
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET waiting=1,waiting_for='外部反馈',waiting_note='保留旧说明',status_reason='旧原因' WHERE id=?").bind(&task_id).execute(&db).await.unwrap();
    let before_outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
        .fetch_one(&db)
        .await
        .unwrap();
    let snapshot = store.productivity_snapshot().await.unwrap();
    let t = task(&snapshot, &task_id);
    assert_eq!(t["id"], task_id);
    assert_eq!(t["projectId"], Value::Null);
    assert_eq!(t["version"], 1);
    assert_eq!(t["rawStatus"], "todo");
    assert_eq!(t["waiting"], true);
    assert_eq!(t["status"], "waiting");
    assert_eq!(t["statusReason"], "旧原因");
    assert_eq!(t["completionCriteria"], "旧标准");
    assert_eq!(
        t["deadline"],
        json!({"kind":"instant","atUtc":"2026-11-11T02:00:00Z","displayTimezone":"America/Los_Angeles"})
    );
    assert!(t["plan"].is_null());
    assert!(store.list_day("2026-11-11").await.unwrap().is_empty());
    assert_eq!(store.productivity_snapshot().await.unwrap(), snapshot);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_outbox")
            .fetch_one(&db)
            .await
            .unwrap(),
        before_outbox
    );
    db.close().await;
    store.close().await;
}

#[tokio::test]
async fn explicit_same_day_typed_deadline_edit_replaces_instant_but_title_only_edit_preserves_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let instant = json!({"kind":"instant","atUtc":"2026-11-11T02:00:00Z","displayTimezone":"America/Los_Angeles"});
    let mut remote = entity(
        json!({"title":"原任务","status":"todo","dueDate":"2026-11-10","desktop":{"deadline_value":instant.to_string(),"unknown":"保留"}}),
    );
    store
        .entities_pull(&feed(vec![remote.clone()], 1), "device")
        .await
        .unwrap();
    let first = store.productivity_snapshot().await.unwrap();
    let local_version = task(&first, &remote.id)["version"].as_i64().unwrap();
    assert!(
        local_version < remote.version,
        "wire version must not replace local CAS"
    );
    assert_eq!(task(&first, &remote.id)["deadline"], instant);
    remote.version += 1;
    remote.data["title"] = json!("手机只修改标题");
    store
        .entities_pull(&feed(vec![remote.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        task(&store.productivity_snapshot().await.unwrap(), &remote.id)["deadline"],
        instant
    );
    remote.version += 1;
    remote.data["desktop"]["deadline_value"] =
        json!(json!({"kind":"date","date":"2026-11-10"}).to_string());
    store
        .entities_pull(&feed(vec![remote.clone()], 3), "device")
        .await
        .unwrap();
    let after = store.productivity_snapshot().await.unwrap();
    assert_eq!(
        task(&after, &remote.id)["deadline"],
        json!({"kind":"date","date":"2026-11-10"})
    );
    let next_version = task(&after, &remote.id)["version"].as_i64().unwrap();
    assert!(next_version > local_version && next_version < remote.version);
    assert_eq!(
        store
            .entities_snapshot()
            .await
            .unwrap()
            .iter()
            .find(|e| e.id == remote.id)
            .unwrap()
            .data["desktop"]["unknown"],
        "保留"
    );
    store.close().await;
}

#[tokio::test]
async fn personal_completion_replication_keeps_unknown_dates_and_uses_known_fact_time_not_last_edit_time(
) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let mut unknown = entity(
        json!({"title":"旧完成但时间未知","status":"completed","completedAt":null,"executionDate":"2026-11-01"}),
    );
    let known = entity(
        json!({"title":"旧完成且时间已知","status":"completed","completedAt":"2026-11-01T04:00:00Z","executionDate":"2026-11-01"}),
    );
    store
        .entities_pull(&feed(vec![unknown.clone(), known.clone()], 1), "device")
        .await
        .unwrap();
    let first = store.productivity_snapshot().await.unwrap();
    assert!(task(&first, &unknown.id)["completedAt"].is_null());
    assert_eq!(
        task(&first, &known.id)["completedAt"],
        "2026-11-01T04:00:00Z"
    );
    unknown.version += 1;
    unknown.data["title"] = json!("只编辑旧任务标题");
    store
        .entities_pull(&feed(vec![unknown.clone()], 2), "device")
        .await
        .unwrap();
    let after = store.productivity_snapshot().await.unwrap();
    assert!(task(&after, &unknown.id)["completedAt"].is_null());
    assert_eq!(
        store
            .entities_snapshot()
            .await
            .unwrap()
            .iter()
            .find(|e| e.id == unknown.id)
            .unwrap()
            .data["completedAt"],
        Value::Null
    );
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(dir.path().join("praxis.db")))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM execution_records WHERE task_id=?")
            .bind(&unknown.id)
            .fetch_one(&db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT occurred_at FROM execution_records WHERE task_id=?"
        )
        .bind(&known.id)
        .fetch_one(&db)
        .await
        .unwrap(),
        "2026-11-01T04:00:00Z"
    );
    db.close().await;
    store.close().await;
}
