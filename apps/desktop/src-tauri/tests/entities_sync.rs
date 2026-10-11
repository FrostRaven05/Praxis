use praxis_desktop_lib::store::{
    entities::{Batch, Entity, Feed},
    AddSubtasksCommand, CaptureCommand, ContentAction, ContentCommand, NewProjectTask, Output,
    Store,
};
use serde_json::{json, Value};
use uuid::Uuid;
fn entity(kind: &str, data: Value) -> Entity {
    Entity {
        id: Uuid::new_v4().to_string(),
        kind: kind.into(),
        version: 1,
        data,
        deleted: false,
        created_at: "2026-10-11T00:00:00Z".into(),
        updated_at: "2026-10-11T00:00:00Z".into(),
    }
}
fn feed(entities: Vec<Entity>, cursor: i64) -> Feed {
    Feed {
        changes: vec![Batch {
            entities,
            cursor,
            operation_id: Uuid::new_v4().to_string(),
            device_id: Uuid::new_v4().to_string(),
        }],
        cursor,
        has_more: false,
    }
}
async fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("sync.db")).await.unwrap();
    (dir, store)
}
async fn get(s: &Store, id: &str) -> Entity {
    s.entities_snapshot()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.id == id)
        .unwrap()
}
async fn edit(s: &Store, id: &str, key: &str, value: Value) {
    let old = get(s, id).await;
    let mut next = old.clone();
    next.data[key] = value;
    s.entities_edit(&Uuid::new_v4().to_string(), next, Some(old))
        .await
        .unwrap();
}
#[tokio::test]
async fn remote_unschedule_and_plan_delete_do_not_reappear_in_projection() {
    let (_dir, s) = setup().await;
    let mut task = entity(
        "task",
        json!({"title":"T","status":"todo","executionDate":"2026-10-11"}),
    );
    let mut plan = entity(
        "plan",
        json!({"date":"2026-10-11","taskIds":[task.id],"outcome":"done"}),
    );
    s.entities_pull(&feed(vec![task.clone(), plan.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(s.list_day("2026-10-11").await.unwrap().len(), 1);
    task.version = 2;
    task.data["executionDate"] = Value::Null;
    plan.version = 2;
    plan.deleted = true;
    s.entities_pull(&feed(vec![task.clone(), plan.clone()], 2), "device")
        .await
        .unwrap();
    assert!(s.list_day("2026-10-11").await.unwrap().is_empty());
    assert!(get(&s, &plan.id).await.deleted);
    assert!(get(&s, &task.id).await.data["executionDate"].is_null());
}
#[tokio::test]
async fn independent_pull_fields_merge_without_conflict() {
    let (_dir, s) = setup().await;
    let mut task = entity("task", json!({"title":"T","status":"todo","priority":0}));
    s.entities_pull(&feed(vec![task.clone()], 1), "device")
        .await
        .unwrap();
    edit(&s, &task.id, "title", json!("local")).await;
    task.version = 2;
    task.data["priority"] = json!(2);
    s.entities_pull(&feed(vec![task.clone()], 2), "device")
        .await
        .unwrap();
    let current = get(&s, &task.id).await;
    assert_eq!(current.data["title"], "local");
    assert_eq!(current.data["priority"], 2);
    assert!(s
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn merged_upload_receipt_keeps_independent_remote_field_during_local_edit() {
    let (_dir, s) = setup().await;
    let task = entity("task", json!({"title":"T","status":"todo","priority":0}));
    s.entities_pull(&feed(vec![task.clone()], 1), "device")
        .await
        .unwrap();
    edit(&s, &task.id, "title", json!("first")).await;
    let command = s
        .entities_prepare("device")
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.changes.iter().any(|e| e.id == task.id))
        .unwrap();
    edit(&s, &task.id, "title", json!("newer")).await;
    let receipts = command
        .changes
        .iter()
        .map(|c| {
            let mut e = Entity {
                id: c.id.clone(),
                kind: c.kind.clone(),
                version: 2,
                data: c.data.clone(),
                deleted: c.deleted,
                created_at: c.created_at.clone(),
                updated_at: "2026-10-11T01:00:00Z".into(),
            };
            if e.id == task.id {
                e.data["priority"] = json!(2);
            }
            e
        })
        .collect::<Vec<_>>();
    s.entities_ack(&command, &receipts).await.unwrap();
    let current = get(&s, &task.id).await;
    assert_eq!(current.data["title"], "newer");
    assert_eq!(current.data["priority"], 2);
}
#[tokio::test]
async fn routine_restart_rebase_preserves_unsent_changes_without_false_conflict() {
    let (_dir, s) = setup().await;
    let task = entity("task", json!({"title":"T","status":"todo","priority":0}));
    s.entities_rebase(&[task.clone()], 1, &Uuid::new_v4().to_string(), "device")
        .await
        .unwrap();
    edit(&s, &task.id, "title", json!("unsent")).await;
    s.entities_rebase(&[task.clone()], 1, &Uuid::new_v4().to_string(), "device")
        .await
        .unwrap();
    assert_eq!(get(&s, &task.id).await.data["title"], "unsent");
    assert!(s
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn habit_schedule_identity_and_sunday_recurrence_roundtrip() {
    let (_dir, s) = setup().await;
    let habit = entity(
        "habit",
        json!({"title":"H","startDate":"2026-10-01","ruleHistory":[{"effectiveDate":"2026-10-01","frequency":"daily","target":1},{"effectiveDate":"2026-10-11","frequency":"weekly","target":2}]}),
    );
    let recurrence = entity(
        "recurrence",
        json!({"title":"R","startDate":"2026-10-01","frequency":"weekdays","weekdays":[0],"timeZone":"Asia/Hong_Kong"}),
    );
    s.entities_pull(&feed(vec![habit.clone(), recurrence.clone()], 1), "device")
        .await
        .unwrap();
    let snapshot = s.entities_snapshot().await.unwrap();
    let rules = snapshot
        .iter()
        .filter(|e| e.kind == "desktop_row" && e.data["table"] == "habit_schedules")
        .collect::<Vec<_>>();
    assert_eq!(rules.len(), 2);
    assert!(rules.iter().all(|e| e.data["row"]["version"].is_i64()));
    assert_ne!(
        rules[0].data["row"]["version"],
        rules[1].data["row"]["version"]
    );
    assert_eq!(get(&s, &recurrence.id).await.data["weekdays"], json!([0]));
}
#[tokio::test]
async fn interval_habit_does_not_poison_the_entire_remote_batch() {
    let (_dir, s) = setup().await;
    let habit = entity(
        "habit",
        json!({"title":"Every other day","startDate":"2026-10-01","frequency":"interval","interval":2}),
    );
    let task = entity("task", json!({"title":"independent","status":"todo"}));
    s.entities_pull(&feed(vec![habit.clone(), task.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(get(&s, &habit.id).await.data["frequency"], "interval");
    assert_eq!(get(&s, &task.id).await.data["title"], "independent");
}

fn content(action: ContentAction) -> ContentCommand {
    ContentCommand {
        operation_id: Uuid::new_v4().to_string(),
        occurred_at: "2026-10-11T01:00:00Z".into(),
        action,
    }
}

#[tokio::test]
async fn mobile_clarification_projects_native_resolution_and_native_undo() {
    let (_dir, s) = setup().await;
    let mut capture = entity("capture", json!({"rawText":"raw", "status":"inbox"}));
    s.entities_pull(&feed(vec![capture.clone()], 1), "device")
        .await
        .unwrap();
    let mut task = entity(
        "task",
        json!({"title":"output", "status":"todo", "sourceCaptureId":capture.id}),
    );
    capture.version = 2;
    // Mobile retains the desktop extension when changing the canonical status.
    capture.data["state"] = json!("pending");
    capture.data["status"] = json!("clarified");
    capture.data["outputs"] = json!([{ "id":task.id,"kind":"task","version":1 }]);
    s.entities_pull(&feed(vec![task.clone(), capture.clone()], 2), "device")
        .await
        .unwrap();
    let snapshot = s.content_snapshot().await.unwrap();
    assert_eq!(snapshot["captures"][0]["state"], "processed");
    assert_eq!(snapshot["resolutions"][0]["outputs"][0]["title"], "output");
    let resolution = snapshot["captures"][0]["resolutionId"]
        .as_str()
        .unwrap()
        .to_owned();
    // A later remote edit must protect outputs even though resolution still points to them.
    task.version = 2;
    task.data["title"] = json!("edited output");
    s.entities_pull(&feed(vec![task.clone()], 3), "device")
        .await
        .unwrap();
    assert!(s
        .content_command(&content(ContentAction::Undo {
            resolution_id: resolution.clone(),
            keep_outputs: false
        }))
        .await
        .is_err());
    s.content_command(&content(ContentAction::Undo {
        resolution_id: resolution,
        keep_outputs: true,
    }))
    .await
    .unwrap();
    let current = get(&s, &capture.id).await;
    assert_eq!(current.data["status"], "inbox");
    assert_eq!(current.data["outputs"], json!([]));
    assert_eq!(current.data["lastOutputs"][0]["id"], task.id);
    assert!(!get(&s, &task.id).await.deleted);
}

#[tokio::test]
async fn desktop_clarification_exports_mobile_receipt_and_mobile_undo_clears_native_state() {
    let (_dir, s) = setup().await;
    let capture = entity("capture", json!({"rawText":"raw", "status":"inbox"}));
    s.entities_pull(&feed(vec![capture.clone()], 1), "device")
        .await
        .unwrap();
    let output = Uuid::new_v4().to_string();
    let expected_version = s.content_snapshot().await.unwrap()["captures"][0]["version"]
        .as_i64()
        .unwrap();
    s.content_command(&content(ContentAction::Resolve {
        capture_id: capture.id.clone(),
        expected_version,
        outputs: vec![Output {
            id: output.clone(),
            kind: "record".into(),
            title: "note".into(),
            body: "body".into(),
        }],
        project_id: None,
        new_project: None,
    }))
    .await
    .unwrap();
    let mut clarified = get(&s, &capture.id).await;
    assert_eq!(clarified.data["status"], "clarified");
    assert_eq!(
        clarified.data["outputs"],
        json!([{ "id":output,"kind":"record","version":1 }])
    );
    // Preserve a frozen clarification receipt when its output is edited later.
    edit(&s, &output, "title", json!("changed")).await;
    assert_eq!(
        get(&s, &capture.id).await.data["outputs"],
        clarified.data["outputs"]
    );
    clarified.version += 1;
    clarified.data["status"] = json!("inbox");
    clarified.data["lastOutputs"] = clarified.data["outputs"].clone();
    clarified.data["outputs"] = json!([]);
    // Rebase the unuploaded desktop changes to simulate their server receipt before mobile undo.
    let snapshot = s.entities_snapshot().await.unwrap();
    s.entities_rebase(&snapshot, 2, &Uuid::new_v4().to_string(), "device")
        .await
        .unwrap();
    s.entities_pull(&feed(vec![clarified.clone()], 3), "device")
        .await
        .unwrap();
    let native = s.content_snapshot().await.unwrap();
    assert_eq!(native["captures"][0]["state"], "pending");
    assert!(!native["resolutions"][0]["undoneAt"].is_null());
}

#[tokio::test]
async fn changing_native_record_type_keeps_registered_wire_kind() {
    let (_dir, s) = setup().await;
    let record = entity(
        "record",
        json!({"title":"note","body":"body","type":"note"}),
    );
    s.entities_pull(&feed(vec![record.clone()], 1), "device")
        .await
        .unwrap();
    let expected_version = s.content_snapshot().await.unwrap()["records"][0]["version"]
        .as_i64()
        .unwrap();
    s.content_command(&content(ContentAction::Record {
        id: record.id.clone(),
        expected_version: Some(expected_version),
        title: "decision".into(),
        body: "body".into(),
        record_type: "decision".into(),
        links: vec![],
    }))
    .await
    .unwrap();
    assert_eq!(get(&s, &record.id).await.kind, "record");
    let command = s
        .entities_prepare("device")
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.changes.iter().any(|e| e.id == record.id))
        .unwrap();
    assert_eq!(
        command
            .changes
            .iter()
            .find(|e| e.id == record.id)
            .unwrap()
            .kind,
        "record"
    );
}

#[tokio::test]
async fn mobile_reclarification_keeps_prior_resolution_history_and_accepts_trashed_output() {
    let (_dir, s) = setup().await;
    let mut capture = entity("capture", json!({"rawText":"raw","status":"clarified"}));
    let mut task = entity(
        "task",
        json!({"title":"first","status":"todo","sourceCaptureId":capture.id}),
    );
    capture.data["outputs"] = json!([{ "id":task.id,"kind":"task","version":1 }]);
    s.entities_pull(&feed(vec![task.clone(), capture.clone()], 1), "device")
        .await
        .unwrap();
    let first = s.content_snapshot().await.unwrap()["captures"][0]["resolutionId"].clone();
    capture.version = 2;
    capture.data["resolutionId"] = first.clone();
    capture.data["status"] = json!("inbox");
    capture.data["lastOutputs"] = capture.data["outputs"].clone();
    capture.data["outputs"] = json!([]);
    task.version = 2;
    task.deleted = true;
    s.entities_pull(&feed(vec![task.clone(), capture.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        s.content_snapshot().await.unwrap()["captures"][0]["retainedOutputs"],
        0
    );
    let next = entity(
        "task",
        json!({"title":"second","status":"todo","sourceCaptureId":capture.id}),
    );
    capture.version = 3;
    capture.data["status"] = json!("clarified");
    capture.data["outputs"] = json!([{ "id":next.id,"kind":"task","version":1 }]);
    s.entities_pull(&feed(vec![next.clone(), capture.clone()], 3), "device")
        .await
        .unwrap();
    let native = s.content_snapshot().await.unwrap();
    assert_ne!(native["captures"][0]["resolutionId"], first);
    assert_eq!(native["resolutions"].as_array().unwrap().len(), 2);
    let mut deleted = next.clone();
    deleted.version = 2;
    deleted.deleted = true;
    s.entities_pull(&feed(vec![deleted.clone()], 4), "device")
        .await
        .unwrap();
    let mut cap = capture.clone();
    cap.version = 4;
    cap.data["rawText"] = json!("still clarified");
    s.entities_pull(&feed(vec![cap], 5), "device")
        .await
        .unwrap();
    assert_eq!(
        s.content_snapshot().await.unwrap()["captures"][0]["state"],
        "processed"
    );
}

#[tokio::test]
async fn existing_native_nested_subtasks_do_not_block_unrelated_sync() {
    let (_dir, s) = setup().await;
    let root = Uuid::new_v4().to_string();
    s.capture(&CaptureCommand {
        operation_id: Uuid::new_v4().to_string(),
        task_id: root.clone(),
        plan_id: Uuid::new_v4().to_string(),
        title: "Root".into(),
        execution_date: "2026-10-11".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-10-11T00:00:00Z".into(),
    })
    .await
    .unwrap();
    let child = Uuid::new_v4().to_string();
    let leaf = Uuid::new_v4().to_string();
    for (parent, id) in [(&root, &child), (&child, &leaf)] {
        s.add_subtasks(&AddSubtasksCommand {
            operation_id: Uuid::new_v4().to_string(),
            parent_task_id: parent.clone(),
            expected_version: 0,
            confirm_summary_plan: true,
            tasks: vec![NewProjectTask {
                task_id: id.clone(),
                title: "Nested".into(),
            }],
            occurred_at: "2026-10-11T00:00:00Z".into(),
        })
        .await
        .unwrap();
    }
    let record = entity("record", json!({"title":"Remote","body":"Unaffected"}));
    s.entities_pull(&feed(vec![record.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(get(&s, &leaf).await.data["parentId"], child);
    assert_eq!(get(&s, &child).await.data["parentId"], root);
    assert_eq!(get(&s, &record.id).await.data["body"], "Unaffected");
}

#[tokio::test]
async fn nested_sync_tree_rejects_ancestor_cycles_and_deleted_parents_atomically() {
    let (_dir, s) = setup().await;
    let mut root = entity("task", json!({"title":"Root","status":"todo"}));
    let child = entity(
        "task",
        json!({"title":"Child","status":"todo","parentId":root.id}),
    );
    let leaf = entity(
        "task",
        json!({"title":"Leaf","status":"todo","parentId":child.id}),
    );
    s.entities_pull(
        &feed(vec![root.clone(), child.clone(), leaf.clone()], 1),
        "device",
    )
    .await
    .unwrap();
    let before = serde_json::to_value(s.entities_snapshot().await.unwrap()).unwrap();
    root.version = 2;
    root.data["parentId"] = json!(leaf.id);
    assert!(s
        .entities_pull(&feed(vec![root.clone()], 2), "device")
        .await
        .unwrap_err()
        .contains("父子"));
    assert_eq!(
        serde_json::to_value(s.entities_snapshot().await.unwrap()).unwrap(),
        before
    );
    root.data.as_object_mut().unwrap().remove("parentId");
    root.deleted = true;
    assert!(s
        .entities_pull(&feed(vec![root], 2), "device")
        .await
        .unwrap_err()
        .contains("父子"));
    assert_eq!(
        serde_json::to_value(s.entities_snapshot().await.unwrap()).unwrap(),
        before
    );
    let record = entity("record", json!({"title":"Next valid batch"}));
    s.entities_pull(&feed(vec![record.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(get(&s, &record.id).await.data["title"], "Next valid batch");
}
