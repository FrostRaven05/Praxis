use super::*;
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanCapture {
    pub id: String,
    pub version: i64,
    pub raw_text: String,
    pub deleted: bool,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanCommand {
    pub operation_id: String,
    pub device_id: String,
    pub id: String,
    pub expected_version: Option<i64>,
    pub raw_text: String,
    pub deleted: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChange {
    pub capture: LanCapture,
    pub cursor: i64,
}
fn validate_remote(c: &LanCapture) -> StoreResult<()> {
    Uuid::parse_str(&c.id).map_err(|_| "无效远端标识")?;
    if c.version < 1
        || c.raw_text.trim().is_empty()
        || c.raw_text.chars().count() > 100000
        || chrono::DateTime::parse_from_rfc3339(&c.updated_at).is_err()
    {
        return Err("无效远端收集项".into());
    }
    Ok(())
}
impl Store {
    pub async fn lan_bind(&self, endpoint: &str, owner: &str, device: &str) -> StoreResult<()> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let old: Option<(String, String, String)> = sqlx::query_as(
            "SELECT endpoint,remote_owner,device_id FROM lan_binding WHERE owner_id=?",
        )
        .bind(&self.owner_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if old
            .as_ref()
            .is_some_and(|x| x != &(endpoint.into(), owner.into(), device.into()))
        {
            return Err("配对与此工作空间不匹配，已停止同步".into());
        }
        sqlx::query("INSERT OR IGNORE INTO lan_binding(owner_id,endpoint,remote_owner,device_id) VALUES(?,?,?,?)").bind(&self.owner_id).bind(endpoint).bind(owner).bind(device).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn lan_prepare(&self, device: &str) -> StoreResult<Vec<LanCommand>> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let rows:Vec<(String,String,bool,Option<i64>)>=sqlx::query_as("SELECT c.id,c.raw_text,c.sync_deleted,s.version FROM captures c LEFT JOIN lan_shadow s ON s.id=c.id WHERE c.owner_id=? AND NOT EXISTS(SELECT 1 FROM lan_pending p WHERE p.id=c.id) AND (s.id IS NULL OR c.raw_text<>s.raw_text OR c.sync_deleted<>s.deleted)").bind(&self.owner_id).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
        for (id, raw_text, deleted, expected_version) in rows {
            let command = LanCommand {
                operation_id: Uuid::new_v4().to_string(),
                device_id: device.into(),
                id: id.clone(),
                raw_text,
                deleted,
                expected_version,
            };
            sqlx::query("INSERT INTO lan_pending(id,payload) VALUES(?,?)")
                .bind(id)
                .bind(serde_json::to_string(&command).map_err(|e| e.to_string())?)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        let payloads: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM lan_pending WHERE conflict=0 ORDER BY rowid LIMIT 50",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        payloads
            .into_iter()
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .collect()
    }
    pub async fn lan_ack(&self, command: &LanCommand, c: &LanCapture) -> StoreResult<()> {
        validate_remote(c)?;
        if command.id != c.id || command.raw_text != c.raw_text || command.deleted != c.deleted {
            return Err("同步回执不匹配".into());
        }
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO lan_shadow(id,version,raw_text,deleted) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,raw_text=excluded.raw_text,deleted=excluded.deleted WHERE excluded.version>=lan_shadow.version").bind(&c.id).bind(c.version).bind(&c.raw_text).bind(c.deleted).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query(
            "DELETE FROM lan_pending WHERE id=? AND json_extract(payload,'$.operationId')=?",
        )
        .bind(&command.id)
        .bind(&command.operation_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn lan_conflict(&self, id: &str) -> StoreResult<()> {
        sqlx::query("UPDATE lan_pending SET conflict=1 WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub async fn lan_cursor(&self) -> StoreResult<i64> {
        sqlx::query_scalar("SELECT cursor FROM lan_binding WHERE owner_id=?")
            .bind(&self.owner_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn lan_pull(&self, changes: &[LanChange], cursor: i64) -> StoreResult<()> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let previous: i64 = sqlx::query_scalar("SELECT cursor FROM lan_binding WHERE owner_id=?")
            .bind(&self.owner_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if cursor != changes.last().map(|c| c.cursor).unwrap_or(previous)
            || changes
                .iter()
                .enumerate()
                .any(|(i, c)| c.cursor != previous + i as i64 + 1)
        {
            return Err("无效同步游标".into());
        }
        for change in changes {
            let c = &change.capture;
            validate_remote(c)?;
            let shadow: Option<(i64, String, bool)> =
                sqlx::query_as("SELECT version,raw_text,deleted FROM lan_shadow WHERE id=?")
                    .bind(&c.id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            if shadow.as_ref().is_some_and(|s| s.0 >= c.version) {
                continue;
            }
            let local: Option<(String, bool)> = sqlx::query_as(
                "SELECT raw_text,sync_deleted FROM captures WHERE id=? AND owner_id=?",
            )
            .bind(&c.id)
            .bind(&self.owner_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            let pending: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lan_pending WHERE id=?)")
                    .bind(&c.id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            let same = local
                .as_ref()
                .is_some_and(|l| l.0 == c.raw_text && l.1 == c.deleted);
            let clean = same
                || !pending
                    && (local.is_none()
                        || local.as_ref().is_some_and(|l| {
                            shadow.as_ref().is_some_and(|s| l.0 == s.1 && l.1 == s.2)
                        })
                        || local
                            .as_ref()
                            .is_some_and(|l| l.0 == c.raw_text && l.1 == c.deleted));
            if clean {
                sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)").bind(Uuid::new_v4().to_string()).bind(&self.owner_id).bind(&c.id).bind("capture_sync_received").bind(chrono::Utc::now().to_rfc3339()).bind(json!({"before":local.as_ref().map(|l|json!({"rawText":l.0,"deleted":l.1})),"after":c,"cursor":change.cursor}).to_string()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                if same {
                    sqlx::query("DELETE FROM lan_pending WHERE id=?")
                        .bind(&c.id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                sqlx::query("INSERT INTO captures(id,owner_id,raw_text,created_at,sync_deleted) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET raw_text=excluded.raw_text,sync_deleted=excluded.sync_deleted,version=captures.version+1").bind(&c.id).bind(&self.owner_id).bind(&c.raw_text).bind(&c.updated_at).bind(c.deleted).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("INSERT INTO lan_shadow(id,version,raw_text,deleted) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,raw_text=excluded.raw_text,deleted=excluded.deleted").bind(&c.id).bind(c.version).bind(&c.raw_text).bind(c.deleted).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            } else {
                // Preserve both the frozen command and incoming version. No implicit last-writer-wins.
                if !pending {
                    let (raw_text, deleted) = local.ok_or("本地原文不存在")?;
                    let device: String =
                        sqlx::query_scalar("SELECT device_id FROM lan_binding WHERE owner_id=?")
                            .bind(&self.owner_id)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                    let cmd = LanCommand {
                        operation_id: Uuid::new_v4().to_string(),
                        device_id: device,
                        id: c.id.clone(),
                        expected_version: shadow.as_ref().map(|s| s.0),
                        raw_text,
                        deleted,
                    };
                    sqlx::query("INSERT INTO lan_pending(id,payload,conflict) VALUES(?,?,1)")
                        .bind(&c.id)
                        .bind(serde_json::to_string(&cmd).map_err(|e| e.to_string())?)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                sqlx::query("UPDATE lan_pending SET conflict=1,remote=? WHERE id=?")
                    .bind(serde_json::to_string(c).map_err(|e| e.to_string())?)
                    .bind(&c.id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query("UPDATE lan_binding SET cursor=?,last_success=? WHERE owner_id=?")
            .bind(cursor)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&self.owner_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    pub async fn lan_status(&self) -> StoreResult<Value> {
        let conflicts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM lan_pending WHERE conflict=1")
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM lan_pending WHERE conflict=0")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let last: Option<String> =
            sqlx::query_scalar("SELECT last_success FROM lan_binding WHERE owner_id=?")
                .bind(&self.owner_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| e.to_string())?
                .flatten();
        Ok(json!({"conflictCount":conflicts,"pendingCount":pending,"lastSuccess":last}))
    }
    pub async fn lan_edit_capture(
        &self,
        operation: &str,
        id: &str,
        expected: i64,
        text: &str,
    ) -> StoreResult<()> {
        Uuid::parse_str(operation).map_err(|_| "操作标识无效")?;
        if text.trim().is_empty() || text.chars().count() > 100000 {
            return Err("请填写 1–100000 字符原文".into());
        }
        let payload = json!([id, expected, text]).to_string();
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let old: Option<String> =
            sqlx::query_scalar("SELECT payload FROM lan_capture_edits WHERE operation_id=?")
                .bind(operation)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            return if old == payload {
                Ok(())
            } else {
                Err("重试操作内容不一致".into())
            };
        }
        let before: Option<String> =
            sqlx::query_scalar("SELECT raw_text FROM captures WHERE id=? AND owner_id=?")
                .bind(id)
                .bind(&self.owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        let count=sqlx::query("UPDATE captures SET raw_text=?,version=version+1 WHERE id=? AND owner_id=? AND version=? AND sync_deleted=0").bind(text).bind(id).bind(&self.owner_id).bind(expected).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
        if count != 1 {
            return Err("原文已更新，请重新打开后编辑；草稿仍保留".into());
        }
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(operation)
            .bind(&self.owner_id)
            .bind(id)
            .bind("capture_raw_edited")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(json!({"before":{"rawText":before},"after":{"rawText":text}}).to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO lan_capture_edits VALUES(?,?)")
            .bind(operation)
            .bind(payload)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
}
impl Store {
    pub async fn lan_conflicts(&self) -> StoreResult<Value> {
        let rows:Vec<(String,String,Option<String>)>=sqlx::query_as("SELECT c.id,c.raw_text,p.remote FROM lan_pending p JOIN captures c ON c.id=p.id WHERE p.conflict=1 AND c.owner_id=?").bind(&self.owner_id).fetch_all(&self.pool).await.map_err(|e|e.to_string())?;
        Ok(Value::Array(rows.into_iter().map(|(id,local,remote)|json!({"id":id,"localText":local,"remote":remote.and_then(|r|serde_json::from_str::<Value>(&r).ok())})).collect()))
    }
    pub async fn lan_resolve(
        &self,
        operation: &str,
        id: &str,
        remote_version: i64,
        local_text: &str,
        keep_copy: bool,
    ) -> StoreResult<()> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        Uuid::parse_str(operation).map_err(|_| "操作标识无效")?;
        let decision = json!([id, remote_version, local_text, keep_copy]);
        let receipt: Option<String> =
            sqlx::query_scalar("SELECT payload FROM lan_capture_edits WHERE operation_id=?")
                .bind(operation)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if let Some(receipt) = receipt {
            let r: Value = serde_json::from_str(&receipt).map_err(|e| e.to_string())?;
            return if r["decision"] == decision {
                Ok(())
            } else {
                Err("重试操作内容不一致".into())
            };
        }
        let copy_id = keep_copy.then(|| Uuid::new_v4().to_string());
        let remote: String = sqlx::query_scalar(
            "SELECT remote FROM lan_pending WHERE id=? AND conflict=1 AND remote IS NOT NULL",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "请等待服务端冲突版本到达")?;
        let c: LanCapture = serde_json::from_str(&remote).map_err(|_| "冲突内容无效")?;
        let current: String =
            sqlx::query_scalar("SELECT raw_text FROM captures WHERE id=? AND owner_id=?")
                .bind(id)
                .bind(&self.owner_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if c.version != remote_version || current != local_text {
            return Err("冲突内容已更新，请刷新后再次选择".into());
        }
        if keep_copy {
            sqlx::query("INSERT INTO captures(id,owner_id,raw_text,created_at) VALUES(?,?,?,?)")
                .bind(copy_id.as_ref().unwrap())
                .bind(&self.owner_id)
                .bind(&current)
                .bind(chrono::Utc::now().to_rfc3339())
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        let resolution = json!({"kind":"sync_conflict_resolution","decision":decision,"copyId":copy_id,"captureId":id,"before":{"rawText":current},"after":c,"keepCopy":keep_copy});
        sqlx::query("INSERT INTO lan_capture_edits VALUES(?,?)")
            .bind(operation)
            .bind(resolution.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO content_events VALUES(?,?,?,?,?,?)")
            .bind(operation)
            .bind(&self.owner_id)
            .bind(id)
            .bind("capture_sync_resolved")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(resolution.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE captures SET raw_text=?,sync_deleted=?,version=version+1 WHERE id=? AND owner_id=?").bind(&c.raw_text).bind(c.deleted).bind(id).bind(&self.owner_id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO lan_shadow VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,raw_text=excluded.raw_text,deleted=excluded.deleted").bind(id).bind(c.version).bind(&c.raw_text).bind(c.deleted).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        sqlx::query("DELETE FROM lan_pending WHERE id=?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (tempfile::TempDir, Store, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("lan.sqlite")).await.unwrap();
        let device = Uuid::new_v4().to_string();
        s.lan_bind("https://127.0.0.1:4318", "owner", &device)
            .await
            .unwrap();
        let id = Uuid::new_v4().to_string();
        s.content_command(&ContentCommand {
            operation_id: Uuid::new_v4().to_string(),
            occurred_at: chrono::Utc::now().to_rfc3339(),
            action: ContentAction::Capture {
                id: id.clone(),
                raw_text: "原文\n第一行".into(),
            },
        })
        .await
        .unwrap();
        (dir, s, id, device)
    }
    fn remote(id: &str, version: i64, text: &str) -> LanCapture {
        LanCapture {
            id: id.into(),
            version,
            raw_text: text.into(),
            deleted: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
    #[tokio::test]
    async fn lan_frozen_retry_and_ack_preserves_newer_local_edit() {
        let (_dir, s, id, d) = fixture().await;
        let first = s.lan_prepare(&d).await.unwrap().remove(0);
        s.lan_edit_capture(&Uuid::new_v4().to_string(), &id, 0, "下一稿")
            .await
            .unwrap();
        let retry = s.lan_prepare(&d).await.unwrap().remove(0);
        assert_eq!(first.operation_id, retry.operation_id);
        assert_eq!(first.raw_text, retry.raw_text);
        s.lan_ack(&first, &remote(&id, 1, &first.raw_text))
            .await
            .unwrap();
        let next = s.lan_prepare(&d).await.unwrap().remove(0);
        assert_eq!(next.expected_version, Some(1));
        assert_eq!(next.raw_text, "下一稿");
        assert_ne!(first.operation_id, next.operation_id);
    }
    #[tokio::test]
    async fn lan_dirty_pull_keeps_both_and_cursor_survives_reopen() {
        let (dir, s, id, d) = fixture().await;
        let cmd = s.lan_prepare(&d).await.unwrap().remove(0);
        s.lan_ack(&cmd, &remote(&id, 1, &cmd.raw_text))
            .await
            .unwrap();
        s.lan_pull(
            &[LanChange {
                capture: remote(&id, 1, &cmd.raw_text),
                cursor: 1,
            }],
            1,
        )
        .await
        .unwrap();
        s.lan_edit_capture(&Uuid::new_v4().to_string(), &id, 0, "本机离线修改")
            .await
            .unwrap();
        s.lan_pull(
            &[LanChange {
                capture: remote(&id, 2, "手机修改"),
                cursor: 2,
            }],
            2,
        )
        .await
        .unwrap();
        assert!(s.lan_prepare(&d).await.unwrap().is_empty());
        let list = s.lan_conflicts().await.unwrap();
        assert_eq!(list[0]["localText"], "本机离线修改");
        assert_eq!(list[0]["remote"]["rawText"], "手机修改");
        drop(s);
        let s = Store::open(&dir.path().join("lan.sqlite")).await.unwrap();
        assert_eq!(s.lan_cursor().await.unwrap(), 2);
        assert_eq!(s.lan_status().await.unwrap()["conflictCount"], 1);
        let resolution_id = Uuid::new_v4().to_string();
        s.lan_resolve(&resolution_id, &id, 2, "本机离线修改", true)
            .await
            .unwrap();
        s.lan_resolve(&resolution_id, &id, 2, "本机离线修改", true)
            .await
            .unwrap();
        assert!(s
            .lan_resolve(&resolution_id, &id, 2, "本机离线修改", false)
            .await
            .is_err());
        let copied = s.lan_prepare(&d).await.unwrap();
        assert_eq!(copied.len(), 1);
        assert_ne!(copied[0].id, id);
        assert_eq!(copied[0].raw_text, "本机离线修改");
        let snapshot=s.content_snapshot().await.unwrap();let events=snapshot["events"].as_array().unwrap();
        let resolutions:Vec<_>=events.iter().filter(|e|e["kind"]=="capture_sync_resolved").collect();assert_eq!(resolutions.len(),1);
        assert_eq!(resolutions[0]["payload"]["copyId"],copied[0].id);
        assert_eq!(resolutions[0]["payload"]["before"]["rawText"],"本机离线修改");
        assert_eq!(resolutions[0]["payload"]["after"]["rawText"],"手机修改");
        assert!(events.iter().any(|e|e["kind"]=="capture_raw_edited"));
    }
    #[tokio::test]
    async fn lan_clean_pull_deletion_and_binding_are_safe() {
        let (_dir, s, id, d) = fixture().await;
        let cmd = s.lan_prepare(&d).await.unwrap().remove(0);
        s.lan_ack(&cmd, &remote(&id, 1, &cmd.raw_text))
            .await
            .unwrap();
        s.lan_pull(
            &[
                LanChange {
                    capture: remote(&id, 1, &cmd.raw_text),
                    cursor: 1,
                },
                LanChange {
                    capture: remote(&id, 2, "远端更新"),
                    cursor: 2,
                },
            ],
            2,
        )
        .await
        .unwrap();
        assert!(s.lan_prepare(&d).await.unwrap().is_empty());
        let mut tombstone = remote(&id, 3, "远端更新");
        tombstone.deleted = true;
        s.lan_pull(
            &[LanChange {
                capture: tombstone,
                cursor: 3,
            }],
            3,
        )
        .await
        .unwrap();
        assert!(s.content_snapshot().await.unwrap()["captures"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(s.lan_bind("https://elsewhere", "owner", &d).await.is_err());
        let snapshot=s.content_snapshot().await.unwrap();let events=snapshot["events"].as_array().unwrap();
        let received:Vec<_>=events.iter().filter(|e|e["kind"]=="capture_sync_received").collect();assert_eq!(received.len(),2);
        assert_eq!(received[0]["payload"]["before"]["rawText"],"远端更新");assert_eq!(received[0]["payload"]["after"]["deleted"],true);
    }
}

