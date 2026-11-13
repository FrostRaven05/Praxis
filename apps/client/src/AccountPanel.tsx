import { useEffect, useRef, useState } from "react";
import {
  accountAvailable,
  accountStorage,
  type AccountStatus,
} from "./account-storage";
import "./account.css";

export function AccountPanel({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [caPem, setCaPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  async function read() {
    try {
      const next = await accountStorage.status();
      setStatus(next);
      setBaseUrl(next.baseUrl);
      setEmail(next.user?.email ?? "");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void read();
  }, []);
  async function run(action: () => Promise<void>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      setPassword("");
      setSwitching(true);
      await accountStorage.restart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const expired = status?.expiresAt
    ? Date.parse(status.expiresAt) <= Date.now()
    : false;
  const accountContent = (
    <>
      {status?.user && (
        <div className="account-current">
          <strong>{status.user.displayName}</strong>
          <span>{status.user.email}</span>
          <p>
            {expired
              ? "登录已到期，本机数据仍可使用。请重新登录继续同步。"
              : "已登录 · 可离线使用，联网后自动同步"}
          </p>
          <button
            type="button"
            disabled={busy || switching}
            onClick={() => void run(accountStorage.logout)}
          >
            退出登录
          </button>
          <p className="account-note">
            退出后返回本机工作空间。再次登录即可继续使用该账号的数据。
          </p>
        </div>
      )}
      {(!status?.user || expired) && (
        <form
          aria-label="用户登录与注册"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              accountStorage.authenticate({
                mode,
                baseUrl,
                email,
                password,
                displayName,
                caPem,
              }),
            );
          }}
        >
          <fieldset
            disabled={busy || switching || !status || !accountAvailable}
          >
            {!status?.user && (
              <div className="account-tabs">
                <button
                  type="button"
                  aria-pressed={mode === "login"}
                  onClick={() => {
                    setMode("login");
                    setPassword("");
                    setError("");
                  }}
                >
                  登录
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "register"}
                  onClick={() => {
                    setMode("register");
                    setPassword("");
                    setError("");
                  }}
                >
                  注册账号
                </button>
              </div>
            )}
            <label>
              账号服务地址
              <input
                type="url"
                required
                placeholder="https://你的服务地址"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="url"
              />
            </label>
            {mode === "register" && (
              <label>
                昵称
                <input
                  required
                  maxLength={60}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
            )}
            <label>
              邮箱
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                required
                minLength={6}
                maxLength={128}
                placeholder="6–128 个字符"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
              />
            </label>
            <details>
              <summary>连接设置</summary>
              <label>
                服务证书（可选）
                <textarea
                  value={caPem}
                  maxLength={65536}
                  onChange={(e) => setCaPem(e.target.value)}
                  placeholder="局域网自签名服务可填入 PEM 证书"
                />
              </label>
              <p className="account-note">
                已配对的局域网服务会沿用已保存的证书。
              </p>
            </details>
            <p className="account-note">
              {mode === "register" ? "注册" : "登录"}
              成功后应用会重新打开个人工作空间。本机已有内容保留在原工作空间。
            </p>
            <button type="submit">
              {busy
                ? "正在连接…"
                : mode === "register"
                  ? "注册并登录"
                  : "登录账号"}
            </button>
          </fieldset>
        </form>
      )}
      {!accountAvailable && (
        <p className="account-note">请在桌面或 Android 应用中登录账号。</p>
      )}
      {switching && (
        <div role="status">
          <p>已保存账号状态，正在重新打开工作空间…</p>
          <button
            disabled={busy}
            onClick={() =>
              void accountStorage.restart().catch((e) => setError(String(e)))
            }
          >
            重新打开
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
          {!status && <button onClick={() => void read()}>重新读取</button>}
        </p>
      )}
    </>
  );
  return (
    <section
      className={`settings-card account-panel${compact ? " pm-profile" : ""}`}
      aria-labelledby="account-heading"
    >
      <header className="settings-card-heading">
        <span className="account-avatar" aria-hidden="true">
          {Array.from(status?.user?.displayName || "我")[0]}
        </span>
        <div>
          <h2 id="account-heading">
            {compact ? status?.user?.displayName || "我的账户" : "用户账号"}
          </h2>
          <p>
            {compact
              ? status?.user?.email || "登录账户，连接你的个人工作空间"
              : "登录后同步个人工作空间，各账号的数据独立保存。"}
          </p>
        </div>
      </header>
      {compact ? (
        <details className="pm-profile-controls">
          <summary>账户与登录设置</summary>
          {accountContent}
        </details>
      ) : (
        accountContent
      )}
    </section>
  );
}
