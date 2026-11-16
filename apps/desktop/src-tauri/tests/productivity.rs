use praxis_desktop_lib::store::*;
use serde_json::{json, Value};
use sqlx::Connection;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(action: Value) -> ProductivityCommand {
    serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-08T03:00:00Z","action":action}),
    )
    .unwrap()
}

#[tokio::test]
async fn automatic_postponement_preserves_deadlines_times_and_future_choices() {
    let (d, s) = fixture().await;
    let dated = id();
    let timed = id();
    let future = id();
    let finished = id();
    for (t, plan) in [
        (&dated, json!({"kind":"date","date":"2026-10-06"})),
        (
            &timed,
            json!({"kind":"instant","atUtc":"2026-10-06T07:30:00Z","displayTimezone":"Asia/Hong_Kong"}),
        ),
        (&future, json!({"kind":"date","date":"2026-10-12"})),
        (&finished, json!({"kind":"date","date":"2026-10-06"})),
    ] {
        let mut a = task(t, None);
        a["plan"] = plan;
        a["deadline"] = json!({"kind":"date","date":"2026-10-07"});
        a["followUp"] = json!({"kind":"date","date":"2026-10-09"});
        save(&s, a).await;
    }
    save(&s, status(&s, &finished, "completed", false).await).await;
    let before = item(&s, &finished).await;
    s.prepare_daily_tasks("2026-10-07T16:30:00Z").await.unwrap();
    assert_eq!(item(&s, &dated).await["plan"]["date"], "2026-10-08");
    assert_eq!(
        item(&s, &timed).await["plan"]["atUtc"],
        "2026-10-08T07:30:00Z"
    );
    assert_eq!(item(&s, &timed).await["deadline"]["date"], "2026-10-07");
    assert_eq!(item(&s, &timed).await["followUp"]["date"], "2026-10-09");
    assert_eq!(item(&s, &future).await["plan"]["date"], "2026-10-12");
    assert_eq!(item(&s, &finished).await, before);
    let operations = s.pending_operations().await.unwrap().len();
    let version = item(&s, &timed).await["version"].clone();
    s.prepare_daily_tasks("2026-10-08T04:00:00Z").await.unwrap();
    assert_eq!(s.pending_operations().await.unwrap().len(), operations);
    assert_eq!(item(&s, &timed).await["version"], version);
    s.close().await;
    let reopened = Store::open(&d.path().join("praxis.db")).await.unwrap();
    reopened
        .prepare_daily_tasks("2026-10-10T02:00:00Z")
        .await
        .unwrap();
    assert_eq!(item(&reopened, &dated).await["plan"]["date"], "2026-10-10");
    assert_eq!(
        item(&reopened, &timed).await["plan"]["atUtc"],
        "2026-10-10T07:30:00Z"
    );
    assert_eq!(item(&reopened, &timed).await["notes"], "原文保留");
}

#[tokio::test]
async fn automatic_postponement_keeps_arrangement_identity_and_merges_date_collisions() {
    let (_d, s) = fixture().await;
    let mut captures = Vec::new();
    for title in ["晚间任务", "当天已有安排"] {
        let c = CaptureCommand {
            operation_id: id(),
            task_id: id(),
            plan_id: id(),
            title: title.into(),
            execution_date: "2026-10-06".into(),
            time_zone: "Asia/Hong_Kong".into(),
            occurred_at: "2026-10-06T03:00:00Z".into(),
        };
        s.capture(&c).await.unwrap();
        captures.push(c);
    }
    s.update_plan(&PlanCommand {
        habit_changes: vec![],
        operation_id: id(),
        date: "2026-10-06".into(),
        occurred_at: "2026-10-06T03:01:00Z".into(),
        changes: vec![PlanChange {
            task_id: captures[0].task_id.clone(),
            plan_id: captures[0].plan_id.clone(),
            expected_version: 0,
            is_focus: true,
            estimated_minutes: Some(30),
            focus_rank: 0,
            day_period: Some("evening".into()),
            day_rank: Some(2),
        }],
    })
    .await
    .unwrap();
    // A removed arrangement still occupies the unique task/date key.
    let mut db = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        _d.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    let target_id = id();
    sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at,removed) SELECT ?,owner_id,task_id,'2026-10-08',time_zone,created_at,1 FROM daily_plan_items WHERE id=?")
        .bind(&target_id).bind(&captures[1].plan_id).execute(&mut db).await.unwrap();
    s.prepare_daily_tasks("2026-10-08T03:00:00Z").await.unwrap();
    let rows = s.list_day("2026-10-08").await.unwrap();
    assert_eq!(rows.len(), 2);
    let first = rows
        .iter()
        .find(|r| r.task_id == captures[0].task_id)
        .unwrap();
    assert_eq!(first.plan_id, captures[0].plan_id);
    assert_eq!(first.day_period, "evening");
    assert_eq!(first.estimated_minutes, Some(30));
    assert!(first.is_focus);
    assert_eq!(
        rows.iter()
            .find(|r| r.task_id == captures[1].task_id)
            .unwrap()
            .plan_id,
        target_id
    );
    assert!(s.list_day("2026-10-06").await.unwrap().is_empty());
    s.prepare_daily_tasks("2026-10-08T06:00:00Z").await.unwrap();
    assert_eq!(s.list_day("2026-10-08").await.unwrap(), rows);
}

