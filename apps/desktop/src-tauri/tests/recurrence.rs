use praxis_desktop_lib::store::*;
use serde_json::{json, Value};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(action: Value) -> RecurrenceCommand {
    serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":action}),
    )
    .unwrap()
}
async fn create(s: &Store, start: &str, interval: i64, days: Vec<u32>) -> String {
    zone(&s).await;
    let t = id();
    s.recurrence_command(&command(json!({"type":"create","id":t,"title":"重复","projectId":null,"startDate":start,"intervalDays":interval,"weekdays":days}))).await.unwrap();
    t
}
#[tokio::test]
async fn expansion_is_batched_unique_and_date_anchored() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2026-01-01", 3, vec![]).await;
    let before = s.productivity_snapshot().await.unwrap()["tasks"]
        .as_array()
        .unwrap()
        .len();
    let snap = s.recurrence_snapshot().await.unwrap();
    assert!(snap["templates"][0]["remaining"].as_u64().unwrap() > 90);
    assert_eq!(
        before,
        s.productivity_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len()
    );
    let first = command(json!({"type":"expand","id":t,"through":"2026-11-08","batchSize":10}));
    s.recurrence_command(&first).await.unwrap();
    s.recurrence_command(&first).await.unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    let ten = s.productivity_snapshot().await.unwrap();
    let first_task = &ten["tasks"][0];
    s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"status","id":first_task["id"],"expectedVersion":first_task["version"],"status":"completed","confirmRelated":false,"expectedTasks":ten["tasks"].as_array().unwrap().iter().map(|t|json!([t["id"],t["version"]])).collect::<Vec<_>>()}})).unwrap()).await.unwrap();
    for _ in 0..11 {
        s.recurrence_command(&command(
            json!({"type":"expand","id":t,"through":"2026-11-08","batchSize":10}),
        ))
        .await
        .unwrap();
    }
    let tasks = s.productivity_snapshot().await.unwrap()["tasks"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(tasks.len(), 104);
    for t in &tasks {
        assert!(t["deadline"].is_null());
        assert!(t["parentId"].is_null());
        uuid::Uuid::parse_str(t["id"].as_str().unwrap()).unwrap();
    }
    let mut dates: Vec<_> = tasks
        .iter()
        .map(|t| t["plan"]["date"].as_str().unwrap())
        .collect();
    dates.sort();
    assert_eq!(dates[0], "2026-01-01");
    assert_eq!(dates[103], "2026-11-06");
    drop(s);
    let reopened = Store::open(&d.path().join("test.db")).await.unwrap();
    assert_eq!(
        reopened.productivity_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        104
    );
}
#[tokio::test]
async fn weekdays_stop_and_identity_survive_edit() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2026-10-01", 1, vec![1, 5]).await;
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-09","batchSize":100}),
    ))
    .await
    .unwrap();
    let snap = s.productivity_snapshot().await.unwrap();
    let tasks = snap["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 3);
    let item = &tasks[0];
    let task_id = item["id"].as_str().unwrap();
    s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"task","id":task_id,"expectedVersion":item["version"],"title":"仅本次修改","notes":"","projectId":null,"plan":{"kind":"date","date":"2026-11-01"},"deadline":null,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[]}})).unwrap()).await.unwrap();
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-09","batchSize":100}),
    ))
    .await
    .unwrap();
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let version =
        s.recurrence_snapshot().await.unwrap()["templates"][0]["template"]["version"].clone();
    s.recurrence_command(&command(
        json!({"type":"stop","id":t,"expectedVersion":version}),
    ))
    .await
    .unwrap();
    assert!(s
        .recurrence_command(&command(
            json!({"type":"expand","id":t,"through":"2026-10-10","batchSize":100})
        ))
        .await
        .is_err());
    assert_eq!(
        s.productivity_snapshot().await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}
