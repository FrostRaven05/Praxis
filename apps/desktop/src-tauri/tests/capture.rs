use praxis_desktop_lib::store::{CaptureCommand, Store};
use uuid::Uuid;

fn command(title: &str) -> CaptureCommand {
    CaptureCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: Uuid::new_v4().to_string(),
        plan_id: Uuid::new_v4().to_string(),
        title: title.to_owned(),
        execution_date: "2026-09-16".to_owned(),
        time_zone: "Asia/Hong_Kong".to_owned(),
        occurred_at: "2026-09-15T16:05:00.000Z".to_owned(),
    }
}

#[tokio::test]
async fn capture_survives_closing_and_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let request = command("整理文章提纲");
    let store = Store::open(&path).await.unwrap();
    store.capture(&request).await.unwrap();
    store.close().await;

    let reopened = Store::open(&path).await.unwrap();
    let day = reopened.list_day("2026-09-16").await.unwrap();
    assert_eq!(day.len(), 1);
    assert_eq!(day[0].title, "整理文章提纲");
    assert_eq!(day[0].task_id, request.task_id);
    assert_eq!(day[0].plan_id, request.plan_id);
    assert_eq!(day[0].project_id, None);
    assert_eq!(day[0].source, "temporary");
    assert_eq!(day[0].status, "todo");
    assert!(reopened.list_day("2026-09-15").await.unwrap().is_empty());
    assert_eq!(reopened.pending_operations().await.unwrap().len(), 1);
    assert_eq!(
        reopened.task_history(&request.task_id).await.unwrap().len(),
        1
    );
    reopened.close().await;
}

#[tokio::test]
async fn replaying_a_committed_capture_does_not_duplicate_any_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let request = command("可以安全重试");
    let first = store.capture(&request).await.unwrap();
    let repeated = store.capture(&request).await.unwrap();
    assert_eq!(first, repeated);
    assert_eq!(store.list_day("2026-09-16").await.unwrap().len(), 1);
    assert_eq!(store.pending_operations().await.unwrap().len(), 1);
    assert_eq!(store.task_history(&request.task_id).await.unwrap().len(), 1);
    store.close().await;
}

#[tokio::test]
async fn failed_plan_insert_rolls_back_the_task_and_all_side_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let original = command("原有任务");
    store.capture(&original).await.unwrap();
    let mut conflicting = command("不会留下半份记录");
    conflicting.plan_id = original.plan_id.clone();
    assert!(store.capture(&conflicting).await.is_err());
    assert_eq!(store.list_day("2026-09-16").await.unwrap().len(), 1);
    assert_eq!(store.pending_operations().await.unwrap().len(), 1);
    assert!(store
        .task_history(&conflicting.task_id)
        .await
        .unwrap()
        .is_empty());
    // The same task ID can be used after the failed transaction: no orphan task remains.
    conflicting.plan_id = Uuid::new_v4().to_string();
    store.capture(&conflicting).await.unwrap();
    assert_eq!(store.list_day("2026-09-16").await.unwrap().len(), 2);
    assert_eq!(store.pending_operations().await.unwrap().len(), 2);
    store.close().await;
}

#[tokio::test]
async fn invalid_title_or_mismatched_calendar_day_cannot_write_any_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let mut request = command(" \n\t");
    assert!(store.capture(&request).await.is_err());
    request.title = "日期不能截取 UTC".to_owned();
    request.execution_date = "2026-09-15".to_owned();
    assert!(store.capture(&request).await.is_err());
    assert!(store.list_day("2026-09-16").await.unwrap().is_empty());
    assert!(store.pending_operations().await.unwrap().is_empty());
    assert!(store
        .task_history(&request.task_id)
        .await
        .unwrap()
        .is_empty());
    store.close().await;
}

#[tokio::test]
async fn an_operation_id_cannot_be_reused_to_change_a_committed_capture() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let mut request = command("保持原内容");
    store.capture(&request).await.unwrap();
    request.title = "不能静默覆盖".to_owned();
    assert!(store.capture(&request).await.is_err());
    assert_eq!(
        store.list_day("2026-09-16").await.unwrap()[0].title,
        "保持原内容"
    );
    assert_eq!(store.pending_operations().await.unwrap().len(), 1);
    store.close().await;
}