#[tokio::test]
async fn automatic_postponement_handles_a_skipped_dst_hour() {
    let (_d, s) = fixture().await;
    save(&s, json!({"type":"zone","timeZone":"America/New_York","expectedVersion":0,"expectedTemplates":[]})).await;
    let t = id();
    let mut a = task(&t, None);
    a["plan"] = json!({"kind":"instant","atUtc":"2026-03-07T07:30:00Z","displayTimezone":"America/New_York"});
    save(&s, a).await;
    s.prepare_daily_tasks("2026-03-08T15:00:00Z").await.unwrap();
    assert_eq!(item(&s, &t).await["plan"]["atUtc"], "2026-03-08T07:00:00Z");
}
async fn save(s: &Store, a: Value) {
    s.productivity_command(&command(a)).await.unwrap()
}
async fn fixture() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("praxis.db")).await.unwrap();
    save(
        &s,
        json!({"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}),
    )
    .await;
    (d, s)
}
fn task(t: &str, p: Option<&str>) -> Value {
    json!({"type":"task","id":t,"expectedVersion":null,"title":t,"notes":"原文保留","projectId":p,"plan":null,"deadline":null,"followUp":null,"priority":4,"waitingFor":"","waitingNote":"","labels":[]})
}
async fn snapshot(s: &Store) -> Value {
    s.productivity_snapshot().await.unwrap()
}
async fn item(s: &Store, id: &str) -> Value {
    snapshot(s).await["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id)
        .unwrap()
        .clone()
}
async fn expected(s: &Store) -> Value {
    json!(snapshot(s).await["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| json!([t["id"], t["version"]]))
        .collect::<Vec<_>>())
}
async fn status(s: &Store, t: &str, state: &str, confirm: bool) -> Value {
    json!({"type":"status","id":t,"expectedVersion":item(s,t).await["version"],"status":state,"confirmRelated":confirm,"expectedTasks":expected(s).await})
}
async fn project(s: &Store) -> String {
    let p = id();
    s.save_project(&SaveProjectCommand {
        operation_id: id(),
        project_id: p.clone(),
        expected_version: None,
        name: "项目".into(),
        outcome: "".into(),
        target_date: None,
        priority: 0,
        occurred_at: "2026-10-08T01:00:00Z".into(),
    })
    .await
    .unwrap();
    p
}
async fn move_task(
    s: &Store,
    t: &str,
    p: Option<&str>,
    parent: Option<&str>,
    section: Option<&str>,
    count: i64,
) -> Value {
    json!({"type":"move","id":t,"expectedVersion":item(s,t).await["version"],"projectId":p,"parentId":parent,"sectionId":section,"confirmCount":count,"expectedTasks":expected(s).await})
}
#[tokio::test]
async fn typed_times_labels_days_and_retry_survive_restart() {
    let (d, s) = fixture().await;
    let t = id();
    let label = id();
    save(
        &s,
        json!({"type":"label","id":label,"name":"外出","expectedVersion":null}),
    )
    .await;
    let mut a = task(&t, None);
    a["plan"] = json!({"kind":"date","date":"2026-10-09"});
    a["deadline"] = json!({"kind":"date","date":"2026-10-08"});
    a["followUp"] =
        json!({"kind":"instant","atUtc":"2026-10-08T23:00:00Z","displayTimezone":"Europe/London"});
    a["labels"] = json!([label]);
    a["priority"] = json!(1);
    let c = command(a);
    s.productivity_command(&c).await.unwrap();
    s.productivity_command(&c).await.unwrap();
    assert_eq!(snapshot(&s).await["tasks"].as_array().unwrap().len(), 1);
    save(&s,json!({"type":"day","date":"2026-10-08","outcome":"推进结果","closing":"明天接续","focusIds":[t],"expectedVersion":null})).await;
    save(
        &s,
        json!({"type":"label","id":label,"name":"电话","expectedVersion":0}),
    )
    .await;
    save(
        &s,
        json!({"type":"zone","timeZone":"America/Los_Angeles","expectedVersion":0}),
    )
    .await;
    let before = snapshot(&s).await;
    assert_eq!(before["tasks"][0]["plan"]["date"], "2026-10-09");
    assert_eq!(before["labels"][0]["name"], "电话");
    s.close().await;
    let s = Store::open(&d.path().join("praxis.db")).await.unwrap();
    assert_eq!(snapshot(&s).await, before);
    s.close().await;
}
#[tokio::test]
async fn invalid_fields_stale_writes_and_outbox_failures_are_atomic() {
    let (d, s) = fixture().await;
    let t = id();
    save(&s, task(&t, None)).await;
    let before = snapshot(&s).await;
    let mut a = task(&t, None);
    a["expectedVersion"] = json!(0);
    assert!(s.productivity_command(&command(a.clone())).await.is_err());
    a["expectedVersion"] = item(&s, &t).await["version"].clone();
    a["deadline"] = json!({"kind":"date","date":"2026-02-30"});
    assert!(s.productivity_command(&command(a)).await.is_err());
    assert_eq!(snapshot(&s).await, before);
    let mut conn = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        d.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_productivity BEFORE INSERT ON sync_outbox WHEN NEW.kind='productivity' BEGIN SELECT RAISE(ABORT,'simulated full disk'); END").execute(&mut conn).await.unwrap();
    assert!(s
        .productivity_command(&command(task(&id(), None)))
        .await
        .is_err());
    assert_eq!(snapshot(&s).await, before);
    s.close().await;
}
#[tokio::test]
async fn parent_end_requires_confirmation_and_reopen_preserves_completion_history() {
    let (_d, s) = fixture().await;
    let p = project(&s).await;
    let a = id();
    let b = id();
    save(&s, task(&a, Some(&p))).await;
    save(&s, task(&b, Some(&p))).await;
    save(&s, move_task(&s, &b, Some(&p), Some(&a), None, 1).await).await;
    let before = snapshot(&s).await;
    assert!(s
        .productivity_command(&command(status(&s, &a, "completed", false).await))
        .await
        .is_err());
    assert_eq!(snapshot(&s).await, before);
    save(&s, status(&s, &a, "completed", true).await).await;
    assert_eq!(item(&s, &a).await["status"], "completed");
    assert_eq!(item(&s, &b).await["completedAt"], "2026-10-08T03:00:00Z");
    assert!(item(&s, &b).await["plan"].is_null());
    assert!(s
        .productivity_command(&command(status(&s, &b, "todo", false).await))
        .await
        .is_err());
    save(&s, status(&s, &b, "todo", true).await).await;
    assert_eq!(item(&s, &a).await["status"], "todo");
    assert!(item(&s, &b).await["completedAt"].is_null());
    s.close().await;
}
#[tokio::test]
async fn sections_subtrees_cycles_and_stale_preview() {
    let (_d, s) = fixture().await;
    let p = project(&s).await;
    let sec = id();
    save(&s,json!({"type":"section","id":sec,"projectId":p,"name":"准备","rank":2,"delete":false,"expectedVersion":null})).await;
    let a = id();
    let b = id();
    save(&s, task(&a, Some(&p))).await;
    save(&s, task(&b, Some(&p))).await;
    save(&s, move_task(&s, &a, Some(&p), None, Some(&sec), 1).await).await;
    save(&s, move_task(&s, &b, Some(&p), Some(&a), None, 1).await).await;
    assert_eq!(item(&s, &b).await["sectionId"], sec);
    assert!(s
        .productivity_command(&command(
            move_task(&s, &a, Some(&p), Some(&b), None, 2).await
        ))
        .await
        .is_err());
    let stale = move_task(&s, &a, None, None, None, 2).await;
    save(&s, task(&id(), None)).await;
    assert!(s.productivity_command(&command(stale)).await.is_err());
    save(&s, move_task(&s, &a, None, None, None, 2).await).await;
    assert!(item(&s, &a).await["projectId"].is_null());
    assert!(item(&s, &b).await["projectId"].is_null());
    assert_eq!(item(&s, &b).await["parentId"], a);
    save(&s,json!({"type":"section","id":sec,"projectId":p,"name":"准备","rank":2,"delete":true,"expectedVersion":0})).await;
    assert_eq!(snapshot(&s).await["tasks"].as_array().unwrap().len(), 3);
    s.close().await;
}
#[tokio::test]
async fn waiting_clears_next_action_and_project_archive_reopen_is_atomic() {
    let (_d, s) = fixture().await;
    let p = project(&s).await;
    let t = id();
    save(&s, task(&t, Some(&p))).await;
    s.content_command(&ContentCommand {
        operation_id: id(),
        occurred_at: "2026-10-08T01:00:00Z".into(),
        action: ContentAction::Context {
            project_id: p.clone(),
            expected_version: None,
            definition_of_done: "".into(),
            blocker_text: "".into(),
            review_date: None,
            next_action_task_id: Some(t.clone()),
            last_context: "".into(),
            restart_hint: "".into(),
            waiting_note: "".into(),
        },
    })
    .await
    .unwrap();
    save(&s, status(&s, &t, "waiting", false).await).await;
    assert!(s.content_snapshot().await.unwrap()["contexts"][0]["nextActionTaskId"].is_null());
    assert_eq!(item(&s, &t).await["status"], "waiting");
    let proj = snapshot(&s).await["projects"][0].clone();
    let mut a = json!({"type":"project","id":p,"expectedVersion":proj["version"],"expectedPlanVersion":proj["planVersion"],"status":"cancelled","archive":true,"focused":true,"cancelRemaining":false});
    assert!(s.productivity_command(&command(a.clone())).await.is_err());
    a["cancelRemaining"] = json!(true);
    save(&s, a).await;
    assert_eq!(snapshot(&s).await["projects"][0]["status"], "cancelled");
    assert!(snapshot(&s).await["projects"][0]["archivedAt"].is_string());
    assert!(s
        .productivity_command(&command(task(&id(), Some(&p))))
        .await
        .is_err());
    assert!(s
        .productivity_command(&command(status(&s, &t, "todo", false).await))
        .await
        .is_err());
    save(&s, status(&s, &t, "todo", true).await).await;
    let proj = snapshot(&s).await["projects"][0].clone();
    assert_eq!(proj["status"], "active");
    assert!(proj["archivedAt"].is_null());
    assert_eq!(proj["focused"], 1);
    s.close().await;
}

#[tokio::test]
async fn schema_ten_upgrade_maps_dates_preserves_legacy_history_and_backups() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let d = tempfile::tempdir().unwrap();
    let migrations = d.path().join("old");
    std::fs::create_dir(&migrations).unwrap();
    for entry in
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
    {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy()[..4]
            .parse::<i64>()
            .unwrap()
            <= 10
        {
            std::fs::copy(entry.path(), migrations.join(entry.file_name())).unwrap();
        }
    }
    let path = d.path().join("praxis.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    let owner = id();
    let t = id();
    let p = id();
    sqlx::query("INSERT INTO local_profile VALUES(1,?,?)")
        .bind(&owner)
        .bind(id())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,priority,version,created_at,status) VALUES(?,?,'旧归档','',0,0,'2026-09-01','archived')").bind(&p).bind(&owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,project_id,source,created_at,important,deadline,deadline_time_zone) VALUES(?,?,'旧重要任务',?,'temporary','2026-09-01',1,'2026-10-08T03:00:00Z','Asia/Hong_Kong')").bind(&t).bind(&owner).bind(&p).execute(&pool).await.unwrap();
    for date in ["2026-10-07", "2026-10-09"] {
        sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES(?,?,?,?,'Asia/Hong_Kong',?)").bind(id()).bind(&owner).bind(&t).bind(date).bind(date).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO project_schedules VALUES(?,?,'2026-11-01','2026-11-20')")
        .bind(&owner)
        .bind(&t)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let s = Store::open(&path).await.unwrap();
    let snap = snapshot(&s).await;
    assert_eq!(snap["tasks"][0]["plan"]["date"], "2026-10-09");
    assert_eq!(
        snap["tasks"][0]["deadline"]["atUtc"],
        "2026-10-08T03:00:00Z"
    );
    assert_eq!(snap["tasks"][0]["priority"], 4);
    assert_eq!(snap["tasks"][0]["important"], 1);
    assert_eq!(snap["legacyPlans"].as_array().unwrap().len(), 2);
    assert_eq!(snap["projects"][0]["status"], "paused");
    assert!(snap["projects"][0]["archivedAt"].is_null());
    assert_eq!(
        s.project_tasks(&p).await.unwrap()[0]
            .planned_start
            .as_deref(),
        Some("2026-11-01")
    );
    assert!(snap["migrationReport"].as_str().unwrap().contains("甘特"));
    assert_eq!(backup::list_backups(d.path()).unwrap().len(), 1);
    s.close().await;
}
#[tokio::test]
async fn subtasks_append_then_keep_a_dragged_order() {
    let (_d, s) = fixture().await;
    let parent = id();
    let first = id();
    let second = id();
    save(&s, task(&parent, None)).await;
    let mut earlier = task(&first, None);
    earlier["parentId"] = json!(parent);
    save(&s, earlier).await;
    let mut later = task(&second, None);
    later["parentId"] = json!(parent);
    save(&s, later).await;
    assert!(
        item(&s, &first).await["rank"].as_i64().unwrap()
            < item(&s, &second).await["rank"].as_i64().unwrap()
    );
    save(
        &s,
        json!({"type":"reorder","parentId":parent,"orderedIds":[second, first]}),
    )
    .await;
    assert!(
        item(&s, &second).await["rank"].as_i64().unwrap()
            < item(&s, &first).await["rank"].as_i64().unwrap()
    );
    s.close().await;
}

#[tokio::test]
async fn partial_subtasks_become_a_new_task_the_next_day() {
    let (d, s) = fixture().await;
    let parent = id();
    let done = id();
    let left = id();
    s.capture(&CaptureCommand {
        operation_id: id(),
        task_id: parent.clone(),
        plan_id: id(),
        title: "预览图".into(),
        execution_date: "2026-10-06".into(),
        time_zone: "Asia/Hong_Kong".into(),
        occurred_at: "2026-10-06T01:00:00Z".into(),
    })
    .await
    .unwrap();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(d.path().join("praxis.db")),
    )
    .await
    .unwrap();
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM local_profile WHERE singleton=1")
        .fetch_one(&mut db)
        .await
        .unwrap();
    for (child, title, status) in [(&done, "已完成步骤", "completed"), (&left, "还没做完", "todo")] {
        sqlx::query("INSERT INTO tasks(id,owner_id,title,parent_task_id,status,source,created_at) VALUES(?,?,?,?,?,'temporary','2026-10-06T01:00:00Z')")
            .bind(child)
            .bind(&owner)
            .bind(title)
            .bind(&parent)
            .bind(status)
            .execute(&mut db)
            .await
            .unwrap();
    }
    drop(db);
    s.prepare_daily_tasks("2026-10-07T16:30:00Z").await.unwrap();
    let today = s.list_day("2026-10-08").await.unwrap();
    assert_eq!(today.len(), 1);
    assert_eq!(today[0].title, "预览图");
    assert_ne!(today[0].task_id, parent);
    assert_eq!(item(&s, &parent).await["status"], "completed");
    assert_eq!(item(&s, &done).await["parentId"], parent);
    assert_eq!(item(&s, &left).await["parentId"], today[0].task_id);
    s.prepare_daily_tasks("2026-10-07T18:00:00Z").await.unwrap();
    assert_eq!(s.list_day("2026-10-08").await.unwrap().len(), 1);
    s.close().await;
}
