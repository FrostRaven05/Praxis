use praxis_desktop_lib::store::{
    entities::{Batch, Entity, Feed},
    ContentAction, ContentCommand, Link, RecurrenceAction, RecurrenceCommand, ReviewAction,
    ReviewCommand, Store, ViewQuery,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn recurrence(data: Value) -> Entity {
    Entity {
        id: Uuid::new_v4().to_string(),
        kind: "recurrence".into(),
        version: 1,
        data,
        deleted: false,
        created_at: "2026-10-11T00:00:00Z".into(),
        updated_at: "2026-10-11T00:00:00Z".into(),
    }
}
async fn pull(store: &Store, e: Entity) {
    store
        .entities_pull(
            &Feed {
                changes: vec![Batch {
                    entities: vec![e],
                    cursor: 1,
                    operation_id: Uuid::new_v4().to_string(),
                    device_id: Uuid::new_v4().to_string(),
                }],
                cursor: 1,
                has_more: false,
            },
            "device",
        )
        .await
        .unwrap();
}
async fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("review.db")).await.unwrap();
    (dir, store)
}
fn command(action: RecurrenceAction) -> RecurrenceCommand {
    RecurrenceCommand {
        operation_id: Uuid::new_v4().to_string(),
        occurred_at: "2026-10-11T00:00:00Z".into(),
        action,
    }
}

#[tokio::test]
async fn mobile_future_recurrence_rule_controls_native_expansion() {
    let (_dir, store) = setup().await;
    let e = recurrence(
        json!({"title":"R","startDate":"2026-10-01","frequency":"interval",
        "interval":1,"timeZone":"Asia/Hong_Kong","ruleHistory":[
            {"effectiveDate":"2026-10-01","frequency":"interval","interval":1,"weekdays":[],"active":true,"timeZone":"Asia/Hong_Kong"},
            {"effectiveDate":"2026-10-02","frequency":"interval","interval":2,"weekdays":[],"active":true,"timeZone":"Asia/Hong_Kong"}
        ]}),
    );
    pull(&store, e.clone()).await;
    store
        .recurrence_command(&command(RecurrenceAction::Expand {
            id: e.id.clone(),
            through: "2026-10-05".into(),
            batch_size: 100,
        }))
        .await
        .unwrap();
    let dates = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "task")
        .map(|e| e.data["originalDate"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        dates.len(),
        3,
        "Expected Oct 1 under first rule and Oct 2/4 under second: {dates:?}"
    );
    assert!(!dates.contains(&"2026-10-03".to_string()));
}

#[tokio::test]
async fn native_future_recurrence_edit_exports_canonical_history() {
    let (_dir, store) = setup().await;
    let e = recurrence(
        json!({"title":"R","startDate":"2026-10-01","frequency":"interval",
        "interval":1,"timeZone":"Asia/Hong_Kong"}),
    );
    pull(&store, e.clone()).await;
    let version = store.recurrence_snapshot().await.unwrap()["templates"][0]["template"]["version"]
        .as_i64()
        .unwrap();
    store
        .recurrence_command(&command(RecurrenceAction::Edit {
            id: e.id.clone(),
            expected_version: version,
            effective_date: "2026-10-12".into(),
            title: "R2".into(),
            interval_days: 2,
            weekdays: vec![],
            time_zone: "Asia/Hong_Kong".into(),
            expected_tasks: vec![],
            overwrite_overrides: false,
        }))
        .await
        .unwrap();
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == e.id)
        .unwrap();
    let rules = current.data["ruleHistory"]
        .as_array()
        .expect("canonical history must be exported");
    assert!(rules
        .iter()
        .any(|r| r["effectiveDate"] == "2026-10-12" && r["interval"] == 2));
}

#[tokio::test]
async fn valid_remote_long_interval_is_not_silently_changed() {
    let (_dir, store) = setup().await;
    let e = recurrence(
        json!({"title":"R","startDate":"2026-10-01","frequency":"interval",
        "interval":1000,"timeZone":"Asia/Hong_Kong"}),
    );
    pull(&store, e.clone()).await;
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == e.id)
        .unwrap();
    assert_eq!(current.data["interval"], 1000);
}

