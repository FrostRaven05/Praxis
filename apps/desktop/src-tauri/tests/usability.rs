use praxis_desktop_lib::store::*;
use serde_json::{json, Value};

fn id() -> String { uuid::Uuid::new_v4().to_string() }

#[tokio::test]
async fn selected_date_capture_and_quick_add_create_atomic_calendar_arrangements() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    store.initialize_workspace_zone("Asia/Hong_Kong").await.unwrap();
    let capture = CaptureCommand { operation_id:id(), task_id:id(), plan_id:id(), title:"明天的任务".into(),
        execution_date:"2026-10-19".into(), time_zone:"Asia/Hong_Kong".into(), occurred_at:"2026-10-18T12:00:00Z".into() };
    let first = store.capture_on_date(&capture).await.unwrap();
    assert_eq!(store.capture_on_date(&capture).await.unwrap(), first);
    assert_eq!(first.execution_date, "2026-10-19");
    assert_eq!(first.created_at, "2026-10-18T12:00:00Z");
    assert!(store.list_day("2026-10-18").await.unwrap().is_empty());
    let quick_id = id();
    let command: ProductivityCommand = serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-18T12:01:00Z",
        "action":{"type":"task","id":quick_id,"expectedVersion":null,"title":"带属性新增","notes":"保留说明","projectId":null,
        "plan":{"kind":"date","date":"2026-10-19"},"deadline":null,"followUp":null,"priority":2,"labels":[],"waitingFor":"","waitingNote":"","arrangeOnCreate":true}})).unwrap();
    store.productivity_command(&command).await.unwrap();
    store.productivity_command(&command).await.unwrap();
    assert_eq!(store.list_day("2026-10-19").await.unwrap().len(), 2);
    assert_eq!(store.productivity_snapshot().await.unwrap()["legacyPlans"].as_array().unwrap().len(), 2);
    assert_eq!(store.pending_operations().await.unwrap().len(), 3);
}

#[tokio::test]
async fn device_zone_initializes_once_and_survives_reopening_without_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    store.initialize_workspace_zone("Asia/Hong_Kong").await.unwrap();
    store.initialize_workspace_zone("America/New_York").await.unwrap();
    assert_eq!(store.productivity_snapshot().await.unwrap()["settings"], json!([{"timeZone":"Asia/Hong_Kong","version":0}]));
    assert_eq!(store.pending_operations().await.unwrap().len(), 1);
    store.close().await;
    let reopened = Store::open(&path).await.unwrap();
    reopened.initialize_workspace_zone("UTC").await.unwrap();
    assert_eq!(reopened.productivity_snapshot().await.unwrap()["settings"][0]["timeZone"], "Asia/Hong_Kong");
    assert_eq!(reopened.pending_operations().await.unwrap().len(), 1);
}

async fn status(store: &Store, task_id: &str, status: &str) {
    let snapshot = store.productivity_snapshot().await.unwrap();
    let task = snapshot["tasks"].as_array().unwrap().iter().find(|t| t["id"] == task_id).unwrap();
    let expected: Vec<Value> = snapshot["tasks"].as_array().unwrap().iter().map(|t| json!([t["id"],t["version"]])).collect();
    store.productivity_command(&serde_json::from_value(json!({
        "operationId":id(), "occurredAt":"2026-10-18T12:00:00Z",
        "action":{"type":"status","id":task_id,"status":status,"expectedVersion":task["version"],"confirmRelated":false,"expectedTasks":expected}
    })).unwrap()).await.unwrap();
}

#[tokio::test]
async fn undated_inbox_completion_can_be_undone_without_creating_a_schedule() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    store.initialize_workspace_zone("Asia/Hong_Kong").await.unwrap();
    let task_id = id();
    store.capture_inbox(&InboxCommand { operation_id:id(), task_id:task_id.clone(), title:"联系客户".into(), occurred_at:"2026-10-18T11:00:00Z".into() }).await.unwrap();
    for _ in 0..2 {
        assert_eq!(store.list_inbox().await.unwrap().len(), 1);
        status(&store, &task_id, "completed").await;
        assert!(store.list_inbox().await.unwrap().is_empty());
        let snapshot = store.productivity_snapshot().await.unwrap();
        assert!(snapshot["tasks"][0]["plan"].is_null());
        assert!(snapshot["legacyPlans"].as_array().unwrap().is_empty());
        status(&store, &task_id, "todo").await;
        assert_eq!(store.list_inbox().await.unwrap()[0].task_id, task_id);
        assert!(store.list_day("2026-10-18").await.unwrap().is_empty());
    }
    let history = store.execution_history(&task_id).await.unwrap();
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|e| e.revoked_at.is_some()));
    store.close().await;
    let reopened = Store::open(&path).await.unwrap();
    assert_eq!(reopened.list_inbox().await.unwrap()[0].task_id, task_id);
}
