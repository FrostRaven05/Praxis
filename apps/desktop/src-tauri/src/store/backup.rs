use super::*;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}
impl Store {
    pub async fn create_backup(&self, root: &Path) -> StoreResult<String> {
        snapshot(&self.pool, root, "manual").await
    }
}

pub fn selected_database(root: &Path) -> PathBuf {
    let name = std::fs::read_to_string(root.join("active-database.txt")).unwrap_or_default();
    let name = name.trim();
    if name.starts_with("recovered-")
        && name.ends_with(".db")
        && name.len() == 49
        && Uuid::parse_str(&name[10..46]).is_ok()
        && root.join(name).is_file()
    {
        root.join(name)
    } else {
        root.join("praxis.db")
    }
}
pub fn list_backups(root: &Path) -> StoreResult<Vec<BackupInfo>> {
    let dir = root.join("backups");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".db") && e.file_type().map_err(|e| e.to_string())?.is_file() {
            result.push(BackupInfo {
                name,
                path: e.path().display().to_string(),
                bytes: e.metadata().map_err(|e| e.to_string())?.len(),
            });
        }
    }
    result.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(result)
}
pub async fn snapshot(pool: &SqlitePool, root: &Path, label: &str) -> StoreResult<String> {
    let dir = root.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "{}-{label}-{}.db",
        chrono::Utc::now().format("%Y%m%dT%H%M%S"),
        Uuid::new_v4()
    ));
    // SQLite includes committed WAL pages and obtains its own consistent snapshot.
    sqlx::query("VACUUM INTO ?")
        .bind(path.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}
pub async fn prepare_restore(root: &Path, name: &str) -> StoreResult<String> {
    if !list_backups(root)?.iter().any(|b| b.name == name) {
        return Err("USER:请选择列表中的备份".into());
    }
    let source = root.join("backups").join(name);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&source)
                .read_only(true),
        )
        .await
        .map_err(|e| e.to_string())?;
    let validation = async {
        let ok: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        if ok != "ok" {
            return Err("USER:备份完整性检查未通过".to_string());
        }
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
        if !violations.is_empty() {
            return Err("USER:备份存在损坏的引用".into());
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM local_profile")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
        let version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
        )
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
        if count != 1 || !(1..=current_schema_version()).contains(&version) {
            return Err("USER:不支持此备份版本".into());
        }
        Ok::<(), String>(())
    }
    .await;
    pool.close().await;
    validation?;
    let filename = format!("recovered-{}.db", Uuid::new_v4());
    let destination = root.join(&filename);
    std::fs::copy(source, &destination).map_err(|e| e.to_string())?;
    // Validate and migrate the copy before making it selectable. The original is untouched.
    let restored = Store::open(&destination).await?;
    restored.close().await;
    let pointer = root.join("active-database.txt");
    let pending_pointer = root.join(format!("active-database-{}.tmp", Uuid::new_v4()));
    use std::io::Write;
    let mut file = std::fs::File::create(&pending_pointer).map_err(|e| e.to_string())?;
    file.write_all(filename.as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    // Same-directory rename replaces the pointer only after its contents are durable.
    std::fs::rename(pending_pointer, pointer).map_err(|e| e.to_string())?;
    Ok(destination.display().to_string())
}

