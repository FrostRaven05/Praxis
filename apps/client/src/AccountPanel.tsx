import { useEffect, useId, useRef, useState } from "react";
import {
  accountAvailable,
  accountStorage,
  type AccountStatus,
} from "./account-storage";
import "./account.css";

export function AccountButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  useEffect(() => {
    let active = true;
    const read = () =>
      void accountStorage
        .status()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {});
    read();
    window.addEventListener("focus", read);
    return () => {
      active = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return (
    <button
      className="sidebar-account"
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`账号：${status?.user?.displayName || "未登录"}`}
    >
      <span className="account-avatar" aria-hidden="true">
        {status?.user ? (
          Array.from(status.user.displayName)[0]
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
          </svg>
        )}
      </span>
      <span className="account-button-text">
        <strong>{status?.user?.displayName || "未登录"}</strong>
        <small>{status?.user?.email || "登录以同步"}</small>
      </span>
      <svg
        className="account-button-arrow"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="m8 5 5 5-5 5" />
      </svg>
    </button>
  );
}

export function AccountPanel({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={`settings-card account-panel${compact ? " pm-profile" : ""}`}
      aria-label="用户账号"
    >
      <AccountButton
        onClick={() => window.dispatchEvent(new Event("praxis-open-account"))}
      />
    </section>
  );
}

export function AccountPage({ onBack }: { onBack: () => void }) {
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
  const [showPassword, setShowPassword] = useState(false);
  const saving = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const id = useId();
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
  useEffect(() => {
    if (
      status &&
      (!status.user ||
        (status.expiresAt && Date.parse(status.expiresAt) <= Date.now()))
    ) {
      emailInput.current?.focus();
    }
  }, [status]);
  useEffect(() => {
    const back = () => {
      if (!saving.current && !switching) onBack();
    };
    window.addEventListener("praxis-account-back", back);
    return () => window.removeEventListener("praxis-account-back", back);
  }, [onBack, switching]);
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
  function switchMode() {
    setMode(mode === "login" ? "register" : "login");
    setPassword("");
    setShowPassword(false);
    setError("");
  }
  const expired = status?.expiresAt
    ? Date.parse(status.expiresAt) <= Date.now()
    : false;
  const signedIn = !!status?.user && !expired;
  const unavailable = busy || switching || !status || !accountAvailable;
  const errorMessage = error && (
    <p className="account-error" role="alert">
      {error}
      {!status && (
        <button type="button" onClick={() => void read()}>
          重新读取
        </button>
      )}
    </p>
  );
  return (
    <main
      className="account-page"
      aria-label={signedIn ? "我的账号" : "账号登录页"}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !saving.current && !switching) onBack();
      }}
    >
      <button
        type="button"
        className="account-page-back"
        disabled={busy || switching}
        onClick={onBack}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M16 10H4m5-5-5 5 5 5" />
        </svg>
        返回应用
      </button>
      <section
        className="account-auth-card"
        aria-labelledby={`${id}-auth-heading`}
      >
        <header className="account-login-heading">
          <span className="account-brand" aria-hidden="true">
            P
          </span>
          <h2 id={`${id}-auth-heading`}>
            {signedIn ? "我的账号" : mode === "login" ? "登录账号" : "创建账号"}
          </h2>
          <p>
            {signedIn ? "管理你的个人账号" : "同步你的项目、任务与每一步进展"}
          </p>
        </header>
        {signedIn ? (
          <div className="account-profile-details">
            <strong>{status!.user!.displayName}</strong>
            <span>{status!.user!.email}</span>
            <p>支持离线使用，联网后自动同步。</p>
            <button
              type="button"
              className="account-profile-logout"
              disabled={unavailable}
              onClick={() => void run(accountStorage.logout)}
            >
              退出登录
            </button>
            <p className="account-note">
              退出后返回本机工作空间，账号内的内容会保留。
            </p>
            {errorMessage}
          </div>
        ) : (
          <>
            {expired && (
              <p className="account-note">
                登录已到期，本机数据仍可使用。请重新登录继续同步。
              </p>
            )}
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
              <fieldset disabled={unavailable}>
                {mode === "register" && (
                  <label>
                    昵称
                    <input
                      aria-label="昵称"
                      required
                      maxLength={60}
                      placeholder="怎么称呼你"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="nickname"
                    />
                  </label>
                )}
                <label>
                  邮箱
                  <input
                    ref={emailInput}
                    aria-label="邮箱"
                    autoFocus
                    type="email"
                    inputMode="email"
                    required
                    maxLength={254}
                    placeholder="请输入邮箱"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label htmlFor={`${id}-password`}>密码</label>
                <div className="account-password-field">
                  <input
                    id={`${id}-password`}
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={6}
                    maxLength={128}
                    placeholder={
                      mode === "register"
                        ? "设置密码（6–128 个字符）"
                        : "请输入密码"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={
                      mode === "register" ? "new-password" : "current-password"
                    }
                  />
                  <button
                    className="account-password-toggle"
                    type="button"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      aria-hidden="true"
                    >
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                      <circle cx="12" cy="12" r="3" />
                      {showPassword && <path d="m3 3 18 18" />}
                    </svg>
                  </button>
                </div>
                <button className="account-submit" type="submit">
                  {switching
                    ? "正在打开工作空间…"
                    : busy
                      ? "正在连接…"
                      : mode === "register"
                        ? "注册并登录"
                        : "登录账号"}
                </button>
                <p className="account-mode-switch">
                  {mode === "login" ? "还没有账号？" : "已有账号？"}
                  <button
                    type="button"
                    className="account-text-button"
                    onClick={switchMode}
                  >
                    {mode === "login" ? "注册账号" : "返回登录"}
                  </button>
                </p>
                <details className="account-connection">
                  <summary>高级连接设置</summary>
                  <label>
                    账号服务地址
                    <input
                      aria-label="账号服务地址"
                      type="url"
                      required
                      placeholder="https://你的服务地址"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      autoComplete="url"
                    />
                  </label>
                  <label>
                    服务证书（可选）
                    <textarea
                      aria-label="服务证书（可选）"
                      value={caPem}
                      maxLength={65536}
                      onChange={(e) => setCaPem(e.target.value)}
                      placeholder="局域网自签名服务可填入 PEM 证书"
                    />
                  </label>
                  <p className="account-note">
                    已配对的服务会沿用已保存的证书。
                  </p>
                </details>
              </fieldset>
            </form>
            {errorMessage}
            <p className="account-privacy-note">
              本机已有内容独立保留，登录后进入账号工作空间。
            </p>
          </>
        )}
        {!accountAvailable && (
          <p className="account-note">请在桌面或 Android 应用中登录账号。</p>
        )}
        {switching && (
          <div className="account-switching" role="status">
            <p>已保存账号状态，正在重新打开工作空间…</p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void accountStorage.restart().catch((e) => setError(String(e)))
              }
            >
              重新打开
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
