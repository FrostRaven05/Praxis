//! Native-only credentials and TLS. No token is returned through Tauri commands/events.
use crate::{
    store::lan::{LanCapture, LanChange},
    LocalDatabase,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{Emitter, Manager};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pairing {
    base_url: String,
    owner_id: String,
    device_id: String,
    token: String,
    ca_pem: String,
}
#[cfg(windows)]
fn decrypt(bytes: &mut [u8]) -> Result<Vec<u8>, String> {
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let input = Blob {
        len: bytes.len() as u32,
        data: bytes.as_mut_ptr(),
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // DPAPI CurrentUser binding means another Windows identity cannot decrypt this pairing.
    unsafe {
        if CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            &mut output,
        ) == 0
        {
            return Err("无法解密配对，请使用当前 Windows 用户重新配对".into());
        }
        let result = std::slice::from_raw_parts(output.data, output.len as usize).to_vec();
        LocalFree(output.data.cast());
        Ok(result)
    }
}
#[cfg(not(windows))]
fn decrypt(_: &mut [u8]) -> Result<Vec<u8>, String> {
    Err("此配对方式仅支持 Windows".into())
}
fn pairing(path: &Path) -> Result<Pairing, String> {
    let mut encrypted = std::fs::read(path).map_err(|_| "尚未配置局域网同步")?;
    if encrypted.len() > 100000 {
        return Err("配对文件无效".into());
    }
    let mut plain = decrypt(&mut encrypted)?;
    let result: Result<Pairing, _> = serde_json::from_slice(&plain);
    plain.fill(0);
    let config = result.map_err(|_| "配对文件无效")?;
    let url = reqwest::Url::parse(&config.base_url).map_err(|_| "服务地址无效")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || config.token.len() < 20
    {
        return Err("需使用可信 HTTPS 服务配对".into());
    }
    uuid::Uuid::parse_str(&config.device_id).map_err(|_| "设备标识无效")?;
    Ok(config)
}
#[derive(Deserialize)]
struct Receipt {
    capture: LanCapture,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    changes: Vec<LanChange>,
    cursor: i64,
    has_more: bool,
}
async fn decode<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "无法完整读取响应")? {
        if body.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("同步响应过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "同步响应无效".into())
}
async fn cycle(db: &LocalDatabase, path: &Path) -> Result<Value, String> {
    let p = pairing(path)?;
    let store = db.get(None).await?;
    let base = p.base_url.trim_end_matches('/');
    store.lan_bind(base, &p.owner_id, &p.device_id).await?;
    let cert = reqwest::Certificate::from_pem(p.ca_pem.as_bytes()).map_err(|_| "CA 证书无效")?;
    let client = reqwest::Client::builder()
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "无法初始化安全连接")?;
    for command in store.lan_prepare(&p.device_id).await? {
        let response = client
            .post(format!("{base}/v1/captures/commands"))
            .bearer_auth(&p.token)
            .json(&command)
            .send()
            .await
            .map_err(|_| "离线或证书验证失败；本机内容已保留")?;
        if response.status().as_u16() == 409 {
            store.lan_conflict(&command.id).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err("同步服务拒绝请求；请检查配对或稍后重试".into());
        }
        let receipt: Receipt = decode(response)
            .await
            .map_err(|_| "同步回执无效；将重试原操作")?;
        store.lan_ack(&command, &receipt.capture).await?;
    }
    for _ in 0..20 {
        let cursor = store.lan_cursor().await?;
        let response = client
            .get(format!("{base}/v1/captures/changes"))
            .bearer_auth(&p.token)
            .query(&[("after", cursor), ("limit", 25)])
            .send()
            .await
            .map_err(|_| "离线或证书验证失败；本机内容已保留")?;
        if !response.status().is_success() {
            return Err("无法拉取同步变更；本机内容已保留".into());
        }
        let feed: Feed = decode(response).await?;
        store.lan_pull(&feed.changes, feed.cursor).await?;
        if !feed.has_more {
            break;
        }
    }
    let mut state = store.lan_status().await?;
    state["state"] = json!("online");
    Ok(state)
}
pub struct LanRuntime {
    pub status: tokio::sync::RwLock<Value>,
}
pub fn start(app: tauri::AppHandle, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        loop {
            let db = app.state::<LocalDatabase>();
            let status = match cycle(&db, &path).await {
                Ok(s) => s,
                Err(message) => {
                    let mut s = match db.get(None).await {
                        Ok(store) => store.lan_status().await.unwrap_or(json!({})),
                        Err(_) => json!({}),
                    };
                    s["state"] = json!(if path.exists() { "offline" } else { "unpaired" });
                    s["message"] = json!(message);
                    s
                }
            };
            *app.state::<LanRuntime>().status.write().await = status.clone();
            let _ = app.emit("praxis-lan-sync", status);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}
