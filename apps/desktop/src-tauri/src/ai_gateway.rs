use crate::{
    accounts::{account_dir, Accounts},
    lan_sync,
};
use serde::Deserialize;
use tauri::State;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    method: String,
    path: String,
    body: Option<serde_json::Value>,
}
fn allowed(method: &str, path: &str) -> bool {
    if method == "GET" && path == "/v1/ai/status" || method == "POST" && path == "/v1/ai/runs" {
        return true;
    }
    if let Some(rest) = path.strip_prefix("/v1/ai/runs/") {
        if method == "GET" {
            return uuid::Uuid::parse_str(rest).is_ok() && rest.len() == 36;
        }
        if method == "POST" {
            return rest
                .strip_suffix("/cancel")
                .is_some_and(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok());
        }
    }
    false
}
#[tauri::command]
pub async fn ai_gateway_request(
    request: AiRequest,
    accounts: State<'_, Accounts>,
) -> Result<serde_json::Value, String> {
    if !allowed(&request.method, &request.path) || request.method == "GET" && request.body.is_some()
    {
        return Err("不支持的 AI 请求。".into());
    }
    let active = accounts
        .active
        .as_ref()
        .ok_or("请先登录账号，再使用 AI 规划。")?;
    let pair = lan_sync::pairing(&account_dir(&accounts.root, active)?.join("lan-sync.dpapi"))?;
    if pair.base_url.trim_end_matches('/') != active.base_url.trim_end_matches('/')
        || pair.owner_id != active.user.id
    {
        return Err("账号已变化，请重新打开应用。".into());
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(12));
    if !pair.ca_pem.is_empty() {
        builder = builder.tls_built_in_root_certs(false).add_root_certificate(
            reqwest::Certificate::from_pem(pair.ca_pem.as_bytes()).map_err(|_| "服务证书无效。")?,
        );
    }
    let client = builder.build().map_err(|_| "无法建立 AI 服务连接。")?;
    let url = format!("{}{}", active.base_url.trim_end_matches('/'), request.path);
    let mut call = if request.method == "POST" {
        client.post(url)
    } else {
        client.get(url)
    };
    call = call.bearer_auth(&pair.token);
    if request.method == "POST" {
        let body = request.body.unwrap_or_else(|| serde_json::json!({}));
        if serde_json::to_vec(&body)
            .map_err(|_| "AI 请求无效。")?
            .len()
            > 131072
        {
            return Err("本次资料过多，请缩小范围。".into());
        }
        call = call.json(&body);
    }
    let mut response = call
        .send()
        .await
        .map_err(|_| "无法确认 AI 请求结果，请检查网络后恢复。")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 AI 服务结果失败，请恢复重试。")?
    {
        if bytes.len() + chunk.len() > 1048576 {
            return Err("AI 服务结果过大。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "AI 服务响应无效，请确认服务已升级。")?;
    Ok(serde_json::json!({"status":status,"body":body}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_planner_routes_are_allowed() {
        let id = "00000000-0000-4000-8000-000000000001";
        assert!(allowed("GET", "/v1/ai/status"));
        assert!(allowed("POST", "/v1/ai/runs"));
        assert!(allowed("GET", &format!("/v1/ai/runs/{id}")));
        assert!(allowed("POST", &format!("/v1/ai/runs/{id}/cancel")));
        for path in [
            "/v1/account/logout",
            "/admin",
            "/v1/ai/runs/../account",
            "/v1/ai/runs?url=https://example.com",
        ] {
            assert!(!allowed("POST", path));
        }
    }
}
