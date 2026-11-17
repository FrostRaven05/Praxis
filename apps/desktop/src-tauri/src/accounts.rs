use crate::lan_sync::{self, Pairing};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

const DEFAULT_ACCOUNT_BASE_URL: &str = "https://todo.frostraven05.com";

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
    serde_json::json!({ "user": accounts.active.as_ref().map(|a| &a.user), "baseUrl": accounts.active.as_ref().map(|a| a.base_url.as_str()).unwrap_or(DEFAULT_ACCOUNT_BASE_URL), "expiresAt": accounts.active.as_ref().map(|a| &a.expires_at) })
}
#[tauri::command]
pub async fn account_authenticate(
    mut login: Login,
    accounts: State<'_, Accounts>,
) -> Result<(), String> {
    let _guard = accounts.lock.lock().await;
    if login.mode == "register" {
        return Err("注册已关闭，请使用已有账号登录。".into());
    }
    if login.mode != "login"
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
            403 => "注册已关闭，请使用已有账号登录。",
            409 => "该邮箱已注册，请登录。",
            429 => "尝试次数过多，请稍后重试。",
            400 => "账号信息无效，密码需为 6-128 个字符。",
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordChange {
    pub current_password: String,
    pub new_password: String,
}
fn endpoint(accounts: &Accounts) -> Result<(String, String), String> {
    let Some(active) = &accounts.active else {
        return Ok((DEFAULT_ACCOUNT_BASE_URL.to_string(), String::new()));
    };
    let pair = lan_sync::pairing(&account_dir(&accounts.root, active)?.join("lan-sync.dpapi"))?;
    Ok((active.base_url.clone(), pair.ca_pem))
}
fn semver_ok(value: &str) -> bool {
    let mut parts = value.split('.');
    (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
    }) && parts.next().is_none()
}
fn release_asset(value: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(asset) = value else {
        return serde_json::Value::Null;
    };
    let Some(url) = asset.get("url").and_then(|item| item.as_str()) else {
        return serde_json::Value::Null;
    };
    let Some(sha256) = asset.get("sha256").and_then(|item| item.as_str()) else {
        return serde_json::Value::Null;
    };
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return serde_json::Value::Null;
    };
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || sha256.len() != 64
        || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return serde_json::Value::Null;
    }
    serde_json::json!({ "url": parsed.as_str(), "sha256": sha256 })
}
fn same_host(base: &str, url: &str) -> Result<String, String> {
    let origin = reqwest::Url::parse(base).map_err(|_| "下载地址无效。")?;
    let target = reqwest::Url::parse(url).map_err(|_| "下载地址无效。")?;
    if target.scheme() != "https"
        || target.host_str().is_none()
        || target.host_str() != origin.host_str()
        || target.port_or_known_default() != origin.port_or_known_default()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("下载地址无效。".into());
    }
    Ok(target.to_string())
}
fn open_download(url: &str) -> Result<(), String> {
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    } else {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开下载页面。".into())
}
#[tauri::command]
pub async fn account_change_password(
    mut change: PasswordChange,
    accounts: State<'_, Accounts>,
) -> Result<(), String> {
    let _guard = accounts.lock.lock().await;
    let Some(active) = accounts.active.clone() else {
        return Err("请先登录。".into());
    };
    let current_len = change.current_password.chars().count();
    let new_len = change.new_password.chars().count();
    if !(6..=128).contains(&current_len) || !(6..=128).contains(&new_len) {
        return Err("密码需为 6–128 个字符。".into());
    }
    if change.current_password == change.new_password {
        return Err("新密码不能与当前密码相同。".into());
    }
    let (base, ca_pem) = endpoint(&accounts)?;
    let pair = lan_sync::pairing(&account_dir(&accounts.root, &active)?.join("lan-sync.dpapi"))?;
    let mut body = serde_json::json!({
        "currentPassword": change.current_password,
        "newPassword": change.new_password,
    });
    let response = client(&ca_pem)?
        .post(format!("{base}/v1/account/password"))
        .bearer_auth(&pair.token)
        .json(&body)
        .send()
        .await;
    change.current_password.clear();
    change.new_password.clear();
    body["currentPassword"] = serde_json::Value::Null;
    body["newPassword"] = serde_json::Value::Null;
    let response = response.map_err(|_| "无法连接账号服务，请检查网络。")?;
    if response.status().is_success() {
        return Ok(());
    }
    let code = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|value| value.get("error").and_then(|item| item.as_str()).map(str::to_string))
        .unwrap_or_default();
    Err(match code.as_str() {
        "INVALID_CREDENTIALS" => "当前密码不正确，或登录已失效。",
        "PASSWORD_UNCHANGED" => "新密码不能与当前密码相同。",
        "ACCOUNT_DISABLED" => "账号已停用。",
        "RATE_LIMITED" => "尝试次数过多，请稍后重试。",
        _ => "暂时无法修改密码。",
    }
    .into())
}
#[tauri::command]
pub async fn app_release_check(
    app: tauri::AppHandle,
    accounts: State<'_, Accounts>,
) -> Result<serde_json::Value, String> {
    let _guard = accounts.lock.lock().await;
    let current = app.package_info().version.to_string();
    let (base, ca_pem) = endpoint(&accounts)?;
    let response = client(&ca_pem)?
        .get(format!("{base}/app/release"))
        .send()
        .await
        .map_err(|_| "暂时无法检查更新。")?;
    if response.status().as_u16() == 404 {
        return Ok(serde_json::json!({ "current": current, "release": null }));
    }
    if !response.status().is_success() {
        return Err("暂时无法检查更新。".into());
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "更新信息无效。")?;
    let version = body.get("version").and_then(|item| item.as_str()).unwrap_or("");
    let minimum = body
        .get("minimumVersion")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let notes = body.get("notes").and_then(|item| item.as_str()).unwrap_or("");
    if !semver_ok(version) || !semver_ok(minimum) || notes.chars().count() > 4000 {
        return Err("更新信息无效。".into());
    }
    Ok(serde_json::json!({
        "current": current,
        "release": {
            "version": version,
            "notes": notes,
            "publishedAt": body.get("publishedAt").and_then(|item| item.as_str()),
            "minimumVersion": minimum,
            "windows": release_asset(body.get("windows")),
            "android": release_asset(body.get("android")),
        }
    }))
}
#[tauri::command]
pub async fn app_release_open(accounts: State<'_, Accounts>, url: String) -> Result<(), String> {
    let _guard = accounts.lock.lock().await;
    let (base, _) = endpoint(&accounts)?;
    let target = same_host(&base, &url)?;
    open_download(&target)
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
