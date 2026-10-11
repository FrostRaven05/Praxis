use praxis_desktop_lib::store::*;
use serde_json::{json, Value};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(action: Value) -> ReviewCommand {
    serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-09T03:00:00Z","action":action}),
    )
    .unwrap()
}
async fn project(s: &Store, name: &str) -> String {
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: name.into(),
        outcome: "".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-09-01T00:00:00Z".into(),
    })
    .await
    .unwrap();
    p
}
async fn content(s: &Store, action: Value, at: &str) {
    let c: ContentCommand =
        serde_json::from_value(json!({"operationId":id(),"occurredAt":at,"action":action}))
            .unwrap();
    s.content_command(&c).await.unwrap();
}
async fn work(s: &Store, action: Value) {
    let c: ProductivityCommand = serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-09T03:00:00Z","action":action}),
    )
    .unwrap();
    s.productivity_command(&c).await.unwrap();
}
#[tokio::test]
async fn weekly_review_is_an_editable_record_and_retry_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let s = Store::open(&path).await.unwrap();
    let review = id();
    let c = command(
        json!({"type":"save","id":review,"expectedVersion":null,"start":"2026-10-05","end":"2026-10-11","achievements":"完成初稿","blockers":"等待答复","stopPause":"暂停旧提案","nextFocus":"验证初稿","projectIds":[]}),
    );
    s.review_command(&c).await.unwrap();
    s.review_command(&c).await.unwrap();
    let snap = s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap();
    assert_eq!(snap["reviews"].as_array().unwrap().len(), 1);
    assert_eq!(snap["reviews"][0]["achievements"], "完成初稿");
    assert!(s.productivity_snapshot().await.unwrap()["tasks"]
        .as_array()
        .unwrap()
        .is_empty());
    let records = s.content_snapshot().await.unwrap();
    assert_eq!(records["records"][0]["recordType"], "review");
    assert!(records["records"][0]["body"]
        .as_str()
        .unwrap()
        .contains("完成初稿"));
    drop(s);
    let s = Store::open(&path).await.unwrap();
    assert_eq!(
        s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap()["reviews"][0]["nextFocus"],
        "验证初稿"
    );
}

