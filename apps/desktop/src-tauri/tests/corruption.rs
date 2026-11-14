use praxis_desktop_lib::store::Store;
use sqlx::{Connection, SqliteConnection};
use std::io::{Seek, SeekFrom, Write};

#[tokio::test]
async fn corrupt_project_page_is_detected_before_the_workspace_is_opened() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("praxis.db");
    let store = Store::open(&path).await.unwrap();
    store.close().await;
    let mut db = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let page: i64 = sqlx::query_scalar("SELECT rootpage FROM sqlite_master WHERE name='projects'")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.seek(SeekFrom::Start(((page - 1) * size) as u64))
        .unwrap();
    file.write_all(&[0]).unwrap();
    drop(file);
    let error = match Store::open(&path).await {
        Ok(store) => {
            store.close().await;
            panic!("corrupt database was accepted")
        }
        Err(error) => error,
    };
    assert!(error.starts_with("DATABASE_CORRUPT"), "{error}");
    assert!(
        path.exists(),
        "corrupt data must remain available for recovery"
    );
}
