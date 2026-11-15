import { InboxTaskPanel } from "./InboxTaskPanel";
import { AiPlannerPanel } from "./AiPlannerPanel";
import { desktopAiContext } from "./ai-storage";
import type { AiPlannerLaunch } from "./ai-planner-model";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { readWork, sendWorkAction, openWorkTask } from "./ProductivityView";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  subtree,
  terminal,
  type InboxTask,
  type WorkTask,
} from "@praxis/application";
import { planningStorage } from "./storage";
import { planning } from "./PlanningPanel";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function InboxView({
  onScheduled,
  onBusyChange,
  focusRevision,
  revision,
}: {
  onScheduled: (date: string) => void;
  onBusyChange: (busy: boolean) => void;
  focusRevision: number;
  revision: number;
}) {
  const [tasks, setTasks] = useState<InboxTask[]>([]);
  const [title, setTitle] = useState("");
  const [aiLaunch, setAiLaunch] = useState<AiPlannerLaunch | null>(null);
  const [aiOpening, setAiOpening] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [completed, setCompleted] = useState<WorkTask[]>([]);
  const [confirmTask, setConfirmTask] = useState<{
    task: WorkTask;
    count: number;
    expectedTasks: Array<[string, number]>;
  } | null>(null);
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
      const snapshot = await readWork();
      const rows = await planningStorage.listInbox();
      if (version !== requestVersion.current) return;
      setTasks(rows);
      setCompleted(
        snapshot.tasks.filter(
          (t) =>
            t.status === "completed" &&
            !t.projectId &&
            !t.plan &&
            !snapshot.legacyPlans.some((p) => p.taskId === t.id),
        ),
      );
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
    const edited = () => {
      void refresh();
      setPanelRevision((n) => n + 1);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("praxis-task-editor-closed", edited);
    return () => {
      ++requestVersion.current;
      window.removeEventListener("focus", focus);
      window.removeEventListener("praxis-task-editor-closed", edited);
    };
  }, [refresh, revision]);
  useEffect(() => {
    onBusyChange(busy || panelLocked || !!confirmTask || aiOpening || !!aiLaunch);
    return () => onBusyChange(false);
  }, [busy, panelLocked, confirmTask, aiOpening, aiLaunch, onBusyChange]);
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
    try {
      await planning.capture(title);
      setTitle("");
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
  const locked = busy || panelLocked || aiOpening || !!aiLaunch;
  async function changeStatus(
    id: string,
    status: "completed" | "todo",
    confirmRelated = false,
    expectedVersion?: number,
  ) {
    if (busyRef.current || panelLockedRef.current) return;
    changeBusy(true);
    setError("");
    try {
      const snapshot = await readWork();
      const task = snapshot.tasks.find((t) => t.id === id);
      if (!task) throw new Error("任务已变化，请重新读取收件箱。");
      if (expectedVersion !== undefined && task.version !== expectedVersion)
        throw new Error(
          "任务已更新，请重新读取后再操作，避免撤销后续的完成记录。",
        );
      const related = subtree(snapshot.tasks, id).filter(
        (t) => t.id !== id && !terminal(t),
      );
      if (status === "completed" && related.length && !confirmRelated) {
        setConfirmTask({
          task,
          count: related.length,
          expectedTasks: snapshot.tasks.map((t) => [t.id, t.version]),
        });
        return;
      }
      await sendWorkAction({
        type: "status",
        id,
        status,
        expectedVersion: task.version,
        confirmRelated,
        expectedTasks:
          confirmRelated && confirmTask
            ? confirmTask.expectedTasks
            : snapshot.tasks.map((t) => [t.id, t.version]),
      });
      setConfirmTask(null);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      changeBusy(false);
    }
  }
  async function openAi() {
    if (locked) return;
    setSelectedId(null);
    setAiOpening(true);
    setError("");
    try {
      setAiLaunch({ mode: "clarify", input: title, context: await desktopAiContext(null, []) });
    } catch (e) {
      setError(message(e));
    } finally {
      setAiOpening(false);
    }
  }
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
      {aiLaunch && <AiPlannerPanel launch={aiLaunch} onClose={() => setAiLaunch(null)} onApplied={async (_receipt, adoptedInput) => { if (title === adoptedInput) setTitle(""); await refresh(true); }} />}
      <div className="today-content">
        <header className="inbox-toolbar">
          <h1 id="inbox-heading">
            <TaskPanelIcon name="inbox" />
            收件箱
          </h1>
          <button type="button" className="ai-planner-launch" disabled={locked || loading} onClick={() => void openAi()}>{aiOpening ? "正在打开…" : "✦ 整理想法"}</button>
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
            placeholder="添加内容"
          />
          {busy && (
            <span className="capture-status" role="status">
              保存中…
            </span>
          )}
        </form>
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
                    type="button"
                    className="completion-toggle"
                    aria-label={`完成任务：${task.title}`}
                    aria-pressed={false}
                    disabled={locked}
                    onClick={() => void changeStatus(task.taskId, "completed")}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  </button>
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
          <p className="inbox-empty">暂无未安排的独立任务。</p>
        )}
        {!!completed.length && (
          <details className="completed-section">
            <summary>已完成 · {completed.length}</summary>
            <ul className="task-list inbox-list">
              {completed.map((task) => (
                <li className="inbox-row completed" key={task.id}>
                  <button
                    type="button"
                    className="completion-toggle"
                    aria-label={`撤销完成：${task.title}`}
                    aria-pressed={true}
                    disabled={locked}
                    onClick={() =>
                      void changeStatus(task.id, "todo", false, task.version)
                    }
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path className="completion-check" d="m7.5 12 3 3 6-6" />
                    </svg>
                  </button>
                  <button
                    className="inbox-task-title"
                    disabled={locked}
                    onClick={() => openWorkTask(task.id)}
                  >
                    {task.title}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {selected && (
        <InboxTaskPanel
          key={selected.taskId + ":" + panelRevision}
          task={selected}
          onComplete={() => changeStatus(selected.taskId, "completed")}
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
      {confirmTask && (
        <div
          className="work-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="确认完成子任务"
        >
          <div className="work-dialog">
            <h2>完成「{confirmTask.task.title}」？</h2>
            <p>将同时完成 {confirmTask.count} 个未结束的子任务。</p>
            {error && <p role="alert">{error}</p>}
            <button
              disabled={busy}
              onClick={() =>
                void changeStatus(confirmTask.task.id, "completed", true)
              }
            >
              完成任务和子任务
            </button>
            <button disabled={busy} onClick={() => setConfirmTask(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
