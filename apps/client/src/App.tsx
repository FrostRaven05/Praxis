import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  calendarDate,
  CaptureToday,
  type DailyTask,
} from "@praxis/application";
import { desktopAvailable, desktopStorage } from "./storage";

const todayTasks = new CaptureToday(desktopStorage);
function localDay() {
  const instant = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { instant, timeZone, date: calendarDate(instant, timeZone) };
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "暂时无法完成操作，请重试。";
}

export function App() {
  const [day, setDay] = useState(localDay);
  const [recoveryDate, setRecoveryDate] = useState<string | null>(null);
  const displayedDate = recoveryDate ?? day.date;
  const [items, setItems] = useState<DailyTask[]>([]);
  const [title, setTitle] = useState("");
  const pendingDate = todayTasks.pendingDateFor(title, day.timeZone);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryVersion = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.taskId === selectedId);

  const refresh = useCallback(async (date: string) => {
    const version = ++queryVersion.current;
    setLoading(true);
    try {
      const tasks = await todayTasks.list(date);
      if (version === queryVersion.current) {
        setItems(tasks);
        setLoadError("");
      }
    } catch (error) {
      if (version === queryVersion.current) setLoadError(message(error));
    } finally {
      if (version === queryVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(displayedDate);
    return () => {
      queryVersion.current += 1;
    };
  }, [displayedDate, refresh]);

  useEffect(() => {
    const update = () => {
      const current = localDay();
      setDay((previous) =>
        previous.date === current.date && previous.timeZone === current.timeZone
          ? previous
          : current,
      );
    };
    const onFocus = () => {
      update();
      void refresh(recoveryDate ?? localDay().date);
    };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, recoveryDate]);

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const current = localDay();
      setDay(current);
      const task = await todayTasks.add(title, current.timeZone);
      setTitle("");
      setNotice(`已保存到本机 · ${task.executionDate}`);
      // A refresh failure must not imply that the successful save failed.
      setRecoveryDate(
        task.executionDate !== current.date ? task.executionDate : null,
      );
      await refresh(task.executionDate);
      inputRef.current?.focus();
    } catch (error) {
      setSaveError(message(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <a className="brand" href="#today" aria-label="Praxis 首页">
          <span className="brand-mark">P</span>Praxis
          <span className="brand-dot">.</span>
        </a>
        <p className="tagline">Turn intent into action.</p>
        <nav aria-label="主导航">
          <a className="nav-item active" href="#today" aria-current="page">
            <span aria-hidden="true">☀</span>今日
            <span className="nav-shortcut">
              {items.length.toString().padStart(2, "0")}
            </span>
          </a>
        </nav>
        <div className="sidebar-note">
          <span>一步一步，</span>
          <br />
          把重要的事向前推进。
        </div>
        <div className="sidebar-foot">
          <span className="status-dot" />
          本地工作空间
        </div>
      </aside>
      <section className="today" id="today" aria-labelledby="today-title">
        <header className="topbar">
          <span>
            我的工作台 <span className="breadcrumb-separator">/</span> 今日
          </span>
          <span className="local-badge">
            {desktopAvailable ? "保存在本机" : "浏览器预览"}
          </span>
        </header>
        <div className="today-content">
          <div className="date-row">
            <span>
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: day.timeZone,
                month: "long",
                day: "numeric",
                weekday: "long",
              }).format(day.instant)}
            </span>
            <span>{day.instant.getFullYear()}</span>
          </div>
          <p className="eyebrow">A LITTLE PROGRESS, EVERY DAY</p>
          <h1 id="today-title">
            今天，从一件小事开始<span>。</span>
          </h1>
          <p className="intro">把脑海里的下一步，变成清晰的行动。</p>
          <form
            className="capture-form"
            onSubmit={(event) => {
              void capture(event);
            }}
            aria-label="添加今日任务"
          >
            <span className="add-symbol" aria-hidden="true">
              ＋
            </span>
            <label className="sr-only" htmlFor="task-title">
              任务标题
            </label>
            <input
              ref={inputRef}
              id="task-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setSaveError("");
              }}
              placeholder="今天，想推进哪件事？"
              autoComplete="off"
              disabled={saving || !desktopAvailable}
              aria-invalid={Boolean(saveError)}
              aria-describedby={saveError ? "save-error" : "capture-hint"}
            />
            <button
              className="add-button"
              type="submit"
              disabled={saving || !desktopAvailable}
            >
              {saving ? "保存中…" : pendingDate ? "重试保存" : "添加"}
              <span aria-hidden="true">↵</span>
            </button>
          </form>
          <div className="capture-hint" id="capture-hint">
            <span>
              {pendingDate ? "重试原任务" : "添加至今日"} ·{" "}
              {pendingDate ?? day.date}
            </span>
            <span>只写标题，就可以开始</span>
          </div>
          {saveError && (
            <p className="error" id="save-error" role="alert">
              {saveError}
            </p>
          )}
          <p className="save-notice" role="status">
            {notice || "\u00a0"}
          </p>
          {recoveryDate && (
            <div className="recovery-note">
              刚刚保存至 {recoveryDate}，以下展示该日记录。
              <button onClick={() => setRecoveryDate(null)}>回到今日</button>
            </div>
          )}
          <div className="list-heading">
            <h2>
              {recoveryDate ? recoveryDate + " · 已保存" : "今日待办"}{" "}
              <span>{items.length}</span>
            </h2>
            <span>为今天留一点专注</span>
          </div>
          {loadError ? (
            <div className="load-error" role="alert">
              <p>{loadError}</p>
              {desktopAvailable && (
                <button
                  onClick={() => {
                    void refresh(displayedDate);
                  }}
                >
                  重新读取
                </button>
              )}
            </div>
          ) : loading ? (
            <p className="loading" role="status">
              正在读取本机任务…
            </p>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon" aria-hidden="true">
                ↗
              </span>
              <h2>留一点空间，给重要的事</h2>
              <p>从一件小事开始，今天就有了方向。</p>
            </div>
          ) : (
            <ul className="task-list">
              {items.map((item) => (
                <li key={item.planId}>
                  <button
                    className={
                      selectedId === item.taskId
                        ? "task-row selected"
                        : "task-row"
                    }
                    onClick={() =>
                      setSelectedId(
                        selectedId === item.taskId ? null : item.taskId,
                      )
                    }
                    aria-expanded={selectedId === item.taskId}
                  >
                    <span className="task-circle" aria-hidden="true" />
                    <span className="task-text">
                      {item.title}
                      <span className="task-meta">
                        临时事项 · {recoveryDate ?? "今天"}
                      </span>
                    </span>
                    <span className="task-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer className="content-foot">
            <span>PRAXIS / TODAY</span>
            <span>想法，正在成为行动。</span>
          </footer>
        </div>
      </section>
      {selected && (
        <aside className="task-detail" aria-label="任务详情">
          <div className="detail-heading">
            <span>任务详情</span>
            <button
              onClick={() => setSelectedId(null)}
              aria-label="关闭任务详情"
            >
              ×
            </button>
          </div>
          <span className="detail-tag">临时事项</span>
          <h2>{selected.title}</h2>
          <dl>
            <dt>执行日期</dt>
            <dd>{selected.executionDate}</dd>
            <dt>项目</dt>
            <dd>未归属项目</dd>
            <dt>状态</dt>
            <dd>待办</dd>
            <dt>保存位置</dt>
            <dd>此设备</dd>
          </dl>
        </aside>
      )}
    </main>
  );
}