#[tokio::test]
async fn future_stop_and_unused_weekday_values_do_not_rewrite_recurrence() {
    let (_dir, store) = setup().await;
    let e = recurrence(
        json!({"title":"R","startDate":"2026-10-01","frequency":"daily",
        "interval":1,"weekdays":[1],"timeZone":"Asia/Hong_Kong","ruleHistory":[
            {"effectiveDate":"2026-10-01","frequency":"daily","interval":1,"weekdays":[1],"active":true},
            {"effectiveDate":"2026-10-04","frequency":"daily","interval":1,"weekdays":[1],"active":false}
        ]}),
    );
    pull(&store, e.clone()).await;
    store
        .recurrence_command(&command(RecurrenceAction::Expand {
            id: e.id.clone(),
            through: "2026-10-05".into(),
            batch_size: 100,
        }))
        .await
        .unwrap();
    let tasks = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "task")
        .collect::<Vec<_>>();
    assert_eq!(tasks.len(), 3);
    assert!(tasks
        .iter()
        .all(|e| e.data["originalDate"].as_str().unwrap() < "2026-10-04"));
}

#[tokio::test]
async fn mobile_record_multilinks_are_native_and_native_links_are_canonical() {
    let (_dir, store) = setup().await;
    let mut p = recurrence(json!({"title":"P","status":"active"}));
    p.kind = "project".into();
    let mut p2 = p.clone();
    p2.id = Uuid::new_v4().to_string();
    p2.data["title"] = json!("P2");
    let mut r = recurrence(json!({"title":"record","body":"B","links":[
        {"targetType":"project","targetId":p.id},{"targetType":"project","targetId":p2.id}],"projectId":p.id}));
    r.kind = "record".into();
    store
        .entities_pull(
            &Feed {
                changes: vec![Batch {
                    entities: vec![p.clone(), p2.clone(), r.clone()],
                    cursor: 1,
                    operation_id: Uuid::new_v4().to_string(),
                    device_id: Uuid::new_v4().to_string(),
                }],
                cursor: 1,
                has_more: false,
            },
            "device",
        )
        .await
        .unwrap();
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == r.id)
        .unwrap();
    assert_eq!(current.data["links"].as_array().unwrap().len(), 2);
    let native = store.content_snapshot().await.unwrap();
    assert_eq!(
        native["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == r.id)
            .unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let native_record = native["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == r.id)
        .unwrap();
    store
        .content_command(&ContentCommand {
            operation_id: Uuid::new_v4().to_string(),
            occurred_at: "2026-10-11T00:00:00Z".into(),
            action: ContentAction::Record {
                id: r.id.clone(),
                expected_version: Some(native_record["version"].as_i64().unwrap()),
                title: "Native edit".into(),
                body: "B2".into(),
                record_type: "note".into(),
                links: vec![Link {
                    target_type: "project".into(),
                    target_id: p2.id.clone(),
                }],
            },
        })
        .await
        .unwrap();
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == r.id)
        .unwrap();
    assert_eq!(
        current.data["links"],
        json!([{"targetType":"project","targetId":p2.id}])
    );
    assert_eq!(current.data["projectId"], p2.id);
}

#[tokio::test]
async fn historical_habit_zones_survive_workspace_zone_changes() {
    let (_dir, store) = setup().await;
    let mut h = recurrence(json!({"title":"H","startDate":"2026-10-01","ruleHistory":[
        {"effectiveDate":"2026-10-01","frequency":"daily","target":1,"timeZone":"America/New_York"},
        {"effectiveDate":"2026-10-12","frequency":"daily","target":1,"timeZone":"Asia/Hong_Kong"}]}));
    h.kind = "habit".into();
    pull(&store, h.clone()).await;
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == h.id)
        .unwrap();
    assert_eq!(
        current.data["ruleHistory"][0]["timeZone"],
        "America/New_York"
    );
    assert_eq!(current.data["ruleHistory"][1]["timeZone"], "Asia/Hong_Kong");
}

