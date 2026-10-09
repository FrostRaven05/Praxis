use praxis_desktop_lib::store::*;
use serde_json::{json, Value};
use sqlx::Connection;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(action: Value) -> HabitCommand {
    serde_json::from_value(
        json!({"operationId":id(),"occurredAt":"2026-10-11T18:00:00Z","action":action}),
    )
    .unwrap()
}
fn create(h: &str, frequency: &str, days: Value, target: i64) -> HabitCommand {
    command(
        json!({"type":"create","id":h,"name":"阅读 中文","startDate":"2026-10-05","frequency":frequency,"weekdays":days,"weeklyTarget":target,"triggerContext":"早餐后","normalVersion":"20页","minimumVersion":"1页","notes":"阅读说明","projectId":null}),
    )
}
fn entry(h: &str, date: &str, status: Value, version: Value) -> HabitCommand {
    command(
        json!({"type":"entry","id":h,"date":date,"status":status,"note":"旅行","timeZone":"UTC","expectedVersion":version}),
    )
}
async fn fixture() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("praxis.db")).await.unwrap();
    (d, s)
}
#[tokio::test]
async fn weekly_unique_replay_conflict_undo_and_restart() {
    let (dir, s) = fixture().await;
    let h = id();
    s.habit_command(&create(&h, "weekly", json!([]), 3))
        .await
        .unwrap();
    let first = entry(&h, "2026-10-05", json!("done"), Value::Null);
    s.habit_command(&first).await.unwrap();
    s.habit_command(&first).await.unwrap();
    assert!(s
        .habit_command(&entry(&h, "2026-10-05", json!("skipped"), Value::Null))
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    s.habit_command(&entry(&h, "2026-10-06", json!("done"), Value::Null))
        .await
        .unwrap();
    let snap = s.habit_snapshot("2026-10-07").await.unwrap();
    assert_eq!(snap["habits"][0]["week"]["done"], 2);
    assert_eq!(snap["habits"][0]["week"]["target"], 3);
    assert_eq!(
        s.habit_snapshot("2026-10-05").await.unwrap()["habits"][0]["week"]["target"],
        3
    );
    assert_eq!(snap["habits"][0]["applicable"], true);
    assert_eq!(snap["habits"][0]["week"]["from"], "2026-10-05");
    for date in ["2026-10-07", "2026-10-08"] {
        s.habit_command(&entry(&h, date, json!("done"), Value::Null))
            .await
            .unwrap();
    }
    let snap = s.habit_snapshot("2026-10-08").await.unwrap();
    assert_eq!(snap["habits"][0]["week"]["done"], 4);
    assert_eq!(snap["habits"][0]["collapsed"], true);
    s.habit_command(&entry(&h, "2026-10-08", Value::Null, json!(0)))
        .await
        .unwrap();
    let s2 = Store::open(&dir.path().join("praxis.db")).await.unwrap();
    let snap = s2.habit_snapshot("2026-10-08").await.unwrap();
    assert_eq!(snap["habits"][0]["week"]["done"], 3);
    assert!(snap["habits"][0]["entry"]["status"].is_null());
    assert_eq!(snap["habits"][0]["entry"]["version"], 1);
    let mut db = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        dir.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM habit_entries WHERE habit_id=? AND local_date='2026-10-05'",
    )
    .bind(&h)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let history: i64 = sqlx::query_scalar("SELECT count(*) FROM habit_events WHERE habit_id=?")
        .bind(&h)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(history, 11);
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(tasks, 0);
}
#[tokio::test]
async fn specified_days_skip_and_invalid_input_are_atomic() {
    let (dir, s) = fixture().await;
    let h = id();
    s.habit_command(&create(&h, "weekdays", json!([1, 3, 5]), 1))
        .await
        .unwrap();
    assert!(s
        .habit_command(&entry(&h, "2026-10-06", json!("done"), Value::Null))
        .await
        .is_err());
    assert!(s
        .habit_command(&entry(&h, "2026-10-12", json!("done"), Value::Null))
        .await
        .is_err());
    s.habit_command(&entry(&h, "2026-10-05", json!("skipped"), Value::Null))
        .await
        .unwrap();
    s.habit_command(&entry(&h, "2026-10-07", json!("done"), Value::Null))
        .await
        .unwrap();
    let snap = s.habit_snapshot("2026-10-06").await.unwrap();
    assert_eq!(snap["habits"][0]["applicable"], false);
    assert_eq!(snap["habits"][0]["week"]["target"], 3);
    assert_eq!(snap["habits"][0]["week"]["done"], 1);
    assert_eq!(snap["habits"][0]["week"]["skipped"], 1);
    let mut db = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        dir.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    assert!(sqlx::query("INSERT INTO habit_schedules(habit_id,version,effective_from,frequency,weekdays,weekly_target) VALUES(?,1,'2026-10-06','daily','[]',1)").bind(&h).execute(&mut db).await.is_err());
    for (freq, days, target) in [
        ("weekly", json!([]), 8),
        ("weekdays", json!([]), 1),
        ("weekdays", json!([1, 1]), 1),
    ] {
        assert!(s
            .habit_command(&create(&id(), freq, days, target))
            .await
            .is_err());
    }
    assert_eq!(
        s.habit_snapshot("2026-10-06").await.unwrap()["habits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn provenance_timezone_and_outbox_failure_rollback() {
    let (dir, s) = fixture().await;
    let h = id();
    s.habit_command(&create(&h, "daily", json!([]), 1))
        .await
        .unwrap();
    s.habit_command(&entry(&h, "2026-10-05", json!("done"), Value::Null))
        .await
        .unwrap();
    let zone:ProductivityCommand=serde_json::from_value(json!({"operationId":id(),"occurredAt":"2026-10-11T18:00:00Z","action":{"type":"zone","timeZone":"Asia/Hong_Kong","expectedVersion":null}})).unwrap();
    s.productivity_command(&zone).await.unwrap();
    let snap = s.habit_snapshot("2026-10-05").await.unwrap();
    assert_eq!(snap["habits"][0]["entry"]["timezone"], "UTC");
    assert_eq!(snap["habits"][0]["entry"]["scheduleVersion"], 0);
    assert!(s
        .habit_command(&entry(&h, "2026-10-06", json!("done"), Value::Null))
        .await
        .is_err());
    let mut db = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        dir.path().join("praxis.db").display()
    ))
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER reject_habit_outbox BEFORE INSERT ON sync_outbox WHEN NEW.kind='habit' BEGIN SELECT RAISE(ABORT,'injected'); END").execute(&mut db).await.unwrap();
    let mut c = entry(&h, "2026-10-06", json!("done"), Value::Null);
    if let HabitAction::Entry { time_zone, .. } = &mut c.action {
        *time_zone = "Asia/Hong_Kong".into();
    }
    assert!(s.habit_command(&c).await.is_err());
    assert!(s.habit_snapshot("2026-10-06").await.unwrap()["habits"][0]["entry"].is_null());
}
#[tokio::test]
async fn partial_week_and_remaining_dates_do_not_create_obligations() {
    let (_, s) = fixture().await;
    let h = id();
    let mut c = create(&h, "weekly", json!([]), 3);
    if let HabitAction::Create { start_date, .. } = &mut c.action {
        *start_date = "2026-10-07".into();
    }
    s.habit_command(&c).await.unwrap();
    let snap = s.habit_snapshot("2026-10-08").await.unwrap();
    assert_eq!(snap["habits"][0]["week"]["incomplete"], true);
    assert_eq!(snap["habits"][0]["week"]["target"], 3);
    assert_eq!(
        s.habit_snapshot("2026-10-05").await.unwrap()["habits"][0]["applicable"],
        false
    );
    let old = s.habit_snapshot("2026-09-28").await.unwrap();
    assert_eq!(old["habits"][0]["week"]["remainingDates"], json!([]));
}