#[tokio::test]
async fn terminal_project_requires_stopped_template_and_keeps_future_tasks() {
    use sqlx::Connection;
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("test.db");
    let s = Store::open(&path).await.unwrap();
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-10-09T12:00:00Z".into(),
    })
    .await
    .unwrap();
    zone(&s).await;
    let t = id();
    s.recurrence_command(&command(json!({"type":"create","id":t,"title":"项目规则","projectId":p,"startDate":"2026-10-09","intervalDays":1,"weekdays":[]}))).await.unwrap();
    let mut db = sqlx::SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let error = sqlx::query("UPDATE projects SET status='completed' WHERE id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("重复任务"));
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-10","batchSize":100}),
    ))
    .await
    .unwrap();
    s.recurrence_command(&command(json!({"type":"stop","id":t,"expectedVersion":1})))
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE projects SET status='completed' WHERE id=?")
            .bind(&p)
            .execute(&mut db)
            .await
            .is_err()
    );
    sqlx::query("UPDATE tasks SET status='cancelled' WHERE project_id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE projects SET status='completed' WHERE id=?")
        .bind(&p)
        .execute(&mut db)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=?")
        .bind(&p)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(rows, 2);
    let mut invalid = command(
        json!({"type":"create","id":id(),"title":"不允许","projectId":p,"startDate":"2026-10-09","intervalDays":1,"weekdays":[]}),
    );
    assert!(s.recurrence_command(&invalid).await.is_err());
    invalid.action = RecurrenceAction::Create {
        id: id(),
        title: "无效".into(),
        project_id: None,
        start_date: "2026-10-09".into(),
        interval_days: 0,
        weekdays: vec![],
    };
    assert!(s.recurrence_command(&invalid).await.is_err());
}

async fn zone(s: &Store) {
    s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}})).unwrap()).await.unwrap();
}

#[tokio::test]
async fn future_edit_preserves_history_and_requires_fresh_preview() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2026-10-08", 1, vec![]).await;
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-12","batchSize":100}),
    ))
    .await
    .unwrap();
    let snap = s.recurrence_snapshot().await.unwrap();
    let tasks = snap["templates"][0]["futureTasks"].as_array().unwrap();
    let expected: Vec<_> = tasks
        .iter()
        .map(|t| json!([t["id"], t["version"]]))
        .collect();
    let edit = json!({"type":"edit","id":t,"expectedVersion":1,"effectiveDate":"2026-10-10","title":"新版","intervalDays":2,"weekdays":[],"timeZone":"Asia/Hong_Kong","expectedTasks":expected,"overwriteOverrides":false});
    s.recurrence_command(&command(edit.clone())).await.unwrap();
    assert!(s.recurrence_command(&command(edit)).await.is_err());
    let tasks = s.productivity_snapshot().await.unwrap();
    assert_eq!(
        tasks["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["title"] == "重复")
            .count(),
        2
    );
    assert!(tasks["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["title"] == "新版"));
}

#[tokio::test]
async fn workspace_zone_preview_is_required_and_interval_anchor_survives() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2026-10-08", 3, vec![]).await;
    let settings = s.productivity_snapshot().await.unwrap()["settings"][0]["version"].clone();
    let cmd = |expected: Value| {
        serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"zone","timeZone":"America/New_York","expectedVersion":settings,"expectedTemplates":expected}})).unwrap()
    };
    assert!(s.productivity_command(&cmd(json!([]))).await.is_err());
    s.productivity_command(&cmd(json!([[t, 0]]))).await.unwrap();
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-15","batchSize":100}),
    ))
    .await
    .unwrap();
    let snapshot = s.productivity_snapshot().await.unwrap();
    let mut dates: Vec<_> = snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["plan"]["date"].as_str().unwrap())
        .collect();
    dates.sort();
    assert_eq!(dates, vec!["2026-10-08", "2026-10-11", "2026-10-14"]);
}

