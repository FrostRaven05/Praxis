use crate::lan_sync::{self, Pairing};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccount {
    pub base_url: String,
    pub user: User,
    pub expires_at: String,
}
pub struct Accounts {
    pub root: PathBuf,
    pub active: Option<ActiveAccount>,
    pub lock: tokio::sync::Mutex<()>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Login {
    pub mode: String,
    pub base_url: String,
    pub email: String,
    pub password: String,
    pub display_name: String,
    pub ca_pem: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    user: User,
    device_id: String,
    token: String,
    expires_at: String,
}
pub fn account_dir(root: &Path, account: &ActiveAccount) -> Result<PathBuf, String> {
    let id = Uuid::parse_str(&account.user.id).map_err(|_| "账号标识无效。")?;
    let key = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("{}:{}", account.base_url, id).as_bytes(),
    );
    Ok(root.join("accounts").join(key.to_string()))
}
pub fn selected(root: &Path) -> Result<Option<ActiveAccount>, String> {
    match std::fs::read(root.join("active-account.json")) {
        Ok(bytes) => {
            let account: ActiveAccount =
                serde_json::from_slice(&bytes).map_err(|_| "无法读取当前账号。")?;
            account_dir(root, &account)?;
            Ok(Some(account))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取当前账号。".into()),
    }
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无法保存账号。")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法保存账号。")?;
    let temp = parent.join(format!("account-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), std::io::Error> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
        return Err("无法保存账号。".into());
    }
    Ok(())
}
fn client(ca_pem: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15));
    if !ca_pem.is_empty() {
        builder = builder.tls_built_in_root_certs(false).add_root_certificate(
            reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|_| "服务证书无效。")?,
        );
    }
    builder.build().map_err(|_| "无法建立安全连接。".into())
}
#[tauri::command]
pub fn account_status(accounts: State<'_, Accounts>) -> serde_json::Value {
    let default_url = lan_sync::pairing(&accounts.root.join("lan-sync.dpapi"))
        .ok()
        .map(|p| p.base_url)
        .unwrap_or_default();
    serde_json::json!({ "user": accounts.active.as_ref().map(|a| &a.user), "baseUrl": accounts.active.as_ref().map(|a| a.base_url.as_str()).unwrap_or(&default_url), "expiresAt": accounts.active.as_ref().map(|a| &a.expires_at) })
}
#[tauri::command]
pub async fn account_authenticate(
    mut login: Login,
    accounts: State<'_, Accounts>,
) -> Result<(), String> {
    let _guard = accounts.lock.lock().await;
    if !["login", "register"].contains(&login.mode.as_str())
        || login.password.chars().count() < 6
        || login.password.chars().count() > 128
        || login.email.len() > 254
        || login.display_name.chars().count() > 60
        || login.ca_pem.len() > 65536
    {
        return Err("请填写有效账号信息；密码需为 6–128 个字符。".into());
    }
    let url = reqwest::Url::parse(login.base_url.trim()).map_err(|_| "请填写 HTTPS 服务地址。")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请填写有效的 HTTPS 服务地址。".into());
    }
    let base = url.as_str().trim_end_matches('/').to_string();
    if login.ca_pem.is_empty() {
        if let Ok(pair) = lan_sync::pairing(&accounts.root.join("lan-sync.dpapi")) {
            if pair.base_url.trim_end_matches('/') == base {
                login.ca_pem = pair.ca_pem;
            }
        }
        if let Some(active) = &accounts.active {
            if active.base_url == base {
                if let Ok(pair) =
                    lan_sync::pairing(&account_dir(&accounts.root, active)?.join("lan-sync.dpapi"))
                {
                    login.ca_pem = pair.ca_pem;
                }
            }
        }
    }
    let device_path = accounts.root.join("account-device.txt");
    let device_id = match std::fs::read_to_string(&device_path) {
        Ok(id) => Uuid::parse_str(&id)
            .map_err(|_| "设备标识无效。")?
            .to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = Uuid::new_v4().to_string();
            write_atomic(&device_path, id.as_bytes())?;
            id
        }
        Err(_) => return Err("无法读取设备标识。".into()),
    };
    let mut body = serde_json::json!({"email":login.email.trim(), "password":login.password, "deviceId":device_id});
    if login.mode == "register" {
        body["displayName"] = serde_json::json!(login.display_name.trim());
    }
    let response = client(&login.ca_pem)?
        .post(format!("{base}/auth/{}", login.mode))
        .json(&body)
        .send()
        .await;
    login.password.clear();
    body["password"] = serde_json::Value::Null;
    let response = response.map_err(|_| "无法连接账号服务，请检查网络、服务地址和证书。")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "邮箱或密码不正确。",
            409 => "该邮箱已注册，请登录。",
            429 => "尝试次数过多，请稍后重试。",
            400 => "账号信息无效，密码需为 6–128 个字符。",
            _ => "账号服务暂不可用，请稍后重试。",
        }
        .into());
    }
    let session: Session = response.json().await.map_err(|_| "账号服务响应无效。")?;
    if session.device_id != device_id || session.token.len() != 64 {
        return Err("账号会话无效。".into());
    }
    let active = ActiveAccount {
        base_url: base.clone(),
        user: session.user,
        expires_at: session.expires_at,
    };
    let directory = account_dir(&accounts.root, &active)?;
    let pair = Pairing {
        base_url: base,
        owner_id: active.user.id.clone(),
        device_id,
        token: session.token,
        ca_pem: login.ca_pem,
    };
    let mut plain = serde_json::to_vec(&pair).map_err(|_| "无法保存账号。")?;
    let encrypted = lan_sync::encrypt(&plain);
    plain.fill(0);
    write_atomic(&directory.join("lan-sync.dpapi"), &encrypted?)?;
    write_atomic(
        &accounts.root.join("active-account.json"),
        &serde_json::to_vec(&active).map_err(|_| "无法保存账号。")?,
    )?;
    Ok(())
}
#[tauri::command]
pub async fn account_logout(accounts: State<'_, Accounts>) -> Result<(), String> {
    let _guard = accounts.lock.lock().await;
    if let Some(active) = &accounts.active {
        let path = account_dir(&accounts.root, active)?.join("lan-sync.dpapi");
        if let Ok(pair) = lan_sync::pairing(&path) {
            if let Ok(client) = client(&pair.ca_pem) {
                let _ = client
                    .post(format!("{}/v1/account/logout", active.base_url))
                    .bearer_auth(&pair.token)
                    .send()
                    .await;
            }
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法清除本机登录凭据。".into()),
        }
    }
    match std::fs::remove_file(accounts.root.join("active-account.json")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法退出当前账号。".into()),
    }
}
#[tauri::command]
pub fn account_restart(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolates_users_and_servers_with_paths_inside_account_root() {
        let root = Path::new("test-root");
        let a = ActiveAccount {
            base_url: "https://one.example".into(),
            user: User {
                id: Uuid::new_v4().to_string(),
                email: "a@example.com".into(),
                display_name: "A".into(),
            },
            expires_at: "".into(),
        };
        let mut b = a.clone();
        b.user.id = Uuid::new_v4().to_string();
        assert_ne!(
            account_dir(root, &a).unwrap(),
            account_dir(root, &b).unwrap()
        );
        b = a.clone();
        b.base_url = "https://two.example".into();
        assert_ne!(
            account_dir(root, &a).unwrap(),
            account_dir(root, &b).unwrap()
        );
        assert!(account_dir(root, &a)
            .unwrap()
            .starts_with(root.join("accounts")));
        b.user.id = "../escape".into();
        assert!(account_dir(root, &b).is_err());
    }
}
