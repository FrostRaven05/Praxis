use praxis_desktop_lib::store::{
    entities::{Batch, Command, Entity, Feed},
    lan::LanCapture,
    CaptureCommand, ContentAction, ContentCommand, HabitCommand, Output, PlanChange, PlanCommand,
    ProductivityCommand, ScheduleCommand, Store, TaskDetailsCommand,
};
use serde_json::{json, Value};
use uuid::Uuid;
fn id() -> String {
    Uuid::new_v4().to_string()
}
const AT: &str = "2026-10-11T00:00:00Z";

#[tokio::test]
async fn remote_composite_key_daily_row_invalidates_stale_native_editor_version() {
    let (_dir, s) = setup().await;
    save(&s, json!({"type":"day","date":"2026-10-11","outcome":"Original","closing":"","focusIds":[],"expectedVersion":null})).await;
    acknowledge_all(&s).await;
    let mut auxiliary = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.kind == "desktop_row" && e.data["table"] == "day_notes")
        .unwrap();
    auxiliary.version += 10;
    auxiliary.data["row"]["outcome"] = json!("First remote result");
    s.entities_pull(&feed(vec![auxiliary.clone()], 1), "device")
        .await
        .unwrap();
    let before = s.productivity_snapshot().await.unwrap();
    let held_version = before["days"][0]["version"].as_i64().unwrap();
    auxiliary.version += 1;
    auxiliary.data["row"]["outcome"] = json!("New remote result");
    s.entities_pull(&feed(vec![auxiliary], 2), "device")
        .await
        .unwrap();
    let stale: ProductivityCommand = serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"day","date":"2026-10-11","outcome":"Stale local overwrite","closing":"","focusIds":[],"expectedVersion":held_version}})).unwrap();
    assert!(
        s.productivity_command(&stale).await.is_err(),
        "a remote result change must invalidate the held editor version"
    );
    let after = s.productivity_snapshot().await.unwrap();
    assert_eq!(after["days"][0]["outcome"], "New remote result");
    assert!(after["days"][0]["version"].as_i64().unwrap() > held_version);
}

async fn legacy_capture(s: &Store) -> Entity {
    let capture_id = id();
    s.content_command(&ContentCommand {
        operation_id: id(),
        occurred_at: "2026-10-01T00:00:00Z".into(),
        action: ContentAction::Capture {
            id: capture_id.clone(),
            raw_text: "Legacy original".into(),
        },
    })
    .await
    .unwrap();
    let command = s
        .lan_prepare("device")
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.id == capture_id)
        .unwrap();
    s.lan_ack(
        &command,
        &LanCapture {
            id: capture_id.clone(),
            version: 1,
            raw_text: command.raw_text.clone(),
            deleted: false,
            updated_at: AT.into(),
        },
    )
    .await
    .unwrap();
    s.entities_prepare("device").await.unwrap();
    let mut remote = snapshot(s)
        .await
        .into_iter()
        .find(|e| e.id == capture_id)
        .unwrap();
    remote.version = 2;
    remote.created_at = AT.into();
    remote.data["desktop"]["created_at"] = json!(AT);
    remote
}