#[tokio::test]
async fn future_overrides_are_preserved_until_explicitly_confirmed() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2026-10-10", 1, vec![]).await;
    s.recurrence_command(&command(
        json!({"type":"expand","id":t,"through":"2026-10-10","batchSize":100}),
    ))
    .await
    .unwrap();
    let item = s.productivity_snapshot().await.unwrap()["tasks"][0].clone();
    let task = item["id"].clone();
    s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-09T12:00:00Z","action":{"type":"task","id":task,"expectedVersion":item["version"],"title":"手动例外","notes":"","projectId":null,"plan":{"kind":"date","date":"2026-11-01"},"deadline":null,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[]}})).unwrap()).await.unwrap();
    for overwrite in [false, true] {
        let snap = s.recurrence_snapshot().await.unwrap();
        let row = &snap["templates"][0];
        let expected: Vec<_> = row["futureTasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| json!([x["id"], x["version"]]))
            .collect();
        s.recurrence_command(&command(json!({"type":"edit","id":t,"expectedVersion":row["template"]["version"],"effectiveDate":"2026-10-10","title":"新规则","intervalDays":1,"weekdays":[],"timeZone":"Asia/Hong_Kong","expectedTasks":expected,"overwriteOverrides":overwrite}))).await.unwrap();
        let snap = s.productivity_snapshot().await.unwrap();
        let item = &snap["tasks"][0];
        assert_eq!(item["id"], task);
        assert_eq!(
            item["title"],
            if overwrite {
                "新规则"
            } else {
                "手动例外"
            }
        );
        assert_eq!(
            item["plan"]["date"],
            if overwrite {
                "2026-10-10"
            } else {
                "2026-11-01"
            }
        );
    }
}

#[tokio::test]
async fn rule_preview_and_edit_preserve_in_progress_blocked_and_waiting() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("test.db")).await.unwrap();
    let t = create(&s, "2090-01-01", 1, vec![]).await;
    let mut expand =
        command(json!({"type":"expand","id":t,"through":"2090-01-06","batchSize":100}));
    expand.occurred_at = "2089-12-31T12:00:00Z".into();
    s.recurrence_command(&expand).await.unwrap();
    let mut items = s.productivity_snapshot().await.unwrap()["tasks"]
        .as_array()
        .unwrap()
        .clone();
    items.sort_by_key(|item| item["plan"]["date"].as_str().unwrap().to_owned());
    for (item, status) in items
        .iter()
        .zip(["in_progress", "blocked", "waiting"].iter().cycle())
    {
        let snap = s.productivity_snapshot().await.unwrap();
        s.productivity_command(&serde_json::from_value(json!({"operationId":id(),"occurredAt":"2089-12-31T12:00:00Z","action":{"type":"status","id":item["id"],"expectedVersion":item["version"],"status":status,"confirmRelated":false,"expectedTasks":snap["tasks"].as_array().unwrap().iter().map(|x|json!([x["id"],x["version"]])).collect::<Vec<_>>()}})).unwrap()).await.unwrap();
    }
    for overwrite in [false, true] {
        let before = s.productivity_snapshot().await.unwrap();
        let row = s.recurrence_snapshot().await.unwrap()["templates"][0].clone();
        let expected: Vec<_> = row["futureTasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| json!([x["id"], x["version"]]))
            .collect();
        let action:RecurrenceAction=serde_json::from_value(json!({"type":"edit","id":t,"expectedVersion":row["template"]["version"],"effectiveDate":"2090-01-01","title":"更新标题","intervalDays":2,"weekdays":[],"timeZone":"Asia/Hong_Kong","expectedTasks":expected,"overwriteOverrides":overwrite})).unwrap();
        let preview = s.recurrence_edit_preview(&action).await.unwrap();
        assert_eq!(preview["effects"].as_array().unwrap().len(), 6);
        for effect in preview["effects"].as_array().unwrap() {
            let matched = ["2090-01-01", "2090-01-03", "2090-01-05"]
                .contains(&effect["occurrenceKey"].as_str().unwrap());
            assert_eq!(
                effect["effect"],
                if !overwrite {
                    "preserveOverride"
                } else if matched {
                    "update"
                } else {
                    "cancel"
                }
            );
        }
        assert_eq!(s.productivity_snapshot().await.unwrap(), before);
        s.recurrence_command(&RecurrenceCommand {
            operation_id: id(),
            occurred_at: "2089-12-31T12:00:00Z".into(),
            action,
        })
        .await
        .unwrap();
        let after = s.productivity_snapshot().await.unwrap();
        for old in before["tasks"].as_array().unwrap() {
            let new = after["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == old["id"])
                .unwrap();
            let matched = ["2090-01-01", "2090-01-03", "2090-01-05"]
                .contains(&old["plan"]["date"].as_str().unwrap());
            if !overwrite {
                assert_eq!(new, old)
            } else {
                assert_eq!(
                    new["status"],
                    if matched {
                        old["status"].clone()
                    } else {
                        json!("cancelled")
                    }
                );
                assert_eq!(new["title"], "更新标题");
            }
        }
    }
}
