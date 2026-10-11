//! Wire IDs and native primary keys have separate lifecycles during initial merging.
use super::*;

pub(super) async fn retain_native(
    tx: &mut Transaction<'_, Sqlite>,
    entity: &Entity,
    table: &str,
    row: &Value,
) -> StoreResult<bool> {
    if !entity.deleted || entity.kind != "desktop_row" {
        return Ok(false);
    }
    let key = json!(columns(tx, table)
        .await?
        .iter()
        .filter(|(c, _, _, _, pk)| *pk > 0 && c != "owner_id")
        .map(|(c, _, _, _, _)| (c.clone(), val(row, c).clone()))
        .collect::<Map<String, Value>>());
    // register() has already marked every tombstone in this batch. Only a live
    // identity outside the deletion set can keep the shared native row alive.
    Ok(aliases(tx, table, &key)
        .await?
        .iter()
        .any(|id| id != &entity.id))
}

pub(super) async fn aliases(
    tx: &mut Transaction<'_, Sqlite>,
    table: &str,
    key: &Value,
) -> StoreResult<Vec<String>> {
    let rows:Vec<(String,String)>=sqlx::query_as("SELECT id,native_key FROM lan_entities WHERE native_table=? AND native_key IS NOT NULL AND deleted=0 ORDER BY id").bind(table).fetch_all(&mut **tx).await.map_err(err)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, raw)| {
            serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(|stored| {
                    key.as_object()
                        .unwrap()
                        .iter()
                        .all(|(k, v)| val(stored, k) == v)
                })
                .map(|_| id)
        })
        .collect())
}
pub(super) async fn wire_row(
    tx: &mut Transaction<'_, Sqlite>,
    e: &Entity,
    row: &Value,
) -> StoreResult<Value> {
    let mut row = row.clone();
    let cols = columns(tx, &s(&e.data, "table")).await?;
    // Native aliases retain their local FK identity; the serialized row keeps its original wire key.
    for (c, _, _, _, pk) in cols {
        if pk > 0 && c != "owner_id" {
            if let Some(v) = val(&e.data, "row").get(&c) {
                row[&c] = v.clone();
            }
        }
    }
    for (field, target) in [("label_id", "labels"), ("plan_id", "daily_plan_items")] {
        if let Some(id) = row.get(field).and_then(Value::as_str) {
            let wire:Option<String>=sqlx::query_scalar("SELECT json_extract(data,'$.row.id') FROM lan_entities WHERE native_table=? AND json_extract(native_key,'$.id')=? AND deleted=0 ORDER BY id LIMIT 1").bind(target).bind(id).fetch_optional(&mut **tx).await.map_err(err)?.flatten();
            if let Some(wire) = wire {
                row[field] = json!(wire);
            }
        }
    }
    Ok(row)
}
pub(super) async fn rekey(
    tx: &mut Transaction<'_, Sqlite>,
    e: &Entity,
    table: &str,
    row: &Value,
) -> StoreResult<()> {
    if e.kind == "desktop_row" {
        let mut key = json!(columns(tx, table)
            .await?
            .iter()
            .filter(|(c, _, _, _, pk)| *pk > 0 && c != "owner_id")
            .map(|(c, _, _, _, _)| (c.clone(), val(row, c).clone()))
            .collect::<Map<String, Value>>());
        let prior: Option<String> =
            sqlx::query_scalar("SELECT native_key FROM lan_entities WHERE id=?")
                .bind(&e.id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(err)?
                .flatten();
        if let Some(prior) = prior {
            let prior: Value = serde_json::from_str(&prior).map_err(|e| e.to_string())?;
            if let Some(v) = prior.get("_initial_version") {
                key["_initial_version"] = v.clone();
            }
        }
        sqlx::query("UPDATE lan_entities SET native_key=? WHERE id=?")
            .bind(key.to_string())
            .bind(&e.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
    }
    Ok(())
}
pub(super) async fn register(
    tx: &mut Transaction<'_, Sqlite>,
    entities: &[Entity],
    owner: &str,
) -> StoreResult<()> {
    for e in entities.iter().filter(|e| e.kind == "desktop_row") {
        let table = s(&e.data, "table");
        let incoming = val(&e.data, "row");
        let cols = columns(tx, &table).await?;
        let known: Option<String> =
            sqlx::query_scalar("SELECT native_key FROM lan_entities WHERE id=? AND native_table=?")
                .bind(&e.id)
                .bind(&table)
                .fetch_optional(&mut **tx)
                .await
                .map_err(err)?
                .flatten();
        let native = if let Some(key) = known {
            serde_json::from_str::<Value>(&key).map_err(|e| e.to_string())?
        } else {
            let existing = rows(tx, &table)
                .await?
                .into_iter()
                .find(|r| match table.as_str() {
                    "labels" => {
                        s(r, "owner_id") == owner && val(r, "name") == val(incoming, "name")
                    }
                    "daily_plan_items" => {
                        s(r, "owner_id") == owner
                            && val(r, "task_id") == val(incoming, "task_id")
                            && val(r, "execution_date") == val(incoming, "execution_date")
                    }
                    _ => false,
                });
            let row = existing.as_ref().unwrap_or(incoming);
            let mut key = json!(cols
                .iter()
                .filter(|(c, _, _, _, pk)| *pk > 0 && c != "owner_id")
                .map(|(c, _, _, _, _)| (c.clone(), val(row, c).clone()))
                .collect::<Map<String, Value>>());
            if existing.is_some()
                && cols.iter().any(|(c, _, _, _, pk)| {
                    *pk > 0 && c != "owner_id" && val(row, c) != val(incoming, c)
                })
            {
                key["_initial_version"] = json!(e.version);
            }
            key
        };
        save_mirror(tx, e).await?;
        sqlx::query("UPDATE lan_entities SET native_table=?,native_key=? WHERE id=?")
            .bind(&table)
            .bind(native.to_string())
            .bind(&e.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
    }
    Ok(())
}
pub(super) async fn adapt(
    tx: &mut Transaction<'_, Sqlite>,
    e: &Entity,
    table: &str,
    row: &mut Value,
) -> StoreResult<()> {
    if e.kind != "desktop_row" {
        return Ok(());
    }
    let key: Option<String> =
        sqlx::query_scalar("SELECT native_key FROM lan_entities WHERE id=? AND native_table=?")
            .bind(&e.id)
            .bind(table)
            .fetch_optional(&mut **tx)
            .await
            .map_err(err)?
            .flatten();
    if let Some(key) = key {
        let key: Value = serde_json::from_str(&key).map_err(|e| e.to_string())?;
        let existing = rows(tx, table).await?.into_iter().find(|r| {
            key.as_object()
                .unwrap()
                .iter()
                .filter(|(k, _)| !k.starts_with('_'))
                .all(|(k, v)| val(r, k) == v)
        });
        if let Some(existing) = existing {
            // A newly discovered alias cannot erase existing estimates, focus flags, or history.
            let incoming_key = json!(columns(tx, table)
                .await?
                .iter()
                .filter(|(c, _, _, _, pk)| *pk > 0 && c != "owner_id")
                .map(|(c, _, _, _, _)| (c.clone(), val(row, c).clone()))
                .collect::<Map<String, Value>>());
            if incoming_key != key
                && key.get("_initial_version").and_then(Value::as_i64) == Some(e.version)
            {
                let mut retained = existing.clone();
                for (k, v) in row.as_object().unwrap() {
                    if !retained.as_object().unwrap().contains_key(k) {
                        retained[k] = v.clone();
                    }
                }
                *row = retained;
            } else {
                for (k, v) in existing.as_object().unwrap() {
                    if row.get(k).is_none() {
                        row[k] = v.clone();
                    }
                }
            }
        }
        for (k, v) in key
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| !k.starts_with('_'))
        {
            row[k] = v.clone();
        }
    }
    for (field, target) in [("label_id", "labels"), ("plan_id", "daily_plan_items")] {
        if let Some(id) = row.get(field).and_then(Value::as_str) {
            let keys:Vec<String>=sqlx::query_scalar("SELECT native_key FROM lan_entities WHERE native_table=? AND json_extract(data,'$.row.id')=? AND native_key IS NOT NULL").bind(target).bind(id).fetch_all(&mut **tx).await.map_err(err)?;
            if let Some(key) = keys.first() {
                let key: Value = serde_json::from_str(key).map_err(|e| e.to_string())?;
                row[field] = val(&key, "id").clone();
            }
        }
    }
    Ok(())
}
pub(super) async fn collisions(
    tx: &mut Transaction<'_, Sqlite>,
    remote: &[Entity],
) -> StoreResult<Vec<Entity>> {
    let current = snapshot(tx).await?;
    let mut collisions = BTreeMap::new();
    for e in remote
        .iter()
        .filter(|e| !e.deleted && ["settings", "habit_check"].contains(&e.kind.as_str()))
    {
        for local in current
            .values()
            .filter(|l| !l.deleted && l.id != e.id && l.kind == e.kind)
        {
            if e.kind == "settings"
                || (val(&local.data, "habitId") == val(&e.data, "habitId")
                    && val(&local.data, "date") == val(&e.data, "date"))
            {
                collisions.insert(local.id.clone(), local.clone());
            }
        }
    }
    Ok(collisions.into_values().collect())
}
fn same_logical(a: &Entity, b: &Entity) -> bool {
    a.kind == b.kind
        && (a.kind == "settings"
            || (a.kind == "habit_check"
                && val(&a.data, "habitId") == val(&b.data, "habitId")
                && val(&a.data, "date") == val(&b.data, "date")))
}
pub(super) async fn adopt(
    tx: &mut Transaction<'_, Sqlite>,
    remote: &[Entity],
    selected: &mut Vec<Entity>,
) -> StoreResult<()> {
    let collisions = collisions(tx, remote).await?;
    for prior in collisions {
        let canonical = remote
            .iter()
            .find(|e| !e.deleted && same_logical(&prior, e))
            .ok_or("缺少规范身份")?;
        for local in selected.iter_mut().filter(|e| e.id == prior.id) {
            local.id = canonical.id.clone();
            local.created_at = canonical.created_at.clone();
        }
        sqlx::query("DELETE FROM lan_entity_local WHERE id=?")
            .bind(&prior.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
        sqlx::query("DELETE FROM lan_entities WHERE id=?")
            .bind(&prior.id)
            .execute(&mut **tx)
            .await
            .map_err(err)?;
    }
    Ok(())
}