#[tokio::test]
async fn generated_weekly_review_title_follows_period_changes() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let review = id();
    let mut action = json!({"type":"save","id":review,"expectedVersion":null,"start":"2026-10-05","end":"2026-10-11","achievements":"成果","blockers":"","stopPause":"","nextFocus":"下一步","projectIds":[]});
    s.review_command(&command(action.clone())).await.unwrap();
    action["expectedVersion"] = json!(0);
    action["start"] = json!("2026-10-12");
    action["end"] = json!("2026-10-18");
    s.review_command(&command(action)).await.unwrap();
    let records = s.content_snapshot().await.unwrap();
    assert_eq!(
        records["records"][0]["title"],
        "周回顾 2026-10-12 — 2026-10-18"
    );
}
#[tokio::test]
async fn diagnostics_use_local_deadlines_and_latest_recorded_evidence_not_timestamp_text_order() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    work(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    let p = project(&s, "检查项目").await;
    content(&s,json!({"type":"context","projectId":p,"expectedVersion":null,"definitionOfDone":"","blockerText":"","reviewDate":"2026-10-09","nextActionTaskId":null,"lastContext":"","restartHint":"","waitingNote":""}),"2026-09-30T00:00:00Z").await;
    for at in ["2026-10-01T23:00:00Z", "2026-10-02T00:00:00+14:00"] {
        content(&s,json!({"type":"record","id":id(),"expectedVersion":null,"title":"记录推进","body":"已试验","recordType":"progress","links":[{"targetType":"project","targetId":p}]}),at).await;
    }
    for deadline in [
        json!({"kind":"date","date":"2026-10-08"}),
        json!({"kind":"date","date":"2026-10-09"}),
        json!({"kind":"instant","atUtc":"2026-10-09T02:59:00Z","displayTimezone":"UTC"}),
    ] {
        work(&s,json!({"type":"task","id":id(),"expectedVersion":null,"title":"有真实期限","notes":"","projectId":p,"plan":null,"deadline":deadline,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[]})).await;
    }
    let snap = s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap();
    let row = &snap["checks"][0];
    assert_eq!(snap["today"], "2026-10-09");
    assert_eq!(row["overdueCount"], 2);
    assert_eq!(row["lastProgressAt"], "2026-10-01T23:00:00.000Z");
    assert!(row["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r == "复查日期已到"));
    assert_eq!(row["daysWithoutRecordedProgress"], 7);
    let settings = command(json!({"type":"settings","staleDays":9,"expectedVersion":null}));
    s.review_command(&settings).await.unwrap();
    s.review_command(&settings).await.unwrap();
    assert!(
        !s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap()["checks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r.as_str().unwrap().contains("未记录推进"))
    );
}
#[tokio::test]
async fn editing_keeps_stable_project_links_and_conflicts_have_no_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("p.db")).await.unwrap();
    let p = project(&s, "旧名字").await;
    let r = id();
    let action = json!({"type":"save","id":r,"expectedVersion":null,"start":"2026-10-05","end":"2026-10-11","achievements":"成果","blockers":"","stopPause":"","nextFocus":"下一步","projectIds":[p]});
    s.review_command(&command(action.clone())).await.unwrap();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: Some(0),
        name: "新名字".into(),
        outcome: "".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-10-09T03:00:00Z".into(),
    })
    .await
    .unwrap();
    let mut edit = action.clone();
    edit["expectedVersion"] = json!(0);
    edit["achievements"] = json!("离线补充成果");
    s.review_command(&command(edit.clone())).await.unwrap();
    let before = s.content_snapshot().await.unwrap();
    let pending = s.pending_operations().await.unwrap().len();
    assert!(s
        .review_command(&command(edit.clone()))
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    edit["expectedVersion"] = json!(1);
    edit["projectIds"] = json!([id()]);
    assert!(s.review_command(&command(edit.clone())).await.is_err());
    assert_eq!(before, s.content_snapshot().await.unwrap());
    assert_eq!(pending, s.pending_operations().await.unwrap().len());
    let snap = s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap();
    assert_eq!(snap["projects"][0]["name"], "新名字");
    assert_eq!(snap["reviews"][0]["projectIds"], json!([p]));
    assert_eq!(snap["reviews"][0]["achievements"], "离线补充成果");
    let generic:ContentCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T03:00:00Z","action":{"type":"record","id":r,"expectedVersion":1,"title":"generic","body":"would lose fields","recordType":"note","links":[]}})).unwrap();
    assert!(s
        .content_command(&generic)
        .await
        .unwrap_err()
        .contains("周回顾"));
    assert_eq!(before, s.content_snapshot().await.unwrap());
}
#[tokio::test]
async fn recovery_card_update_counts_as_recorded_progress_and_inactive_projects_are_excluded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    let s = Store::open(&path).await.unwrap();
    let active = project(&s, "活跃").await;
    let paused = project(&s, "已暂停").await;
    work(&s,json!({"type":"project","id":paused,"expectedVersion":0,"status":"paused","archive":false,"focused":false,"cancelRemaining":false,"expectedPlanVersion":0})).await;
    let initial = s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap();
    assert_eq!(initial["checks"].as_array().unwrap().len(), 1);
    assert_eq!(initial["checks"][0]["id"], active);
    assert!(initial["checks"][0]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str().unwrap().contains("未记录推进")));
    content(&s,json!({"type":"context","projectId":active,"expectedVersion":null,"definitionOfDone":"交付稿件","blockerText":"","reviewDate":null,"nextActionTaskId":null,"lastContext":"完成比较，选择方案A","restartHint":"继续验证方案A","waitingNote":""}),"2026-10-09T02:00:00Z").await;
    let snap = s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap();
    assert_eq!(
        snap["checks"][0]["lastProgressAt"],
        "2026-10-09T02:00:00.000Z"
    );
    assert_eq!(
        snap["checks"][0]["reasons"],
        json!(["活跃项目未指定下一步"])
    );
    s.review_command(&command(
        json!({"type":"settings","staleDays":14,"expectedVersion":null}),
    ))
    .await
    .unwrap();
    drop(s);
    let s = Store::open(&path).await.unwrap();
    assert_eq!(
        s.review_snapshot("2026-10-09T03:00:00Z").await.unwrap()["settings"]["staleDays"],
        14
    );
}
