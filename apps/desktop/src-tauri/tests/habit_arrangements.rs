use praxis_desktop_lib::store::entities::{Batch, Feed};
use praxis_desktop_lib::store::*;
use serde_json::json;
use sqlx::Connection;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
async fn fixture() -> (tempfile::TempDir, Store, String) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("praxis.db")).await.unwrap();
    let h = id();
    s.habit_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-11T03:00:00Z","action":{"type":"create","id":h,"name":"阅读","startDate":"2026-10-05","frequency":"daily","weekdays":[],"weeklyTarget":7,"triggerContext":"","normalVersion":"","minimumVersion":"","notes":"","projectId":null}})).unwrap()).await.unwrap();
    (d, s, h)
}
fn arrange(h: &str, date: &str, period: &str, version: Option<i64>) -> PlanCommand {
    PlanCommand {
        operation_id: id(),
        date: date.into(),
        occurred_at: "2026-10-11T03:00:00Z".into(),
        changes: vec![],
        habit_changes: vec![HabitPlanChange {
            habit_id: h.into(),
            expected_version: version,
            day_period: period.into(),
            day_rank: 1,
        }],
    }
}

#[tokio::test]
async fn per_day_placement_replay_inheritance_and_completion_survive_restart() {
    let (d, s, h) = fixture().await;
    let c = arrange(&h, "2026-10-11", "evening", None);
    s.update_plan(&c).await.unwrap();
    let pending = s.pending_operations().await.unwrap().len();
    s.update_plan(&c).await.unwrap();
    assert_eq!(s.pending_operations().await.unwrap().len(), pending);
    let snap = s.habit_snapshot("2026-10-11").await.unwrap();
    assert_eq!(
        snap["habits"][0]["placement"],
        json!({"dayPeriod":"evening","dayRank":1,"version":0})
    );
    assert!(snap["habits"][0]["entry"].is_null());
    assert_eq!(snap["habits"][0]["week"]["done"], 0);
    assert_eq!(
        s.habit_snapshot("2026-10-10").await.unwrap()["habits"][0]["placement"]["dayPeriod"],
        "morning"
    );
    assert_eq!(
        s.habit_snapshot("2026-10-12").await.unwrap()["habits"][0]["placement"],
        json!({"dayPeriod":"evening","dayRank":0,"version":null})
    );
    s.update_plan(&arrange(&h, "2026-10-12", "afternoon", None))
        .await
        .unwrap();
    assert_eq!(
        s.habit_snapshot("2026-10-11").await.unwrap()["habits"][0]["placement"]["dayPeriod"],
        "evening"
    );
    s.habit_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-11T03:00:00Z","action":{"type":"entry","id":h,"date":"2026-10-11","status":"done","note":"","timeZone":"UTC","expectedVersion":null}})).unwrap()).await.unwrap();
    assert!(s
        .update_plan(&arrange(&h, "2026-10-11", "morning", Some(0)))
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    s.close().await;
    let reopened = Store::open(&d.path().join("praxis.db")).await.unwrap();
    let row = &reopened.habit_snapshot("2026-10-11").await.unwrap()["habits"][0];
    assert_eq!(row["entry"]["status"], "done");
    assert_eq!(row["placement"]["dayPeriod"], "evening");
}

#[tokio::test]
async fn mixed_task_and_habit_reorder_is_atomic_on_stale_versions_and_outbox_failure() {
    let (d, s, h) = fixture().await;
    let task = id();
    let plan = id();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: plan.clone(),
        title: "任务".into(),
        execution_date: "2026-10-11".into(),
        time_zone: "UTC".into(),
        occurred_at: "2026-10-11T03:00:00Z".into(),
    })
    .await
    .unwrap();
    let mut c = arrange(&h, "2026-10-11", "afternoon", Some(9));
    c.changes.push(PlanChange {
        task_id: task.clone(),
        plan_id: plan.clone(),
        expected_version: 0,
        is_focus: true,
        estimated_minutes: Some(30),
        focus_rank: 1,
        day_period: Some("afternoon".into()),
        day_rank: Some(2),
    });
    assert!(s
        .update_plan(&c)
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    assert_eq!(s.list_day("2026-10-11").await.unwrap()[0].version, 0);
    assert_eq!(
        s.list_day("2026-10-11").await.unwrap()[0].day_period,
        "morning"
    );
    c.habit_changes[0].expected_version = None;
    let mut db = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        d.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_mixed BEFORE INSERT ON sync_outbox WHEN NEW.kind='update_plan' BEGIN SELECT RAISE(ABORT,'qa failure'); END").execute(&mut db).await.unwrap();
    assert!(s.update_plan(&c).await.is_err());
    assert!(
        s.habit_snapshot("2026-10-11").await.unwrap()["habits"][0]["placement"]["version"]
            .is_null()
    );
    assert_eq!(s.list_day("2026-10-11").await.unwrap()[0].version, 0);
    sqlx::query("DROP TRIGGER fail_mixed")
        .execute(&mut db)
        .await
        .unwrap();
    s.update_plan(&c).await.unwrap();
    s.update_plan(&c).await.unwrap();
    let row = &s.list_day("2026-10-11").await.unwrap()[0];
    assert_eq!(row.version, 1);
    assert_eq!(row.day_period, "afternoon");
    assert_eq!(row.day_rank, 2);
    assert_eq!(
        s.habit_snapshot("2026-10-11").await.unwrap()["habits"][0]["placement"]["dayRank"],
        1
    );
}

#[tokio::test]
async fn habit_placement_is_included_in_workspace_replication() {
    let (_d, s, h) = fixture().await;
    s.update_plan(&arrange(&h, "2026-10-11", "evening", None))
        .await
        .unwrap();
    let entities = s.entities_snapshot().await.unwrap();
    assert!(entities
        .iter()
        .any(|e| e.data["table"] == "habit_daily_plans"));
    let other = tempfile::tempdir().unwrap();
    let receiver = Store::open(&other.path().join("remote.db")).await.unwrap();
    receiver
        .entities_pull(
            &Feed {
                changes: vec![Batch {
                    entities,
                    cursor: 1,
                    operation_id: id(),
                    device_id: id(),
                }],
                cursor: 1,
                has_more: false,
            },
            "other-device",
        )
        .await
        .unwrap();
    assert_eq!(
        receiver.habit_snapshot("2026-10-11").await.unwrap()["habits"][0]["placement"]["dayPeriod"],
        "evening"
    );
}
