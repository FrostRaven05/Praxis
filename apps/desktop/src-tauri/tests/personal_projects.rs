//! P1-02: read-only project metadata and the existing save receipt.
use praxis_desktop_lib::store::{SaveProjectCommand, Store};
use serde_json::json;
fn id() -> String { uuid::Uuid::new_v4().to_string() }
#[tokio::test]
async fn basic_project_save_preserves_identity_priority_lifecycle_and_original_update_time() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("project.db")).await.unwrap();
    let mut c = SaveProjectCommand {operation_id:id(),project_id:id(),expected_version:None,
        name:"个人项目".into(),outcome:"".into(),target_date:None,priority:2,occurred_at:"2026-11-01T00:00:00Z".into()};
    store.save_project(&c).await.unwrap();store.save_project(&c).await.unwrap();
    assert_eq!(store.list_projects().await.unwrap().len(),1);
    let before=store.productivity_snapshot().await.unwrap();
    assert_eq!(before["projects"][0]["createdAt"],json!(c.occurred_at));
    assert_eq!(before["projects"][0]["updatedAt"],json!(c.occurred_at));
    assert_eq!(before,store.productivity_snapshot().await.unwrap());
    c.operation_id=id();c.expected_version=Some(0);c.name="更名".into();
    c.outcome="可选目标".into();c.target_date=Some("2026-12-01".into());c.occurred_at="2026-11-11T04:00:00Z".into();
    store.save_project(&c).await.unwrap();store.save_project(&c).await.unwrap();
    let after=store.productivity_snapshot().await.unwrap();
    assert_eq!(after["projects"][0]["id"],json!(c.project_id));
    assert_eq!(after["projects"][0]["updatedAt"],json!(c.occurred_at));
    assert_eq!(after["projects"][0]["createdAt"],before["projects"][0]["createdAt"]);
    let project=&store.list_projects().await.unwrap()[0];
    assert_eq!(project.priority,2);assert_eq!(project.status,"active");assert_eq!(project.version,1);
    c.operation_id=id();assert_eq!(store.save_project(&c).await.unwrap_err(),"STATE_CONFLICT");
    assert_eq!(after,store.productivity_snapshot().await.unwrap());
    store.close().await;
}
