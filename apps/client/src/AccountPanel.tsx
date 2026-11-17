import { useEffect, useId, useRef, useState } from "react";
import {
  accountAvailable,
  accountStorage,
  type AccountStatus,
} from "./account-storage";
import { ThemeSettings } from "./ThemeSettings";
import { ProjectIcon } from "./ProjectIcon";
import { useProjectList } from "./useProjectList";
import { AppUpdate } from "./AppUpdate";
import "./account.css";

export type SettingsSection = "account" | "appearance" | "general";

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
      <span className="account-button-text">
        <strong>{status?.user?.displayName || "未登录"}</strong>
      </span>
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

export function AccountPage({
  onBack,
  initialSection = "account",
  revision = 0,
  onOpenProject,
  modal = false,
}: {
  onBack: () => void;
  initialSection?: SettingsSection;
  revision?: number;
  onOpenProject?: (id: string) => void;
  modal?: boolean;
}) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [caPem, setCaPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const saving = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const projects = useProjectList(revision);
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
      if (!saving.current && !switching && !passwordBusy) onBack();
    };
    window.addEventListener("praxis-account-back", back);
    return () => window.removeEventListener("praxis-account-back", back);
  }, [onBack, switching, passwordBusy]);
  useEffect(() => {
    if (!modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving.current || switching || passwordBusy)
        return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, onBack, switching, passwordBusy]);
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
  async function changePassword(event: { preventDefault(): void }) {
    event.preventDefault();
    if (passwordBusy || nextPassword !== confirmPassword) {
      if (nextPassword !== confirmPassword)
        setPasswordError("两次输入的新密码不一致。");
      return;
    }
    setPasswordBusy(true);
    setPasswordError("");
    setPasswordNotice("");
    try {
      await accountStorage.changePassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setPasswordOpen(false);
      setPasswordNotice(
        "密码已更改。这台设备保持登录，其他设备需要重新登录。",
      );
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : String(e));
    } finally {
      setPasswordBusy(false);
    }
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
  const archived = projects.items.filter(
    (project) => project.status === "archived" || !!project.archivedAt,
  );
  const nav = [
    ["account", "账户与安全"],
    ["appearance", "外观"],
    ["general", "通用"],
  ] as const;
  const shell = (
    <main
      className="settings-shell"
      aria-label="设置"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !saving.current && !switching && !passwordBusy)
          onBack();
      }}
    >
      <header className="settings-shell-bar">
        <h1>设置</h1>
        <button
          type="button"
          className="settings-shell-close"
          aria-label="关闭设置"
          disabled={busy || switching || passwordBusy}
          onClick={onBack}
        >
          ×
        </button>
      </header>
      <div className="settings-shell-body">
        <nav className="settings-shell-nav" aria-label="设置分类">
          {nav.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-current={section === key ? "page" : undefined}
              onClick={() => setSection(key)}
            >
              <SettingsNavIcon name={key} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-shell-main">
      {section === "account" && (
      <section aria-labelledby={`${id}-auth-heading`}>
        <header className="settings-pane-heading">
          <h2 id={`${id}-auth-heading`}>账户与安全</h2>
        </header>
        {signedIn ? (
          <>
            <h3 className="settings-group-title">个人资料</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <span>昵称</span>
                <strong>{status!.user!.displayName}</strong>
              </div>
              <div className="settings-row">
                <span>账号</span>
                <strong>{status!.user!.email}</strong>
              </div>
            </div>
            <h3 className="settings-group-title">登录与安全</h3>
            <div className="settings-rows">
              <button
                type="button"
                className="settings-row"
                aria-expanded={passwordOpen}
                disabled={unavailable || passwordBusy}
                onClick={() => {
                  setPasswordOpen(!passwordOpen);
                  setPasswordError("");
                }}
              >
                <span>密码</span>
                <span className="settings-row-action">
                  更改登录密码
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </span>
              </button>
              {passwordOpen && (
                <form
                  className="settings-password-form settings-auth"
                  onSubmit={(event) => void changePassword(event)}
                >
                  <label>
                    当前密码
                    <input
                      type="password"
                      required
                      minLength={6}
                      maxLength={128}
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    新密码
                    <input
                      type="password"
                      required
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      placeholder="6–128 个字符"
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    再次输入新密码
                    <input
                      type="password"
                      required
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                    />
                  </label>
                  <div className="settings-password-actions">
                    <button className="account-submit" type="submit" disabled={passwordBusy}>
                      {passwordBusy ? "正在保存…" : "保存密码"}
                    </button>
                    <button
                      type="button"
                      className="settings-row-button"
                      disabled={passwordBusy}
                      onClick={() => setPasswordOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
              <button
                type="button"
                className="settings-row"
                disabled={unavailable || passwordBusy}
                onClick={() => void run(accountStorage.logout)}
              >
                <span>退出登录</span>
              </button>
            </div>
            {passwordNotice && (
              <p className="account-note settings-password-note">{passwordNotice}</p>
            )}
            {passwordError && (
              <p className="account-error" role="alert">
                {passwordError}
              </p>
            )}
            {errorMessage}
          </>
        ) : (
          <>
            {expired && (
              <p className="account-note">
                登录已到期，本机数据仍可使用。请重新登录继续同步。
              </p>
            )}
            <div className="settings-auth">
            <form
              aria-label="用户登录"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  accountStorage.authenticate({
                    mode: "login",
                    baseUrl,
                    email,
                    password,
                    displayName: "",
                    caPem,
                  }),
                );
              }}
            >
              <fieldset disabled={unavailable}>
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
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
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
                      : "登录账号"}
                </button>
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
                      placeholder=""
                    />
                  </label>
                </details>
              </fieldset>
            </form>
            {errorMessage}
            </div>
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
      )}
      {section === "appearance" && (
        <section aria-labelledby={`${id}-theme-heading`}>
          <header className="settings-pane-heading">
            <h2 id={`${id}-theme-heading`}>外观</h2>
          </header>
          <ThemeSettings />
        </section>
      )}
      {section === "general" && (
        <section aria-labelledby={`${id}-general-heading`}>
          <header className="settings-pane-heading">
            <h2 id={`${id}-general-heading`}>通用</h2>
          </header>
          <AppUpdate />
          <h3 className="settings-group-title">归档项目</h3>
          {projects.error ? (
            <p className="account-error" role="alert">
              {projects.error}{" "}
              <button type="button" onClick={projects.reload}>重试</button>
            </p>
          ) : projects.loading ? (
            <p className="account-note" role="status">正在读取归档项目…</p>
          ) : archived.length === 0 ? (
            <p className="account-note">暂无归档项目。</p>
          ) : (
            <div className="settings-rows">
              {archived.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="settings-row"
                  onClick={() => onOpenProject?.(project.id)}
                >
                  <span className="settings-row-label">
                    <ProjectIcon name="folder" />
                    {project.name}
                  </span>
                  <small>{project.outcome || "未填写预期结果"}</small>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
        </div>
      </div>
    </main>
  );
  if (!modal) return shell;
  return (
    <div
      className="settings-dialog-layer"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !saving.current &&
          !switching &&
          !passwordBusy
        )
          onBack();
      }}
    >
      {shell}
    </div>
  );
}

function SettingsNavIcon({ name }: { name: SettingsSection }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    "aria-hidden": true as const,
  };
  if (name === "appearance")
    return (
      <svg {...common}>
        <path d="M4 14a8 8 0 0 1 14-5l2 2-3 1 1 3-2 2-3-1-2 2-2-2-3 1 1-3-3-1 2-2" />
      </svg>
    );
  if (name === "general")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M12 3 5 6v6c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6Z" />
    </svg>
  );
}
