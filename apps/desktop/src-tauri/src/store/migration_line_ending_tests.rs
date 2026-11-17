use super::{CaptureCommand, Store, MIGRATOR};
use sqlx::{migrate::Migration, sqlite::SqliteConnectOptions, SqlitePool};
use std::{borrow::Cow, path::Path};
use uuid::Uuid;

async fn pool(path: &Path) -> SqlitePool {
    SqlitePool::connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .unwrap()
}

async fn recorded(pool: &SqlitePool) -> Vec<(i64, Vec<u8>)> {
    sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .unwrap()
}

fn checksum(m: &Migration, sql: String) -> Vec<u8> {
    Migration::new(
        m.version,
        m.description.clone(),
        m.migration_type,
        Cow::Owned(sql),
        m.no_tx,
    )
    .checksum
    .into_owned()
}

#[tokio::test]
async fn migration_line_endings_keep_pending_work_and_recorded_checksums() {
    for crlf in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("line-endings.db");
        let store = Store::open(&path).await.unwrap();
        let task = Uuid::new_v4().to_string();
        store
            .capture(&CaptureCommand {
                operation_id: Uuid::new_v4().to_string(),
                task_id: task.clone(),
                plan_id: Uuid::new_v4().to_string(),
                title: "Pending upgrade work".into(),
                execution_date: "2026-11-17".into(),
                time_zone: "Asia/Hong_Kong".into(),
                occurred_at: "2026-11-17T01:00:00Z".into(),
            })
            .await
            .unwrap();
        let pending: Vec<String> =
            sqlx::query_scalar("SELECT payload FROM sync_outbox ORDER BY operation_id")
                .fetch_all(&store.pool)
                .await
                .unwrap();
        store.close().await;
        let db = pool(&path).await;
        for migration in MIGRATOR.iter() {
            let normalized = migration.sql.replace("\r\n", "\n");
            let sql = if crlf {
                normalized.replace('\n', "\r\n")
            } else {
                normalized
            };
            sqlx::query("UPDATE _sqlx_migrations SET checksum=? WHERE version=?")
                .bind(checksum(migration, sql))
                .bind(migration.version)
                .execute(&db)
                .await
                .unwrap();
        }
        let before = recorded(&db).await;
        db.close().await;
        let reopened = match Store::open(&path).await {
            Ok(store) => store,
            Err(error) => panic!("Line-ending-only upgrade rejected: {error}"),
        };
        assert!(reopened
            .list_day("2026-11-17")
            .await
            .unwrap()
            .iter()
            .any(|row| row.task_id == task));
        assert_eq!(recorded(&reopened.pool).await, before);
        let after: Vec<String> =
            sqlx::query_scalar("SELECT payload FROM sync_outbox ORDER BY operation_id")
                .fetch_all(&reopened.pool)
                .await
                .unwrap();
        assert_eq!(after, pending);
        reopened.close().await;
    }
}

#[tokio::test]
async fn delivered_mixed_line_endings_are_accepted_without_rewriting_history() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("delivered.db");
    let store = Store::open(&path).await.unwrap();
    store.close().await;
    let db = pool(&path).await;
    let records: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("legacy_line_endings.json")).unwrap();
    for row in records {
        let hex = row["legacy"].as_str().unwrap();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        sqlx::query("UPDATE _sqlx_migrations SET checksum=? WHERE version=?")
            .bind(bytes)
            .bind(row["version"].as_i64().unwrap())
            .execute(&db)
            .await
            .unwrap();
    }
    let before = recorded(&db).await;
    db.close().await;
    let reopened = match Store::open(&path).await {
        Ok(store) => store,
        Err(error) => panic!("Delivered migration checksum rejected: {error}"),
    };
    assert_eq!(recorded(&reopened.pool).await, before);
    reopened.close().await;
}

#[tokio::test]
async fn unrelated_migration_checksum_is_still_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("modified.db");
    let store = Store::open(&path).await.unwrap();
    store.close().await;
    let db = pool(&path).await;
    sqlx::query("UPDATE _sqlx_migrations SET checksum=? WHERE version=1")
        .bind(vec![127u8; 48])
        .execute(&db)
        .await
        .unwrap();
    let before = recorded(&db).await;
    db.close().await;
    match Store::open(&path).await {
        Ok(store) => {
            store.close().await;
            panic!("An unrelated checksum was accepted");
        }
        Err(error) => assert!(error.contains("migration"), "{error}"),
    }
    let db = pool(&path).await;
    assert_eq!(recorded(&db).await, before);
    db.close().await;
}
