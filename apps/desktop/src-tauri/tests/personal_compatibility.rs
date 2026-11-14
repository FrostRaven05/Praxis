//! P0-02 compatibility evidence: synthetic databases only, no application data paths.
use praxis_desktop_lib::store::{
    backup, AiApplyCommand, AssignProjectCommand, ProductivityCommand, Store,
};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::{collections::BTreeMap, path::Path};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn fixture() -> Value {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../docs/p0/personal-compatibility-fixtures.json"
    ))
    .unwrap();
    assert_eq!(f["synthetic"], true);
    f
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}
async fn pool(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap()
}
// Compare every column, including BLOB migration checksums and unrecognized extension tables.
async fn snapshot(db: &SqlitePool) -> BTreeMap<String, Vec<String>> {
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(db).await.unwrap();
    let mut result = BTreeMap::new();
    for name in names {
        let quoted = format!("\"{}\"", name.replace('"', "\"\""));
        let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as(&format!("PRAGMA table_info({quoted})"))
                .fetch_all(db)
                .await
                .unwrap();
        let fields = columns
            .iter()
            .map(|c| {
                let key = format!("\"{}\"", c.1.replace('"', "\"\""));
                format!(
                    "'{}',CASE WHEN typeof({key})='blob' THEN hex({key}) ELSE {key} END",
                    c.1.replace('\'', "''")
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let mut rows: Vec<String> =
            sqlx::query_scalar(&format!("SELECT json_object({fields}) FROM {quoted}"))
                .fetch_all(db)
                .await
                .unwrap();
        rows.sort();
        result.insert(name, rows);
    }
    result
}
fn export_report(name: &str, report: Value) {
    if let Ok(root) = std::env::var("PRAXIS_PERSONAL_COMPAT_EXPORT_DIR") {
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            Path::new(&root).join(name),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn personal_v10_upgrade_keeps_ids_versions_queue_and_unknown_completion_date() {
    let f = fixture();
    let dir = tempfile::tempdir().unwrap();
    let legacy_migrations = dir.path().join("v10-migrations");
    std::fs::create_dir(&legacy_migrations).unwrap();
    for entry in
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")).unwrap()
    {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy()[..4]
            .parse::<i64>()
            .unwrap()
            <= 10
        {
            std::fs::copy(entry.path(), legacy_migrations.join(entry.file_name())).unwrap();
        }
    }
    let path = dir.path().join("praxis.db");
    let db = pool(&path).await;
    sqlx::migrate::Migrator::new(legacy_migrations.as_path())
        .await
        .unwrap()
        .run(&db)
        .await
        .unwrap();
    let owner = id();
    let device = id();
    let operation = id();
    let t = &f["independent"];
    let unknown = &f["unknownCompletion"];
    let at = s(&f["clock"], "now");
    sqlx::query("INSERT INTO local_profile VALUES(1,?,?)")
        .bind(&owner)
        .bind(&device)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,version,notes,completion_criteria,deadline,deadline_time_zone) VALUES(?,?,?,'temporary',?,?,?,?,?,?)")
        .bind(s(t,"id")).bind(&owner).bind(s(t,"title")).bind(at).bind(t["version"].as_i64().unwrap()).bind(s(t,"notes")).bind(s(t,"criteria")).bind(s(&t["deadline"],"atUtc")).bind(s(&t["deadline"],"displayTimezone")).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,version,status) VALUES(?,?,?,'temporary',?,?,'completed')")
        .bind(s(unknown,"id")).bind(&owner).bind(s(unknown,"title")).bind(at).bind(unknown["version"].as_i64().unwrap()).execute(&db).await.unwrap();
    for date in t["planDates"].as_array().unwrap() {
        sqlx::query("INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES(?,?,?,?,'Asia/Hong_Kong',?)")
            .bind(id()).bind(&owner).bind(s(t,"id")).bind(date.as_str().unwrap()).bind(at).execute(&db).await.unwrap();
    }
    let pending =
        json!({"operationId":operation,"taskId":t["id"],"title":t["title"],"occurredAt":at})
            .to_string();
    sqlx::query("INSERT INTO sync_outbox VALUES(?,?,?,1,'capture_inbox',?,?)")
        .bind(&operation)
        .bind(&owner)
        .bind(&device)
        .bind(&pending)
        .bind(at)
        .execute(&db)
        .await
        .unwrap();
    let before = snapshot(&db).await;
    db.close().await;

    let store = Store::open(&path).await.unwrap();
    let db = pool(&path).await;
    let detail = store.task_details(s(t, "id")).await.unwrap();
    assert_eq!(detail.version, 7);
    assert_eq!(detail.notes, s(t, "notes"));
    assert_eq!(detail.completion_criteria, s(t, "criteria"));
    assert_eq!(detail.project_id, None);
    let (deadline, plan): (String, String) =
        sqlx::query_as("SELECT deadline_value,plan_value FROM tasks WHERE id=?")
            .bind(s(t, "id"))
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&deadline).unwrap(),
        t["deadline"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&plan).unwrap(),
        json!({"kind":"date","date":"2026-11-10"})
    );
    let unknown_date: Option<String> =
        sqlx::query_scalar("SELECT completed_at FROM tasks WHERE id=?")
            .bind(s(unknown, "id"))
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        unknown_date, None,
        "migration must not invent a completion time"
    );
    let after = snapshot(&db).await;
    for table in [
        "local_profile",
        "sync_outbox",
        "daily_plan_items",
        "domain_events",
    ] {
        assert_eq!(after[table], before[table], "{table}");
    }
    let backups = backup::list_backups(dir.path()).unwrap();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].name.contains("before-upgrade"));
    let old_copy = pool(Path::new(&backups[0].path)).await;
    assert_eq!(snapshot(&old_copy).await, before);
    old_copy.close().await;
    db.close().await;
    store.close().await;
    let reopened = Store::open(&path).await.unwrap();
    let db = pool(&path).await;
    assert_eq!(
        snapshot(&db).await,
        after,
        "reopening must not remap IDs/versions or replay migrations"
    );
    export_report(
        "desktop-upgrade.json",
        json!({"synthetic":true,"fromSchema":10,"toSchema":praxis_desktop_lib::store::current_schema_version(),"originalTaskVersion":7,"taskIdUnchanged":true,"queuePreserved":true,"unknownCompletionStillNull":true,"beforeUpgradeBackupAllTablesEqual":true,"reopenAllTablesEqual":true}),
    );
    db.close().await;
    reopened.close().await;
}

