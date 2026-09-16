import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
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
  ChangeCompletion,
  type DailyTask,
} from "@praxis/application";
import {
  nativeAvailable,
  taskStorage,
  desktopAvailable,
  completionStorage,
} from "./storage";

const todayTasks = new CaptureToday(taskStorage);
const completion = new ChangeCompletion(completionStorage);
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
  const [changingId, setChangingId] = useState<string | null>(null);
  const [changeError, setChangeError] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const pendingItems = items.filter((item) => item.status !== "completed");
  const completedItems = items.filter((item) => item.status === "completed");
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
    const listener = Capacitor.isNativePlatform()
      ? NativeApp.addListener("appStateChange", ({ isActive }) => {
          if (isActive) onFocus();
        })
      : undefined;
    return () => {
      void listener?.then((handle) => handle.remove());
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

  async function changeStatus(item: DailyTask) {
    if (changingId) return;
    setChangingId(item.taskId);
    setChangeError("");
    try {
      const updated = await completion.change(
        item,
        item.status === "completed" ? "undo" : "complete",
        localDay().timeZone,
      );
      setNotice(
        item.status === "completed"
          ? "已撤销完成，任务回到待办"
          : "已完成，执行记录已保存在本机",
      );
      const resultDate =
        updated.status === "completed"
          ? (updated.completionDate ?? localDay().date)
          : updated.executionDate;
      setRecoveryDate(resultDate !== localDay().date ? resultDate : null);
      await refresh(resultDate);
    } catch (error) {
      setChangeError(message(error));
    } finally {
      setChangingId(null);
    }
  }
  function taskRow(item: DailyTask) {
    return (
      <li
        key={item.planId}
        className={
          item.status === "completed" ? "task-item completed" : "task-item"
        }
      >
        {desktopAvailable && (
          <button
            className="completion-toggle"
            aria-label={item.status === "completed" ? "撤销完成" : "标为完成"}
            title={item.title}
            disabled={changingId !== null}
            onClick={() => {
              void changeStatus(item);
            }}
          >
            {changingId === item.taskId
              ? "…"
              : item.status === "completed"
                ? "✓"
                : "○"}
          </button>
        )}
        <button
          className={
            selectedId === item.taskId ? "task-row selected" : "task-row"
          }
          onClick={() =>
            setSelectedId(selectedId === item.taskId ? null : item.taskId)
          }
          aria-expanded={selectedId === item.taskId}
        >
          {!desktopAvailable && (
            <span className="task-circle" aria-hidden="true" />
          )}
          <span className="task-text">
            <span className="task-title">{item.title}</span>
            <span className="task-meta">临时事项 · {item.executionDate}</span>
          </span>
          <span className="task-arrow" aria-hidden="true">
            ↗
          </span>
        </button>
      </li>
    );
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
            {nativeAvailable ? "保存在本机" : "浏览器预览"}
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
              disabled={saving || !nativeAvailable}
              aria-invalid={Boolean(saveError)}
              aria-describedby={saveError ? "save-error" : "capture-hint"}
            />
            <button
              className="add-button"
              type="submit"
              disabled={saving || !nativeAvailable}
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
              当前查看 {recoveryDate} 的任务记录。
              <button onClick={() => setRecoveryDate(null)}>回到今日</button>
            </div>
          )}
          <div className="list-heading">
            <h2>
              {recoveryDate ? recoveryDate + " · 已保存" : "今日待办"}{" "}
              <span>{pendingItems.length}</span>
            </h2>
            <span>为今天留一点专注</span>
          </div>
          {loadError ? (
            <div className="load-error" role="alert">
              <p>{loadError}</p>
              {nativeAvailable && (
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
            <ul className="task-list">{pendingItems.map(taskRow)}</ul>
          )}

          {changeError && (
            <div className="error" role="alert">
              {changeError}
              <button
                onClick={() => {
                  void refresh(displayedDate);
                  setChangeError("");
                }}
              >
                重新读取
              </button>
            </div>
          )}
          {!loading && !loadError && completedItems.length > 0 && (
            <section className="completed-section" aria-label="已完成任务">
              <button
                className="completed-heading"
                aria-expanded={showCompleted}
                onClick={() => setShowCompleted(!showCompleted)}
              >
                {showCompleted ? "⌄" : "›"} 已完成 · {completedItems.length}
              </button>
              {showCompleted && (
                <ul className="task-list">{completedItems.map(taskRow)}</ul>
              )}
            </section>
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
            <dt>安排日期</dt>
            <dd>{selected.executionDate}</dd>
            {selected.completionDate && (
              <>
                <dt>完成日期</dt>
                <dd>{selected.completionDate}</dd>
              </>
            )}
            <dt>项目</dt>
            <dd>未归属项目</dd>
            <dt>状态</dt>
            <dd>{selected.status === "completed" ? "已完成" : "待办"}</dd>
            <dt>保存位置</dt>
            <dd>此设备</dd>
          </dl>
        </aside>
      )}
    </main>
  );
}