#[tokio::test]
async fn legacy_capture_rebase_adopts_wire_creation_time_without_changing_native_creation_time() {
    let (_dir, s) = setup().await;
    let remote = legacy_capture(&s).await;
    s.entities_rebase(&[remote.clone()], 1, &id(), "device")
        .await
        .unwrap();
    assert!(s
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let current = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == remote.id)
        .unwrap();
    assert_eq!(current.created_at, AT);
    assert_eq!(current.data["desktop"]["created_at"], AT);
    let native = s.content_snapshot().await.unwrap();
    assert_eq!(native["captures"][0]["createdAt"], "2026-10-01T00:00:00Z");
    assert_eq!(native["captures"][0]["rawText"], "Legacy original");
    assert!(s.entities_prepare("device").await.unwrap().iter().all(|c| c
        .changes
        .iter()
        .all(|e| e.id != remote.id || e.created_at == AT)));
    s.lan_edit_capture(
        &id(),
        &remote.id,
        native["captures"][0]["version"].as_i64().unwrap(),
        "Edited after upgrade",
    )
    .await
    .unwrap();
    let command = s
        .entities_prepare("device")
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.changes.iter().any(|e| e.id == remote.id))
        .unwrap();
    let change = command.changes.iter().find(|e| e.id == remote.id).unwrap();
    assert_eq!(change.created_at, AT);
    assert_eq!(change.expected_version, Some(remote.version));
    assert_eq!(change.data["desktop"]["created_at"], AT);
    acknowledge(&s, &command).await;
    assert_eq!(
        s.content_snapshot().await.unwrap()["captures"][0]["createdAt"],
        "2026-10-01T00:00:00Z"
    );
    let mut next = remote.clone();
    next.version += 2;
    next.data["rawText"] = json!("Remote follow-up");
    next.data["desktop"]["raw_text"] = json!("Remote follow-up");
    s.entities_pull(&feed(vec![next], 2), "device")
        .await
        .unwrap();
    let native = s.content_snapshot().await.unwrap();
    assert_eq!(native["captures"][0]["createdAt"], "2026-10-01T00:00:00Z");
    assert_eq!(native["captures"][0]["rawText"], "Remote follow-up");
}

