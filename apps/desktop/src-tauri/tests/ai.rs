use praxis_desktop_lib::store::{AiApplyCommand, Store, TaskDetailsCommand};
use serde_json::json;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command() -> AiApplyCommand {
    serde_json::from_value(json!({
 "operationId":id(),"runId":id(),"input":"做一个摄影作品集","source":null,"project":null,
 "newProject":{"id":id(),"name":"作品集","outcome":"发布作品"},"basisTasks":[],
 "tasks":[{"id":id(),"key":"s1","title":"挑选照片","criteria":"挑出十张","estimatedMinutes":15,"dependsOn":[]},{"id":id(),"key":"s2","title":"发布照片","criteria":"发布一个页面","estimatedMinutes":null,"dependsOn":["s1"]}],
 "reward":{"title":"摄影出游","condition":"发布作品之后"}
})).unwrap()
}
#[tokio::test]
async fn personal_flat_notes_and_calendar_deadline_apply_once_and_keep_legacy_receipts_valid() {
    let dir=tempfile::tempdir().unwrap();let s=Store::open(&dir.path().join("personal.db")).await.unwrap();let mut c=command();
    c.reward=None;for task in &mut c.tasks{task.depends_on.clear();task.estimated_minutes=None;task.notes=Some("个人说明".into());task.deadline=Some("2026-12-01".into());}
    let receipt=s.ai_apply(&c).await.unwrap();let replay=s.ai_apply(&c).await.unwrap();assert_eq!(receipt.operation_id,replay.operation_id);
    let snapshot=s.productivity_snapshot().await.unwrap();assert_eq!(snapshot["tasks"][0]["notes"],json!("个人说明"));assert_eq!(snapshot["tasks"][0]["deadline"],json!({"kind":"date","date":"2026-12-01"}));
    assert!(snapshot["legacyPlans"].as_array().unwrap().is_empty());
    s.ai_undo(&id(),&c.operation_id).await.unwrap();assert!(s.ai_receipt(&c.operation_id).await.unwrap().unwrap().undone);
    let mut invalid=command();invalid.tasks[0].deadline=Some("2026-02-30".into());assert_eq!(s.ai_apply(&invalid).await.unwrap_err(),"AI_INVALID_COMMAND");s.close().await;
}
#[tokio::test]
async fn atomic_apply_survives_reopen_replays_and_can_undo_internal_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let c = command();
    let s = Store::open(&path).await.unwrap();
    let receipt = s.ai_apply(&c).await.unwrap();
    assert_eq!(receipt.task_ids.len(), 2);
    assert!(receipt.project_id.is_some());
    let task = s.task_details(&receipt.task_ids[0]).await.unwrap();
    assert_eq!(task.completion_criteria, "挑出十张");
    assert_eq!(task.estimated_minutes, Some(15));
    let tasks = s
        .project_tasks(receipt.project_id.as_deref().unwrap())
        .await
        .unwrap();
    assert_eq!(tasks.len(), 2);
    assert!(tasks.iter().all(|t| t.execution_date.is_none()));
    let replay = s.ai_apply(&c).await.unwrap();
    assert_eq!(replay.operation_id, receipt.operation_id);
    drop(s);
    let s = Store::open(&path).await.unwrap();
    assert!(s.ai_receipt(&c.operation_id).await.unwrap().is_some());
    let mut changed = c.clone();
    changed.tasks[0].title = "不同内容".into();
    assert_eq!(
        s.ai_apply(&changed).await.unwrap_err(),
        "AI_OPERATION_CHANGED"
    );
    s.ai_undo(&id(), &c.operation_id).await.unwrap();
    assert!(s.ai_receipt(&c.operation_id).await.unwrap().unwrap().undone);
    let snapshot = s.content_snapshot().await.unwrap();
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 0);
    assert_eq!(snapshot["captures"][0]["state"], "pending");
}
#[tokio::test]
async fn invalid_graph_rolls_back_and_does_not_create_source_or_project() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let mut c = command();
    c.tasks[0].depends_on = vec!["s2".into()];
    assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_INVALID_DEPENDENCIES");
    assert_eq!(
        s.content_snapshot().await.unwrap()["captures"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(s.list_projects().await.unwrap().len(), 0);
}
#[tokio::test]
async fn edited_output_is_not_destroyed_by_undo() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = command();
    let receipt = s.ai_apply(&c).await.unwrap();
    let task = s.task_details(&receipt.task_ids[0]).await.unwrap();
    s.save_task_details(&TaskDetailsCommand {
        operation_id: id(),
        task_id: task.task_id.clone(),
        expected_version: task.version,
        title: "用户新标题".into(),
        notes: task.notes,
        completion_criteria: task.completion_criteria,
        important: false,
        deadline: None,
        deadline_time_zone: None,
        estimated_minutes: Some(15),
        occurred_at: "2026-10-25T12:00:00Z".into(),
    })
    .await
    .unwrap();
    assert_eq!(
        s.ai_undo(&id(), &c.operation_id).await.unwrap_err(),
        "AI_UNDO_CONFLICT"
    );
    assert_eq!(
        s.task_details(&receipt.task_ids[0]).await.unwrap().title,
        "用户新标题"
    );
}
#[tokio::test]
async fn stale_project_and_source_are_rejected_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let mut c = command();
    c.new_project = None;
    c.project =
        Some(serde_json::from_value(json!({"id":id(),"version":0,"planVersion":0})).unwrap());
    assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_PROJECT");
    c.project = None;
    c.tasks[1].depends_on.clear();
    c.source =
        Some(serde_json::from_value(json!({"id":id(),"version":0,"rawText":"missing"})).unwrap());
    assert_eq!(s.ai_apply(&c).await.unwrap_err(), "AI_STALE_SOURCE");
    assert!(s.ai_receipt(&c.operation_id).await.unwrap().is_none());
}

#[tokio::test]
async fn cultivation_usage_blocks_ai_undo_even_before_tasks_are_completed() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let c = command();
    let receipt = s.ai_apply(&c).await.unwrap();
    let goal:praxis_desktop_lib::store::CultivationCommand=serde_json::from_value(json!({"operationId":id(),"expectedVersion":0,"action":"set_goal","milestone":"发布第一组作品","reward":"摄影出游","target":2,"achievementId":null,"taskIds":receipt.task_ids,"sourceApplicationId":c.operation_id})).unwrap();
    s.cultivation_command(&goal).await.unwrap();
    assert_eq!(
        s.ai_undo(&id(), &c.operation_id).await.unwrap_err(),
        "AI_UNDO_CONFLICT"
    );
    assert!(!s.ai_receipt(&c.operation_id).await.unwrap().unwrap().undone);
    assert_eq!(
        s.content_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
