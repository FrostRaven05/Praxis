import { useEffect, useId, useRef, useState } from "react";
import {
  accountAvailable,
  accountStorage,
  type AccountStatus,
} from "./account-storage";
import { ThemeSettings } from "./ThemeSettings";
import { ProjectIcon } from "./ProjectIcon";
import { useProjectList } from "./useProjectList";
import {
  clampPomodoroMinutes,
  readPomodoroState,
  setPomodoroDuration,
  stopPomodoro,
  writePomodoroState,
  type PomodoroMode,
  type PomodoroState,
} from "./pomodoro";
import "./account.css";

export type SettingsSection = "account" | "pomodoro" | "appearance" | "general";

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

export function AccountPage({
  onBack,
  initialSection = "account",
  revision = 0,
  onOpenProject,
}: {
  onBack: () => void;
  initialSection?: SettingsSection;
  revision?: number;
  onOpenProject?: (id: string) => void;
}) {
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
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [pomodoro, setPomodoro] = useState<PomodoroState>(() => readPomodoroState());
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
  function publishPomodoro(next: PomodoroState) {
    setPomodoro(next);
    writePomodoroState(next);
  }
  function togglePomodoro() {
    const current = readPomodoroState();
    publishPomodoro(
      current.enabled
        ? { ...stopPomodoro(current), enabled: false }
        : { ...current, enabled: true },
    );
  }
  function changeMinutes(mode: PomodoroMode, raw: string) {
    const minutes = clampPomodoroMinutes(Number(raw));
    publishPomodoro(setPomodoroDuration(readPomodoroState(), mode, minutes));
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
    ["pomodoro", "番茄"],
    ["appearance", "外观"],
    ["general", "通用"],
  ] as const;
  return (
    <main
      className="settings-shell"
      aria-label="设置"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !saving.current && !switching) onBack();
      }}
    >
      <header className="settings-shell-bar">
        <h1>设置</h1>
        <button
          type="button"
          className="settings-shell-close"
          aria-label="关闭设置"
          disabled={busy || switching}
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
          <p>
            {signedIn
              ? "管理个人资料与登录。"
              : mode === "login"
                ? "登录后同步项目、任务与每一步进展。"
                : "创建账号并登录。"}
          </p>
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
                disabled={unavailable}
                onClick={() => void run(accountStorage.logout)}
              >
                <span>退出登录</span>
                <small>返回本机</small>
              </button>
            </div>
            <p className="account-note">
              支持离线使用，联网后自动同步。退出后账号内的内容会保留。
            </p>
            {errorMessage}
          </>
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
      )}
      {section === "pomodoro" && (
        <section aria-labelledby={`${id}-pomodoro-heading`}>
          <header className="settings-pane-heading">
            <h2 id={`${id}-pomodoro-heading`}>番茄</h2>
            <p>安排专注与休息时间。</p>
          </header>
          <h3 className="settings-group-title">专注计时</h3>
          <div className="settings-rows">
            <div className="settings-row">
              <span>番茄功能开关</span>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={pomodoro.enabled}
                onClick={togglePomodoro}
              >
                <span />
              </button>
            </div>
            <label className="settings-row">
              <span>番茄时长</span>
              <span className="settings-minutes">
                <input
                  type="number"
                  min={1}
                  max={180}
                  aria-label="番茄时长"
                  disabled={!pomodoro.enabled}
                  value={pomodoro.durations.focus}
                  onChange={(event) => changeMinutes("focus", event.target.value)}
                />
                分钟
              </span>
            </label>
            <label className="settings-row">
              <span>休息时长</span>
              <span className="settings-minutes">
                <input
                  type="number"
                  min={1}
                  max={180}
                  aria-label="休息时长"
                  disabled={!pomodoro.enabled}
                  value={pomodoro.durations.short}
                  onChange={(event) => changeMinutes("short", event.target.value)}
                />
                分钟
              </span>
            </label>
          </div>
        </section>
      )}
      {section === "appearance" && (
        <section aria-labelledby={`${id}-theme-heading`}>
          <header className="settings-pane-heading">
            <h2 id={`${id}-theme-heading`}>外观</h2>
            <p>选择强调色，背景与正文保持不变。</p>
          </header>
          <ThemeSettings />
        </section>
      )}
      {section === "general" && (
        <section aria-labelledby={`${id}-general-heading`}>
          <header className="settings-pane-heading">
            <h2 id={`${id}-general-heading`}>通用</h2>
            <p>已归档的项目保存在这里。</p>
          </header>
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
}

function SettingsNavIcon({ name }: { name: SettingsSection }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    "aria-hidden": true as const,
  };
  if (name === "pomodoro")
    return (
      <svg {...common}>
        <circle cx="12" cy="13" r="7" />
        <path d="M12 13V9M9 3h6" />
      </svg>
    );
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