#[tokio::test]
async fn legacy_capture_creation_normalization_preserves_real_business_conflicts_and_resolution() {
    for scenario in ["rawText", "status", "custom", "legacyBareStatus"] {
        let (_dir, s) = setup().await;
        let mut remote = legacy_capture(&s).await;
        let native = s.content_snapshot().await.unwrap();
        if scenario == "rawText" {
            s.lan_edit_capture(
                &id(),
                &remote.id,
                native["captures"][0]["version"].as_i64().unwrap(),
                "Local changed text",
            )
            .await
            .unwrap();
            remote.data["rawText"] = json!("Remote changed text");
            remote.data["desktop"]["raw_text"] = json!("Remote changed text");
        } else if scenario == "status" || scenario == "legacyBareStatus" {
            s.content_command(&ContentCommand {
                operation_id: id(),
                occurred_at: AT.into(),
                action: ContentAction::Resolve {
                    capture_id: remote.id.clone(),
                    expected_version: native["captures"][0]["version"].as_i64().unwrap(),
                    outputs: vec![Output {
                        id: id(),
                        kind: "record".into(),
                        title: "Saved output".into(),
                        body: "Kept content".into(),
                    }],
                    project_id: None,
                    new_project: None,
                },
            })
            .await
            .unwrap();
            if scenario == "legacyBareStatus" {
                remote.data = json!({"rawText":"Legacy original","status":"inbox"});
            }
        } else {
            let old = snapshot(&s)
                .await
                .into_iter()
                .find(|e| e.id == remote.id)
                .unwrap();
            let mut next = old.clone();
            next.data["custom"] = json!("Local custom");
            s.entities_edit(&id(), next, Some(old)).await.unwrap();
            remote.data["custom"] = json!("Remote custom");
        }
        s.entities_rebase(&[remote.clone()], 1, &id(), "device")
            .await
            .unwrap();
        let conflicts = s.entities_conflicts().await.unwrap();
        assert_eq!(
            conflicts.as_array().unwrap().len(),
            1,
            "{scenario} must stay visible"
        );
        assert_eq!(
            s.content_snapshot().await.unwrap()["captures"][0]["createdAt"],
            "2026-10-01T00:00:00Z"
        );
        if scenario == "rawText" {
            let conflict = &conflicts[0];
            s.entities_resolve(
                conflict["operationId"].as_str().unwrap(),
                &id(),
                "remote",
                conflict["token"].as_str().unwrap(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(
                s.content_snapshot().await.unwrap()["captures"][0]["rawText"],
                "Remote changed text"
            );
            assert_eq!(
                s.content_snapshot().await.unwrap()["captures"][0]["createdAt"],
                "2026-10-01T00:00:00Z"
            );
            assert_eq!(
                snapshot(&s)
                    .await
                    .into_iter()
                    .find(|e| e.id == remote.id)
                    .unwrap()
                    .created_at,
                AT
            );
        }
    }
}
#[tokio::test]
async fn mobile_habit_check_tombstone_retains_status_and_same_identity_restores_without_false_conflict(
) {
    let (_dir, s) = setup().await;
    let habit = entity(
        "habit",
        json!({"title":"reading","startDate":"2026-10-01","frequency":"daily"}),
    );
    let mut check = entity(
        "habit_check",
        json!({"habitId":habit.id,"date":"2026-10-11","status":"done","note":"read chapter","timeZone":"Asia/Hong_Kong","recordedAt":AT}),
    );
    s.entities_pull(&feed(vec![habit.clone(), check.clone()], 1), "device")
        .await
        .unwrap();
    acknowledge_all(&s).await;
    check.version = 2;
    check.deleted = true;
    s.entities_pull(&feed(vec![check.clone()], 2), "device")
        .await
        .unwrap();
    let deleted = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == check.id)
        .unwrap();
    assert!(deleted.deleted);
    assert_eq!(deleted.data["status"], "done");
    assert_eq!(deleted.data["recordedAt"], AT);
    for change in s
        .entities_prepare("device")
        .await
        .unwrap()
        .iter()
        .flat_map(|c| &c.changes)
        .filter(|e| e.id == check.id)
    {
        assert!(change.deleted);
        assert_eq!(change.data["status"], "done");
    }
    check.version = 3;
    check.deleted = false;
    s.entities_pull(&feed(vec![check.clone()], 3), "device")
        .await
        .unwrap();
    let restored = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == check.id)
        .unwrap();
    assert!(!restored.deleted);
    assert_eq!(restored.data["status"], "done");
    assert!(s
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn task_estimate_roundtrips_through_native_details_without_being_opaque() {
    let (_dir, s) = setup().await;
    let task = entity(
        "task",
        json!({"title":"estimate","status":"todo","estimatedMinutes":20}),
    );
    s.entities_pull(&feed(vec![task.clone()], 1), "device")
        .await
        .unwrap();
    let details = s.task_details(&task.id).await.unwrap();
    assert_eq!(details.estimated_minutes, Some(20));
    s.save_task_details(&TaskDetailsCommand {
        operation_id: id(),
        task_id: task.id.clone(),
        expected_version: details.version,
        title: details.title,
        notes: details.notes,
        completion_criteria: details.completion_criteria,
        important: details.important,
        deadline: details.deadline,
        deadline_time_zone: details.deadline_time_zone,
        estimated_minutes: Some(45),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        snapshot(&s)
            .await
            .iter()
            .find(|e| e.id == task.id)
            .unwrap()
            .data["estimatedMinutes"],
        45
    );
}
#[tokio::test]
async fn legacy_null_date_projection_keeps_native_instant_extension_when_only_title_changes() {
    let (_dir, s) = setup().await;
    let instant = json!({"kind":"instant","atUtc":"2026-10-12T02:00:00Z","displayTimezone":"America/Los_Angeles"});
    let mut task = entity(
        "task",
        json!({"title":"legacy","status":"todo","dueDate":null,"desktop":{"deadline_value":instant.to_string()}}),
    );
    s.entities_pull(&feed(vec![task.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"][0]["deadline"],
        instant
    );
    task.version = 2;
    task.data["title"] = json!("phone changed title");
    s.entities_pull(&feed(vec![task.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"][0]["deadline"],
        instant
    );
    assert_eq!(
        snapshot(&s)
            .await
            .iter()
            .find(|e| e.id == task.id)
            .unwrap()
            .data["dueDate"],
        "2026-10-11"
    );
}
#[tokio::test]
async fn instant_time_attributes_survive_phone_title_edits_and_explicit_date_changes_are_applied() {
    let (_dir, s) = setup().await;
    let task = id();
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    let plan =
        json!({"kind":"instant","atUtc":"2026-10-11T23:00:00Z","displayTimezone":"Asia/Hong_Kong"});
    let deadline = json!({"kind":"instant","atUtc":"2026-10-12T02:00:00Z","displayTimezone":"America/Los_Angeles"});
    let follow =
        json!({"kind":"instant","atUtc":"2026-10-13T06:00:00Z","displayTimezone":"Asia/Hong_Kong"});
    save(&s,json!({"type":"task","id":task,"expectedVersion":null,"title":"instant task","notes":"","projectId":null,"plan":plan,"deadline":deadline,"followUp":follow,"priority":4,"waitingFor":"","waitingNote":"","labels":[]})).await;
    let expected_version = s.task_details(&task).await.unwrap().version;
    s.schedule_task(&ScheduleCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: id(),
        expected_version,
        execution_date: "2026-10-14".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    let expected = s.task_details(&task).await.unwrap().version;
    save(&s,json!({"type":"task","id":task,"expectedVersion":expected,"title":"instant task","notes":"","projectId":null,"plan":plan,"deadline":deadline,"followUp":follow,"priority":4,"waitingFor":"","waitingNote":"","labels":[]})).await;
    acknowledge_all(&s).await;
    let mut remote = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == task)
        .unwrap();
    assert_eq!(remote.data["startDate"], "2026-10-12");
    assert_eq!(remote.data["dueDate"], "2026-10-11");
    assert_eq!(remote.data["followUpDate"], "2026-10-13");
    assert_eq!(remote.data["executionDate"], "2026-10-14");
    remote.version = 2;
    remote.data["title"] = json!("phone title");
    s.entities_pull(&feed(vec![remote.clone()], 1), "device")
        .await
        .unwrap();
    let native = s.productivity_snapshot().await.unwrap();
    let native = native["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == task)
        .unwrap();
    assert_eq!(native["plan"], plan);
    assert_eq!(native["deadline"], deadline);
    assert_eq!(native["followUp"], follow);
    assert_eq!(s.list_day("2026-10-14").await.unwrap().len(), 1);
    remote.version = 3;
    remote.data["dueDate"] = Value::Null;
    remote.data["followUpDate"] = json!("2026-10-15");
    s.entities_pull(&feed(vec![remote.clone()], 2), "device")
        .await
        .unwrap();
    let native = s.productivity_snapshot().await.unwrap();
    let native = native["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == task)
        .unwrap();
    assert_eq!(native["plan"], plan);
    assert!(native["deadline"].is_null());
    assert_eq!(
        native["followUp"],
        json!({"kind":"date","date":"2026-10-15"})
    );
    assert!(s.task_details(&task).await.unwrap().deadline.is_none());
    assert_eq!(s.list_day("2026-10-14").await.unwrap().len(), 1);
}
#[tokio::test]
async fn one_alias_tombstone_keeps_shared_native_row_and_never_revives_deleted_wire_identity() {
    let (_dir, s) = setup().await;
    let local_label = id();
    save(
        &s,
        json!({"type":"label","id":local_label,"name":"shared","expectedVersion":null}),
    )
    .await;
    acknowledge_all(&s).await;
    let original = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.kind == "desktop_row" && e.data["table"] == "labels")
        .unwrap();
    let mut alias = original.clone();
    alias.id = id();
    alias.version = 1;
    alias.data["row"]["id"] = json!(id());
    s.entities_pull(&feed(vec![alias.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["labels"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    alias.deleted = true;
    alias.version = 2;
    s.entities_pull(&feed(vec![alias.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["labels"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "one wire alias must not delete a row still represented by another live alias"
    );
    let state = snapshot(&s).await;
    assert!(state.iter().find(|e| e.id == alias.id).unwrap().deleted);
    assert!(!state.iter().find(|e| e.id == original.id).unwrap().deleted);
    let pending = s.entities_prepare("device").await.unwrap();
    assert!(!pending
        .iter()
        .flat_map(|c| &c.changes)
        .any(|e| (e.id == alias.id && !e.deleted) || (e.id == original.id && e.deleted)));
    let mut last = original.clone();
    last.version += 1;
    last.deleted = true;
    s.entities_pull(&feed(vec![last.clone()], 3), "device")
        .await
        .unwrap();
    assert!(s.productivity_snapshot().await.unwrap()["labels"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(snapshot(&s)
        .await
        .iter()
        .filter(|e| [&alias.id, &original.id].contains(&&e.id))
        .all(|e| e.deleted));
}
#[tokio::test]
async fn alias_tombstone_preserves_foreign_refs_and_last_alias_delete_with_live_refs_rolls_back() {
    let (_dir, s) = setup().await;
    let label = id();
    let task = id();
    save(
        &s,
        json!({"type":"label","id":label,"name":"shared","expectedVersion":null}),
    )
    .await;
    save(&s,json!({"type":"task","id":task,"expectedVersion":null,"title":"tagged task","notes":"","projectId":null,"plan":null,"deadline":null,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[label]})).await;
    acknowledge_all(&s).await;
    let original = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.kind == "desktop_row" && e.data["table"] == "labels")
        .unwrap();
    let mut alias = original.clone();
    alias.id = id();
    alias.version = 1;
    alias.data["row"]["id"] = json!(id());
    s.entities_pull(&feed(vec![alias.clone()], 1), "device")
        .await
        .unwrap();
    alias.deleted = true;
    alias.version = 2;
    s.entities_pull(&feed(vec![alias.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"][0]["labels"],
        json!([label])
    );
    let mut last = original.clone();
    last.version += 1;
    last.deleted = true;
    assert!(s
        .entities_pull(&feed(vec![last.clone()], 3), "device")
        .await
        .is_err());
    assert_eq!(s.entities_cursor().await.unwrap(), 2);
    let state = snapshot(&s).await;
    assert!(state.iter().find(|e| e.id == alias.id).unwrap().deleted);
    assert!(!state.iter().find(|e| e.id == original.id).unwrap().deleted);
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"][0]["labels"],
        json!([label])
    );
}
async fn setup() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("identity.db")).await.unwrap();
    (d, s)
}
fn entity(kind: &str, data: Value) -> Entity {
    Entity {
        id: id(),
        kind: kind.into(),
        version: 1,
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
async fn save(s: &Store, action: Value) {
    let c: ProductivityCommand =
        serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":action}))
            .unwrap();
    s.productivity_command(&c).await.unwrap();
}
async fn acknowledge(s: &Store, c: &Command) {
    let receipt = c
        .changes
        .iter()
        .map(|c| Entity {
            id: c.id.clone(),
            kind: c.kind.clone(),
            version: c.expected_version.unwrap_or(0) + 1,
            data: c.data.clone(),
            deleted: c.deleted,
            created_at: c.created_at.clone(),
            updated_at: AT.into(),
        })
        .collect::<Vec<_>>();
    s.entities_ack(c, &receipt).await.unwrap();
}
async fn acknowledge_all(s: &Store) {
    for _ in 0..8 {
        let commands = s.entities_prepare("device").await.unwrap();
        if commands.is_empty() {
            return;
        }
        for c in commands {
            acknowledge(s, &c).await;
        }
    }
    panic!("projection manufactured more than eight rounds of upload");
}
async fn snapshot(s: &Store) -> Vec<Entity> {
    s.entities_snapshot().await.unwrap()
}
#[tokio::test]
async fn native_label_name_collision_is_safe_and_does_not_stall_whole_batch() {
    let (_d, s) = setup().await;
    let local = id();
    save(
        &s,
        json!({"type":"label","id":local,"name":"shared","expectedVersion":null}),
    )
    .await;
    let remote_label = id();
    let remote = entity(
        "desktop_row",
        json!({"table":"labels","row":{"id":remote_label,"name":"shared"}}),
    );
    let task = entity(
        "task",
        json!({"title":"independent","status":"todo","tags":["shared"]}),
    );
    let link = entity(
        "desktop_row",
        json!({"table":"task_labels","row":{"task_id":task.id,"label_id":remote_label}}),
    );
    s.entities_pull(&feed(vec![link.clone(), remote, task.clone()], 1), "device")
        .await
        .unwrap();
    assert!(snapshot(&s).await.iter().any(|e| e.id == task.id));
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["labels"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"][0]["labels"],
        json!([local])
    );
    let wire = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == link.id)
        .unwrap();
    assert_eq!(wire.data["row"]["label_id"], remote_label);
}
#[tokio::test]
async fn native_daily_plan_collision_preserves_existing_arrangement_and_accepts_remote_identity() {
    let (_d, s) = setup().await;
    let task = id();
    let plan = id();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: task.clone(),
        plan_id: plan.clone(),
        title: "existing".into(),
        execution_date: "2026-10-11".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    s.update_plan(&PlanCommand {
        operation_id: id(),
        date: "2026-10-11".into(),
        occurred_at: AT.into(),
        changes: vec![PlanChange {
            task_id: task.clone(),
            plan_id: plan.clone(),
            expected_version: 0,
            is_focus: true,
            estimated_minutes: Some(45),
            focus_rank: 1,
            day_period: None,
            day_rank: None,
        }],
    })
    .await
    .unwrap();
    let original = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.kind == "desktop_row" && e.data["table"] == "daily_plan_items")
        .unwrap();
    let mut remote = original.clone();
    remote.id = id();
    remote.data["row"]["id"] = json!(id());
    remote.data["row"]["estimated_minutes"] = Value::Null;
    remote.data["row"]["is_focus"] = json!(0);
    s.entities_pull(&feed(vec![remote.clone()], 1), "device")
        .await
        .unwrap();
    assert_eq!(s.list_day("2026-10-11").await.unwrap().len(), 1);
    assert_eq!(s.list_day("2026-10-11").await.unwrap()[0].plan_id, plan);
    assert_eq!(
        s.list_day("2026-10-11").await.unwrap()[0].estimated_minutes,
        Some(45)
    );
    assert!(s.list_day("2026-10-11").await.unwrap()[0].is_focus);
    remote.version = 2;
    remote.data["row"]["estimated_minutes"] = json!(60);
    remote.data["row"]["is_focus"] = json!(1);
    s.entities_pull(&feed(vec![remote.clone()], 2), "device")
        .await
        .unwrap();
    assert_eq!(
        s.list_day("2026-10-11").await.unwrap()[0].estimated_minutes,
        Some(60)
    );
}
#[tokio::test]
async fn initial_settings_identity_does_not_manufacture_remote_settings_tombstone() {
    let (_d, s) = setup().await;
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    acknowledge_all(&s).await;
    let remote = entity("settings", json!({"timeZone":"UTC"}));
    s.entities_pull(&feed(vec![remote.clone()], 1), "device")
        .await
        .unwrap();
    let settings = snapshot(&s)
        .await
        .into_iter()
        .filter(|e| e.kind == "settings")
        .collect::<Vec<_>>();
    assert_eq!(
        settings.len(),
        1,
        "singleton must retain its original acknowledged identity until a deliberate resolution"
    );
    assert_ne!(settings[0].id, remote.id);
    assert!(!settings[0].deleted);
    assert_eq!(
        s.entities_conflicts()
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn preexisting_workspace_upload_receipts_quiesce_without_feedback_loop() {
    let (_d, s) = setup().await;
    let task = id();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: task,
        plan_id: id(),
        title: "existing".into(),
        execution_date: "2026-10-11".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    save(
        &s,
        json!({"type":"label","id":id(),"name":"shared","expectedVersion":null}),
    )
    .await;
    acknowledge_all(&s).await;
    assert!(s.entities_prepare("device").await.unwrap().is_empty());
}
#[tokio::test]
async fn acknowledged_entity_created_at_remains_immutable_during_local_editor_changes() {
    let (_d, s) = setup().await;
    let remote = entity("task", json!({"title":"original","status":"todo"}));
    s.entities_pull(&feed(vec![remote.clone()], 1), "device")
        .await
        .unwrap();
    let expected = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == remote.id)
        .unwrap();
    let mut next = expected.clone();
    next.created_at = "2026-10-12T00:00:00Z".into();
    next.data["title"] = json!("changed");
    assert!(s.entities_edit(&id(), next, Some(expected)).await.is_err());
    let current = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.id == remote.id)
        .unwrap();
    assert_eq!(
        current.created_at, remote.created_at,
        "native created_at must not drift after editable wire metadata"
    );
}
#[tokio::test]
async fn same_habit_day_remote_identity_does_not_export_duplicate_live_checks() {
    let (_d, s) = setup().await;
    let habit = id();
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    let c:HabitCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"create","id":habit,"name":"reading","startDate":"2026-10-01","frequency":"daily","weekdays":[],"weeklyTarget":1,"triggerContext":"","normalVersion":"","minimumVersion":"","notes":"","projectId":null}})).unwrap();
    s.habit_command(&c).await.unwrap();
    let c:HabitCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":AT,"action":{"type":"entry","id":habit,"date":"2026-10-11","status":"done","note":"original","timeZone":"Asia/Hong_Kong","expectedVersion":null}})).unwrap();
    s.habit_command(&c).await.unwrap();
    acknowledge_all(&s).await;
    let mut remote = snapshot(&s)
        .await
        .into_iter()
        .find(|e| e.kind == "habit_check")
        .unwrap();
    remote.id = id();
    remote.version = 1;
    s.entities_pull(&feed(vec![remote], 1), "device")
        .await
        .unwrap();
    let checks = snapshot(&s)
        .await
        .into_iter()
        .filter(|e| e.kind == "habit_check" && !e.deleted)
        .collect::<Vec<_>>();
    assert_eq!(
        checks.len(),
        1,
        "one habit/day must not become two live wire identities"
    );
    assert_eq!(
        s.entities_conflicts()
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn canonical_priorities_match_native_priority_labels_in_both_directions() {
    let (_d, s) = setup().await;
    for priority in 0..=3 {
        let task = entity(
            "task",
            json!({"title":format!("P{priority}"),"status":"todo","priority":priority}),
        );
        s.entities_pull(&feed(vec![task.clone()], priority + 1), "device")
            .await
            .unwrap();
        let native = s.productivity_snapshot().await.unwrap();
        let row = native["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == task.id)
            .unwrap();
        assert_eq!(row["priority"], if priority == 0 { 4 } else { priority });
        let wire = snapshot(&s)
            .await
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(wire.data["priority"], priority);
    }
}
#[tokio::test]
async fn bare_mobile_task_native_notes_and_remote_title_merge_without_false_conflict() {
    let (_d, s) = setup().await;
    let mut task = entity("task", json!({"title":"original","status":"todo"}));
    s.entities_pull(&feed(vec![task.clone()], 1), "device")
        .await
        .unwrap();
    let native = s.task_details(&task.id).await.unwrap();
    s.save_task_details(&TaskDetailsCommand {
        operation_id: id(),
        task_id: task.id.clone(),
        expected_version: native.version,
        title: native.title,
        notes: "local note".into(),
        completion_criteria: "".into(),
        important: false,
        deadline: None,
        deadline_time_zone: None,
        estimated_minutes: None,
        occurred_at: AT.into(),
    })
    .await
    .unwrap();
    task.version = 2;
    task.data["title"] = json!("remote title");
    task.data["notes"] = json!("");
    s.entities_pull(&feed(vec![task.clone()], 2), "device")
        .await
        .unwrap();
    let current = s.task_details(&task.id).await.unwrap();
    assert_eq!(current.title, "remote title");
    assert_eq!(current.notes, "local note");
    assert!(s
        .entities_conflicts()
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn settings_collision_resolution_explicitly_adopts_remote_identity_and_keeps_local_value() {
    let (_d, s) = setup().await;
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    acknowledge_all(&s).await;
    let remote = entity("settings", json!({"timeZone":"UTC"}));
    s.entities_rebase(&[remote.clone()], 1, &id(), "device")
        .await
        .unwrap();
    let conflict = s.entities_conflicts().await.unwrap()[0].clone();
    assert!(!conflict.is_null());
    s.entities_resolve(
        conflict["operationId"].as_str().unwrap(),
        &id(),
        "local",
        conflict["token"].as_str().unwrap(),
        None,
    )
    .await
    .unwrap();
    let settings = snapshot(&s)
        .await
        .into_iter()
        .filter(|e| e.kind == "settings" && !e.deleted)
        .collect::<Vec<_>>();
    assert_eq!(settings.len(), 1);
    assert_eq!(settings[0].id, remote.id);
    assert_eq!(settings[0].data["timeZone"], "Asia/Hong_Kong");
    acknowledge_all(&s).await;
}
