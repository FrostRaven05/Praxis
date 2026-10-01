import { InboxTaskPanel } from "./InboxTaskPanel";
import { TaskPanelIcon } from "./TaskPanelIcon";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { type InboxTask } from "@praxis/application";
import { planningStorage } from "./storage";
import { planning } from "./PlanningPanel";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function InboxView({
  onScheduled,
  onBusyChange,
  focusRevision,
}: {
  onScheduled: (date: string) => void;
  onBusyChange: (busy: boolean) => void;
  focusRevision: number;
}) {
  const [tasks, setTasks] = useState<InboxTask[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelLocked, setPanelLocked] = useState(false);
  const [panelRevision, setPanelRevision] = useState(0);
  const panelLockedRef = useRef(false);
  const [sort, setSort] = useState<"desc" | "asc">("desc");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const focusAfterCapture = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusRevision]);
  const refresh = useCallback(async (reportFailure = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const rows = await planningStorage.listInbox();
      if (version !== requestVersion.current) return;
      setTasks(rows);
      setLoadError("");
      setSelectedId((id) =>
        rows.some((task) => task.taskId === id) ? id : null,
      );
    } catch (error) {
      if (version === requestVersion.current) setLoadError(message(error));
      if (reportFailure) throw error;
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => {
      if (!busyRef.current && !panelLockedRef.current) void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      ++requestVersion.current;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    onBusyChange(busy || panelLocked);
    return () => onBusyChange(false);
  }, [busy, panelLocked, onBusyChange]);
  useEffect(() => {
    if (!busy && focusAfterCapture.current) {
      focusAfterCapture.current = false;
      inputRef.current?.focus();
    }
  }, [busy]);
  function changeBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  async function capture(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || panelLockedRef.current) return;
    changeBusy(true);
    setError("");
    setNotice("");
    try {
      await planning.capture(title);
      setTitle("");
      setNotice("已保存到收件箱");
      await refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      focusAfterCapture.current = true;
      changeBusy(false);
    }
  }
  const changePanelLock = useCallback((value: boolean) => {
    panelLockedRef.current = value;
    setPanelLocked(value);
  }, []);
  const locked = busy || panelLocked;
  const selected = tasks.find((task) => task.taskId === selectedId);
  const ordered = [...tasks].sort((a, b) => {
    const comparison =
      a.createdAt.localeCompare(b.createdAt) ||
      a.taskId.localeCompare(b.taskId);
    return sort === "desc" ? -comparison : comparison;
  });
  return (
    <section
      className="today inbox-view simple-inbox"
      aria-labelledby="inbox-heading"
    >
      <div className="today-content">
        <header className="inbox-toolbar">
          <h1 id="inbox-heading">
            <TaskPanelIcon name="inbox" />
            收件箱
          </h1>
          <label className="inbox-sort">
            <span>按创建日期</span>
            <select
              aria-label="收件箱排序"
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as "desc" | "asc")
              }
              disabled={locked}
            >
              <option value="desc">最新在前</option>
              <option value="asc">最早在前</option>
            </select>
          </label>
        </header>
        <form
          className="capture-form"
          aria-label="添加收件箱任务"
          onSubmit={(event) => {
            void capture(event);
          }}
        >
          <span className="capture-circle" aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label="收件箱任务标题"
            autoFocus
            autoComplete="off"
            value={title}
            disabled={locked}
            onChange={(event) => {
              setTitle(event.target.value);
              setError("");
            }}
            placeholder="在此添加内容，按回车保存"
          />
          {busy && (
            <span className="capture-status" role="status">
              保存中…
            </span>
          )}
        </form>
        <p role="status" className="save-notice">
          {notice}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {loadError && (
          <p role="alert" className="error">
            {loadError}
            <button
              disabled={locked}
              onClick={() => {
                void refresh();
              }}
            >
              重新读取收件箱
            </button>
          </p>
        )}
        {loading && tasks.length === 0 ? (
          <p className="loading" role="status">
            正在读取收件箱…
          </p>
        ) : (
          <ul
            className="task-list inbox-list"
            aria-label="收件箱任务"
            aria-busy={loading}
          >
            {ordered.map((task) => {
              const selected = selectedId === task.taskId;
              return (
                <li
                  className={`inbox-row${selected ? " is-selected" : ""}`}
                  key={task.taskId}
                >
                  <button
                    className="inbox-task-title"
                    aria-expanded={selected}
                    aria-controls={selected ? "inbox-task-panel" : undefined}
                    disabled={locked}
                    onClick={(event) => {
                      panelTrigger.current = event.currentTarget;
                      setSelectedId(selected ? null : task.taskId);
                      setError("");
                    }}
                  >
                    <span className="inbox-task-circle" aria-hidden="true" />
                    <span>{task.title}</span>
                    {task.important && (
                      <span className="task-important" aria-label="重要任务">
                        重要
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !tasks.length && !loadError && (
          <p className="inbox-empty">收件箱为空，先记下下一件事。</p>
        )}
      </div>
      {selected && (
        <InboxTaskPanel
          key={selected.taskId + ":" + panelRevision}
          task={selected}
          onLockedChange={changePanelLock}
          onClose={() => {
            setSelectedId(null);
            panelTrigger.current?.focus();
          }}
          onSaved={async (date) => {
            if (date) onScheduled(date);
            else await refresh(true);
          }}
          onReload={async () => {
            await refresh(true);
            setPanelRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