#[tokio::test]
async fn pause_resume_and_rule_changes_preserve_history() {
    let (_dir, s) = fixture().await;
    let h = id();
    s.habit_command(&create(&h, "daily", json!([]), 1))
        .await
        .unwrap();
    s.habit_command(&entry(&h, "2026-10-06", json!("done"), Value::Null))
        .await
        .unwrap();
    let old = s.habit_snapshot("2026-10-06").await.unwrap();
    let change = |at: &str,
                  from: &str,
                  version: i64,
                  paused: bool,
                  confirmed: bool|
     -> HabitCommand {
        serde_json::from_value(json!({"operationId":id(),"occurredAt":at,"action":{"type":"rule","id":h,"expectedVersion":version,"effectiveFrom":from,"timeZone":"UTC","frequency":"daily","weekdays":[],"weeklyTarget":1,"paused":paused,"confirmed":confirmed}})).unwrap()
    };
    assert!(s
        .habit_command(&change(
            "2026-10-07T12:00:00Z",
            "2026-10-08",
            0,
            true,
            false
        ))
        .await
        .is_err());
    assert!(s
        .habit_command(&change("2026-10-07T12:00:00Z", "2026-10-07", 0, true, true))
        .await
        .is_err());
    let pause = change("2026-10-07T12:00:00Z", "2026-10-08", 0, true, true);
    s.habit_command(&pause).await.unwrap();
    s.habit_command(&pause).await.unwrap();
    assert!(s
        .habit_command(&change(
            "2026-10-07T12:00:00Z",
            "2026-10-12",
            1,
            false,
            true
        ))
        .await
        .is_err());
    assert_eq!(
        s.habit_snapshot("2026-10-08").await.unwrap()["habits"][0]["applicable"],
        false
    );
    assert!(s
        .habit_command(&entry(&h, "2026-10-08", json!("done"), Value::Null))
        .await
        .is_err());
    s.habit_command(&change(
        "2026-10-09T12:00:00Z",
        "2026-10-10",
        1,
        false,
        true,
    ))
    .await
    .unwrap();
    let historical = s.habit_snapshot("2026-10-06").await.unwrap();
    assert_eq!(historical["habits"][0]["entry"], old["habits"][0]["entry"]);
    assert_eq!(historical["habits"][0]["week"]["target"], 5);
    assert_eq!(historical["habits"][0]["week"]["incomplete"], true);
    assert_eq!(
        historical["habits"][0]["rules"].as_array().unwrap().len(),
        3
    );
    assert_eq!(
        s.habit_snapshot("2026-10-10").await.unwrap()["habits"][0]["applicable"],
        true
    );
    assert!(s
        .habit_command(&change(
            "2026-10-11T12:00:00Z",
            "2026-10-12",
            0,
            false,
            true
        ))
        .await
        .unwrap_err()
        .contains("STATE_CONFLICT"));
    let mut new_rule = change("2026-10-11T12:00:00Z", "2026-10-12", 2, false, true);
    if let HabitAction::Rule {
        frequency,
        weekly_target,
        ..
    } = &mut new_rule.action
    {
        *frequency = "weekly".into();
        *weekly_target = 3;
    }
    s.habit_command(&new_rule).await.unwrap();
    assert_eq!(
        s.habit_snapshot("2026-10-13").await.unwrap()["habits"][0]["week"]["target"],
        3
    );
    assert_eq!(
        s.habit_snapshot("2026-10-06").await.unwrap()["habits"][0]["week"]["target"],
        5
    );
}
