use praxis_desktop_lib::store::{ProductivityCommand, ScheduleCommand, Store};
use serde_json::json;
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
#[tokio::test]
async fn suggestion_becomes_a_daily_task_without_losing_original_fields_or_creating_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.db");
    let store = Store::open(&path).await.unwrap();
    let task = id();
    let create: ProductivityCommand = serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-11T03:00:00Z","action":{"type":"task","id":task,"expectedVersion":null,"title":"建议处理的原任务","notes":"保留备注","projectId":null,"plan":{"kind":"date","date":"2026-10-12"},"deadline":{"kind":"date","date":"2026-10-11"},"followUp":null,"priority":2,"waitingFor":"","waitingNote":"","labels":[]}})).unwrap();
    store.productivity_command(&create).await.unwrap();
    let before = store.productivity_snapshot().await.unwrap()["tasks"][0].clone();
    let command = ScheduleCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: id(),
        expected_version: before["version"].as_i64().unwrap(),
        execution_date: "2026-10-11".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-10-11T03:00:00Z".into(),
    };
    store.accept_suggestion(&command).await.unwrap();
    store.accept_suggestion(&command).await.unwrap();
    assert_eq!(store.list_day("2026-10-11").await.unwrap().len(), 1);
    let snapshot = store.productivity_snapshot().await.unwrap();
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
    for field in [
        "id",
        "title",
        "notes",
        "projectId",
        "plan",
        "deadline",
        "followUp",
        "priority",
        "status",
    ] {
        assert_eq!(snapshot["tasks"][0][field], before[field]);
    }
    let mut stale = command.clone();
    stale.operation_id = id();
    stale.plan_id = id();
    assert!(store.accept_suggestion(&stale).await.is_err());
    let mut forged = command.clone();
    forged.operation_id = id();
    forged.task_id = id();
    assert!(store.accept_suggestion(&forged).await.is_err());
    assert_eq!(store.list_day("2026-10-11").await.unwrap().len(), 1);
    store.close().await;
    let store = Store::open(&path).await.unwrap();
    assert_eq!(store.list_day("2026-10-11").await.unwrap()[0].task_id, task);
    store.close().await;
}
#[tokio::test]
async fn account_workspaces_keep_local_tasks_separate_after_reopening() {
    let root = tempfile::tempdir().unwrap();
    let a_path = root.path().join("a/praxis.db");
    let b_path = root.path().join("b/praxis.db");
    let a = Store::open(&a_path).await.unwrap();
    let b = Store::open(&b_path).await.unwrap();
    let command = praxis_desktop_lib::store::CaptureCommand {
        operation_id: id(),
        task_id: id(),
        plan_id: id(),
        title: "A 的私人任务".into(),
        execution_date: "2026-10-11".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-10-11T03:00:00Z".into(),
    };
    a.capture(&command).await.unwrap();
    assert!(b.list_day("2026-10-11").await.unwrap().is_empty());
    let mut other = command.clone();
    other.title = "B 的私人任务".into();
    b.capture(&other).await.unwrap();
    assert_eq!(
        a.list_day("2026-10-11").await.unwrap()[0].title,
        command.title
    );
    assert_eq!(
        b.list_day("2026-10-11").await.unwrap()[0].title,
        other.title
    );
    a.close().await;
    b.close().await;
    let a = Store::open(&a_path).await.unwrap();
    assert_eq!(
        a.list_day("2026-10-11").await.unwrap()[0].title,
        command.title
    );
    a.close().await;
}
