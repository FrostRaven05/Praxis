use super::{StoreResult, MIGRATOR};
use serde::Deserialize;
use sqlx::{
    migrate::{Migration, Migrator},
    SqlitePool,
};
use std::borrow::Cow;

#[derive(Deserialize)]
struct DeliveredLineEnding {
    version: i64,
    canonical: String,
    legacy: String,
}

const DELIVERED: &str = include_str!("../../migrations/legacy-line-endings.json");

fn hexadecimal(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn checksum(migration: &Migration, sql: String) -> Vec<u8> {
    Migration::new(
        migration.version,
        migration.description.clone(),
        migration.migration_type,
        Cow::Owned(sql),
        migration.no_tx,
    )
    .checksum
    .into_owned()
}

fn accepts(migration: &Migration, saved: &[u8], delivered: &[DeliveredLineEnding]) -> bool {
    let normalized = migration.sql.replace("\r\n", "\n");
    let canonical = checksum(migration, normalized.clone());
    if saved == canonical || saved == checksum(migration, normalized.replace('\n', "\r\n")) {
        return true;
    }
    let canonical = hexadecimal(&canonical);
    let saved = hexadecimal(saved);
    delivered.iter().any(|entry| {
        entry.version == migration.version && entry.canonical == canonical && entry.legacy == saved
    })
}

/// Validate historical line endings in memory; never rewrite applied migration metadata.
/// Mixed variants are tied to both the delivered digest and the current canonical SQL.
pub(super) async fn run(pool: &SqlitePool) -> StoreResult<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| error.to_string())?;
    let applied: Vec<(i64, Vec<u8>)> = if exists {
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations WHERE success=1")
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?
    } else {
        Vec::new()
    };
    let delivered: Vec<DeliveredLineEnding> = serde_json::from_str(DELIVERED)
        .map_err(|_| "Invalid delivered migration compatibility data".to_owned())?;
    let mut migrations = MIGRATOR.iter().cloned().collect::<Vec<_>>();
    for migration in &mut migrations {
        if let Some((_, saved)) = applied
            .iter()
            .find(|(version, _)| *version == migration.version)
        {
            if saved.as_slice() != migration.checksum.as_ref()
                && accepts(migration, saved, &delivered)
            {
                migration.checksum = Cow::Owned(saved.clone());
            }
        }
    }
    Migrator {
        migrations: Cow::Owned(migrations),
        ignore_missing: MIGRATOR.ignore_missing,
        locking: MIGRATOR.locking,
        no_tx: MIGRATOR.no_tx,
    }
    .run(pool)
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivered_digest_does_not_authorize_changes_to_current_sql() {
        let delivered: Vec<DeliveredLineEnding> = serde_json::from_str(DELIVERED).unwrap();
        let entry = &delivered[0];
        let saved: Vec<u8> = (0..entry.legacy.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&entry.legacy[i..i + 2], 16).unwrap())
            .collect();
        let mut migration = MIGRATOR
            .iter()
            .find(|m| m.version == entry.version)
            .unwrap()
            .clone();
        assert!(accepts(&migration, &saved, &delivered));
        migration.sql = Cow::Owned(format!("{}\n-- modified source\n", migration.sql));
        assert!(!accepts(&migration, &saved, &delivered));
    }
}