#[tokio::test]
async fn accepted_waiting_task_status_maps_to_native_waiting_flag() {
    let (_dir, store) = setup().await;
    let mut e = recurrence(
        json!({"title":"Waiting","status":"waiting","waitingFor":"Partner","waitingReason":"Approval"}),
    );
    e.kind = "task".into();
    pull(&store, e.clone()).await;
    let current = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == e.id)
        .unwrap();
    assert_eq!(current.data["status"], "waiting");
    assert_eq!(current.data["waiting"], true);
}

async fn mobile_views_fixture() -> (tempfile::TempDir, Store, Entity, Vec<Entity>) {
    let (dir, store) = setup().await;
    let today = chrono::Utc::now().date_naive();
    let deadline = (today + chrono::Duration::days(6)).to_string();
    let mut tasks = vec![
        recurrence(
            json!({"title":"needle high","status":"todo","priority":1,"dueDate":deadline,"startDate":today.to_string()}),
        ),
        recurrence(json!({"title":"needle medium","status":"todo","priority":3})),
        recurrence(json!({"title":"other completed","status":"completed","priority":1})),
    ];
    for t in &mut tasks {
        t.kind = "task".into();
    }
    let mut view = recurrence(
        json!({"title":"Mobile saved view","query":"needle","kind":"task","priority":"1","mode":"and","sort":"priority","group":"status","includeArchived":false}),
    );
    view.kind = "view".into();
    let mut entities = tasks.clone();
    entities.push(view.clone());
    store
        .entities_pull(
            &Feed {
                changes: vec![Batch {
                    entities,
                    cursor: 1,
                    operation_id: Uuid::new_v4().to_string(),
                    device_id: Uuid::new_v4().to_string(),
                }],
                cursor: 1,
                has_more: false,
            },
            "device",
        )
        .await
        .unwrap();
    (dir, store, view, tasks)
}
#[tokio::test]
async fn mobile_saved_view_is_valid_native_query_and_filters_same_tasks() {
    let (_dir, store, view, tasks) = mobile_views_fixture().await;
    let snapshot = store.view_snapshot().await.unwrap();
    let saved = snapshot["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view.id)
        .unwrap();
    let query: ViewQuery = serde_json::from_value(saved["query"].clone()).unwrap();
    let result = store.view_query(&query).await.unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(result["rows"][0]["id"], tasks[0].id);
    let canonical = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.id == view.id)
        .unwrap();
    assert_eq!(canonical.data["query"], "needle");
    assert_eq!(
        canonical.data["nativeQuery"]["mobileFilter"]["priority"],
        "1"
    );
    store.view_command(&serde_json::from_value(json!({"operationId":Uuid::new_v4().to_string(),"occurredAt":"2026-10-11T00:00:00Z","action":{"type":"save","id":view.id,"expectedVersion":saved["version"],"name":"Renamed mobile view","query":query,"followed":true}})).unwrap()).await.unwrap();
    let saved_again = store.view_snapshot().await.unwrap();
    assert_eq!(saved_again["views"][0]["name"], "Renamed mobile view");
    assert_eq!(
        saved_again["views"][0]["query"]["mobileFilter"]["priority"],
        "1"
    );
}
#[tokio::test]
async fn mobile_or_relative_week_and_unplanned_execution_filters_keep_semantics() {
    let (_dir, store, view, tasks) = mobile_views_fixture().await;
    let snapshot = store.view_snapshot().await.unwrap();
    let mut query = snapshot["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view.id)
        .unwrap()["query"]
        .clone();
    query["mobileFilter"] = json!({"query":"needle high","kind":"task","status":"completed","mode":"or","sort":"title"});
    let result = store
        .view_query(&serde_json::from_value(query.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 2);
    query["mobileFilter"] = json!({"kind":"task","due":"week","mode":"and"});
    let result = store
        .view_query(&serde_json::from_value(query.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(result["rows"][0]["id"], tasks[0].id);
    query["mobileFilter"] = json!({"kind":"task","query":"needle high","preset":"unplanned"});
    let result = store
        .view_query(&serde_json::from_value(query).unwrap())
        .await
        .unwrap();
    assert_eq!(
        result["rows"].as_array().unwrap().len(),
        1,
        "a start date is not an execution arrangement"
    );
}

#[tokio::test]
async fn structured_mobile_weekly_review_roundtrips_through_native_editor() {
    let (_dir, store) = setup().await;
    let mut review = recurrence(
        json!({"title":"Weekly","periodStart":"2026-10-05","periodEnd":"2026-10-11","achievements":"A","blockers":"B","stopPause":"S","nextFocus":"N",
        "body":"期间：2026-10-05 — 2026-10-11\n\n推进成果\nA\n\n阻塞\nB\n\n停止 / 暂停\nS\n\n下周重点\nN"}),
    );
    review.kind = "review".into();
    pull(&store, review.clone()).await;
    let snapshot = store.review_snapshot("2026-10-11T01:00:00Z").await.unwrap();
    let saved = snapshot["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == review.id)
        .unwrap();
    assert_eq!(saved["achievements"], "A");
    store
        .review_command(&ReviewCommand {
            operation_id: Uuid::new_v4().to_string(),
            occurred_at: "2026-10-11T01:00:00Z".into(),
            action: ReviewAction::Save {
                id: review.id.clone(),
                expected_version: Some(saved["version"].as_i64().unwrap()),
                start: "2026-10-05".into(),
                end: "2026-10-11".into(),
                achievements: "Native A2".into(),
                blockers: "B".into(),
                stop_pause: "S".into(),
                next_focus: "N".into(),
                project_ids: vec![],
            },
        })
        .await
        .unwrap();
    let exported = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == review.id)
        .unwrap();
    assert_eq!(exported.data["achievements"], "Native A2");
    assert_eq!(
        exported.data["title"], "Weekly",
        "editing review fields must preserve a mobile custom title"
    );
    assert!(exported.data["body"]
        .as_str()
        .unwrap()
        .contains("Native A2"));
    let old = exported.clone();
    let mut invalid = exported;
    invalid.data["body"] = json!("Unstructured overwrite");
    assert!(store
        .entities_edit(&Uuid::new_v4().to_string(), invalid, Some(old))
        .await
        .is_err());
}

#[tokio::test]
async fn independent_structured_review_fields_merge_without_derived_body_conflict() {
    let (_dir, store) = setup().await;
    let mut review = recurrence(
        json!({"title":"Weekly","periodStart":"2026-10-05","periodEnd":"2026-10-11","achievements":"A","blockers":"B","stopPause":"S","nextFocus":"N",
        "body":"期间：2026-10-05 — 2026-10-11\n\n推进成果\nA\n\n阻塞\nB\n\n停止 / 暂停\nS\n\n下周重点\nN"}),
    );
    review.kind = "review".into();
    pull(&store, review.clone()).await;
    let snapshot = store.review_snapshot("2026-10-11T01:00:00Z").await.unwrap();
    store
        .review_command(&ReviewCommand {
            operation_id: Uuid::new_v4().to_string(),
            occurred_at: "2026-10-11T01:00:00Z".into(),
            action: ReviewAction::Save {
                id: review.id.clone(),
                expected_version: Some(snapshot["reviews"][0]["version"].as_i64().unwrap()),
                start: "2026-10-05".into(),
                end: "2026-10-11".into(),
                achievements: "Local A".into(),
                blockers: "B".into(),
                stop_pause: "S".into(),
                next_focus: "N".into(),
                project_ids: vec![],
            },
        })
        .await
        .unwrap();
    review.version = 2;
    review.data["blockers"] = json!("Remote B");
    review.data["body"]=json!("期间：2026-10-05 — 2026-10-11\n\n推进成果\nA\n\n阻塞\nRemote B\n\n停止 / 暂停\nS\n\n下周重点\nN");
    store
        .entities_pull(
            &Feed {
                changes: vec![Batch {
                    entities: vec![review.clone()],
                    cursor: 2,
                    operation_id: Uuid::new_v4().to_string(),
                    device_id: Uuid::new_v4().to_string(),
                }],
                cursor: 2,
                has_more: false,
            },
            "device",
        )
        .await
        .unwrap();
    assert!(store
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let merged = store
        .entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == review.id)
        .unwrap();
    assert_eq!(merged.data["achievements"], "Local A");
    assert_eq!(merged.data["blockers"], "Remote B");
    let body = merged.data["body"].as_str().unwrap();
    assert!(body.contains("Local A") && body.contains("Remote B"));
}