#[tokio::test]
async fn personal_current_backup_keeps_legacy_data_ai_receipt_pending_conflict_and_task_identity() {
    let f = fixture();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    let db = pool(&path).await;
    let (owner, device): (String, String) =
        sqlx::query_as("SELECT owner_id,device_id FROM local_profile")
            .fetch_one(&db)
            .await
            .unwrap();
    let at = s(&f["clock"], "now");
    let p = &f["project"];
    let t = &f["independent"];
    for (project_id, name) in [
        (s(p, "id"), s(p, "name")),
        (s(&f, "secondProjectId"), "第二个个人项目"),
    ] {
        sqlx::query("INSERT INTO projects(id,owner_id,name,outcome,target_date,priority,version,created_at) VALUES(?,?,?,'保留目标',?,1,0,?)").bind(project_id).bind(&owner).bind(name).bind(s(p,"targetDate")).bind(at).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,version,notes,completion_criteria,deadline,deadline_time_zone,deadline_value) VALUES(?,?,?,'temporary',?,?,?,?,?,?,?)")
        .bind(s(t,"id")).bind(&owner).bind(s(t,"title")).bind(at).bind(7i64).bind(s(t,"notes")).bind(s(t,"criteria")).bind(s(&t["deadline"],"atUtc")).bind(s(&t["deadline"],"displayTimezone")).bind(t["deadline"].to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,deadline_value) VALUES(?,?,'只有日期且未加入今日','temporary',?,?)")
        .bind(s(&f["dateTask"],"id")).bind(&owner).bind(at).bind(f["dateTask"]["deadline"].to_string()).execute(&db).await.unwrap();
    for task in f["legacyTasks"].as_array().unwrap() {
        sqlx::query("INSERT INTO tasks(id,owner_id,title,project_id,status,source,created_at,version,parent_task_id,waiting,waiting_for,waiting_note,status_reason,cancelled_reason) VALUES(?,?,?,?,?,'temporary',?,?,?,?, '原有反馈','保留等待说明','保留阻塞说明','保留取消说明')")
            .bind(s(task,"id")).bind(&owner).bind(s(task,"title")).bind(s(p,"id")).bind(s(task,"status")).bind(at).bind(task["version"].as_i64().unwrap()).bind(task["parentId"].as_str()).bind(task["waiting"].as_bool().unwrap()).execute(&db).await.unwrap();
    }
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,version,status,completed_at) VALUES(?,?,?,'temporary',?,?,'completed',NULL)")
        .bind(s(&f["unknownCompletion"],"id")).bind(&owner).bind(s(&f["unknownCompletion"],"title")).bind(at).bind(4i64).execute(&db).await.unwrap();
    let reward = &f["reward"];
    sqlx::query("INSERT INTO tasks(id,owner_id,title,source,created_at,status,deleted_at,completed_at) VALUES(?,?,'旧已删除完成任务','temporary',?,'completed',?,?)")
        .bind(s(&f,"deletedCreditTaskId")).bind(&owner).bind(at).bind(at).bind(s(reward,"claimedAt")).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO cultivation_credits VALUES(?,?,?,1)")
        .bind(&owner)
        .bind(s(&f, "deletedCreditTaskId"))
        .bind(s(reward, "claimedAt"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cultivation_reward_agreements(id,owner_id,milestone,reward,status,binding_mode,created_at,unlocked_at,claimed_at) VALUES(?,?,?,?,'claimed','all',?,?,?)")
        .bind(s(reward,"id")).bind(&owner).bind(s(reward,"milestone")).bind(s(reward,"reward")).bind(s(reward,"claimedAt")).bind(s(reward,"claimedAt")).bind(s(reward,"claimedAt")).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO cultivation_achievements(id,owner_id,milestone,reward,created_at,claimed_at,reward_id) VALUES(?,?,?,?,?,?,?)")
        .bind(s(reward,"id")).bind(&owner).bind(s(reward,"milestone")).bind(s(reward,"reward")).bind(s(reward,"claimedAt")).bind(s(reward,"claimedAt")).bind(s(reward,"id")).execute(&db).await.unwrap();
    let ai = &f["ai"];
    let command: AiApplyCommand = serde_json::from_value(json!({"operationId":ai["operationId"],"runId":ai["runId"],"input":"旧个人采用记录","source":null,"project":null,"newProject":{"id":ai["projectId"],"name":"AI历史项目","outcome":"保留来源"},"basisTasks":[],"tasks":[{"id":ai["taskId"],"key":"s1","title":"已采用任务","criteria":"保留回执","estimatedMinutes":null,"dependsOn":[]}],"reward":null})).unwrap();
    let receipt = serde_json::to_value(store.ai_apply(&command).await.unwrap()).unwrap();

    let associate = AssignProjectCommand {
        operation_id: id(),
        project_id: s(p, "id").into(),
        task_id: s(t, "id").into(),
        expected_version: 7,
        occurred_at: at.into(),
    };
    store.assign_project(&associate).await.unwrap();
    store.assign_project(&associate).await.unwrap();
    assert_eq!(store.task_details(s(t, "id")).await.unwrap().version, 8);
    let stale = AssignProjectCommand {
        operation_id: id(),
        ..associate.clone()
    };
    assert!(store.assign_project(&stale).await.is_err());
    let expected_tasks: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id,version FROM tasks WHERE owner_id=? AND deleted_at IS NULL ORDER BY id",
    )
    .bind(&owner)
    .fetch_all(&db)
    .await
    .unwrap();
    let transfer: ProductivityCommand = serde_json::from_value(json!({"operationId":id(),"occurredAt":at,"action":{"type":"move","id":t["id"],"expectedVersion":8,"projectId":f["secondProjectId"],"parentId":null,"sectionId":null,"confirmCount":1,"expectedTasks":expected_tasks}})).unwrap();
    store.productivity_command(&transfer).await.unwrap();
    store.productivity_command(&transfer).await.unwrap();
    let moved = store.task_details(s(t, "id")).await.unwrap();
    assert_eq!(moved.project_id.as_deref(), Some(s(&f, "secondProjectId")));
    assert_eq!(moved.version, 9);
    assert_eq!(moved.notes, s(t, "notes"));
    assert_eq!(moved.completion_criteria, s(t, "criteria"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE id=?")
        .bind(s(t, "id"))
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let prepared = store.entities_prepare(&device).await.unwrap();
    assert!(!prepared.is_empty());
    store
        .entities_block(&prepared[0], Some(vec![]), "合成同步冲突，保留原操作")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE personal_compatibility_extension(id TEXT PRIMARY KEY,payload TEXT)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO personal_compatibility_extension VALUES('keep','未知扩展表 😀')")
        .execute(&db)
        .await
        .unwrap();
    let before = snapshot(&db).await;
    assert!(!before["sync_outbox"].is_empty());
    assert!(!before["lan_entity_pending"].is_empty());
    assert_eq!(before["ai_applications"].len(), 1);
    assert_eq!(before["cultivation_credits"].len(), 1);
    let backup_path = store.create_backup(dir.path()).await.unwrap();
    let name = Path::new(&backup_path)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    assert!(backup::prepare_restore(dir.path(), "../praxis.db")
        .await
        .is_err());
    assert_eq!(snapshot(&db).await, before);
    let recovered_path = backup::prepare_restore(dir.path(), name).await.unwrap();
    let restored = Store::open(Path::new(&recovered_path)).await.unwrap();
    let restored_db = pool(Path::new(&recovered_path)).await;
    assert_eq!(snapshot(&restored_db).await, before);
    assert_eq!(snapshot(&db).await, before);
    assert_eq!(
        serde_json::to_value(
            restored
                .ai_receipt(s(ai, "operationId"))
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        receipt
    );
    assert_eq!(
        serde_json::to_value(restored.ai_apply(&command).await.unwrap()).unwrap(),
        receipt
    );
    assert_eq!(
        snapshot(&restored_db).await,
        before,
        "receipt replay must not recreate adopted tasks"
    );
    export_report(
        "desktop-roundtrip.json",
        json!({"synthetic":true,"schema":25,"tablesCompared":before.len(),"allTablesEqualAfterRestore":true,"originalUnchanged":true,"taskVersions":[7,8,9],"stableTaskIdAcrossProjectChanges":true,"outboxRows":before["sync_outbox"].len(),"pendingCommands":before["lan_entity_pending"].len(),"aiReceipts":1,"legacyCredits":1,"claimedRewards":1,"unknownTableRetained":true}),
    );
    restored_db.close().await;
    restored.close().await;
    db.close().await;
    store.close().await;
}
