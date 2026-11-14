import { useCallback, useEffect, useRef, useState } from "react";
import {
  personalTaskQuery,
  PersonalTaskRejectedError,
  timeLabel,
  type PersonalTaskChange,
  type PersonalTaskRead,
  type PersonalDueGroup,
} from "@praxis/application";
import { personalTodoTasks } from "./personal-task-storage";
import { PersonalTaskComposer } from "./PersonalTaskComposer";
import { PersonalTaskInlineEditor } from "./PersonalTaskInlineEditor";
import { TaskCompletionButton } from "./TaskCompletionButton";
import { TaskCompletionTitle } from "./TaskCompletionTitle";
import { animateTaskCompletion } from "./task-completion-motion";
import { TaskActionMenu } from "./TaskActionMenu";
import { PersonalTaskDetails } from "./PersonalTaskDetails";
import { desktopAvailable } from "./storage";
import type {
  PersonalTaskDraft,
  PersonalTaskReceipt,
  WorkTask,
} from "@praxis/application";
import "./personal-todo.css";

export interface PersonalTodoPort {
  read(): Promise<PersonalTaskRead>;
  create?(base: PersonalTaskRead, draft: PersonalTaskDraft): Promise<void>;
  change(
    base: PersonalTaskRead,
    taskId: string,
    change: PersonalTaskChange,
  ): Promise<void | PersonalTaskReceipt>;
}
type Attempt = {
  base: PersonalTaskRead;
  taskId: string;
  title: string;
  change: PersonalTaskChange;
};
const labels: Record<PersonalDueGroup, string> = {
  overdue: "逾期",
  today: "今天",
  later: "之后",
  undated: "无日期",
};
const icons: Record<PersonalDueGroup, string> = {
  overdue: "",
  today: "",
  later: "",
  undated: "",
};
const order: PersonalDueGroup[] = ["overdue", "today", "later", "undated"];
const message = (error: unknown) => {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "暂时无法读取，请重试。";
  if (text === "STATE_CONFLICT") return "任务已发生变化，请重新读取后再操作。";
  if (text === "AI_STALE_PROJECT") return "工作空间已变化，请重新读取。";
  return text.replace(/^(?:USER:|STATE_CONFLICT:)\s*/, "");
};

/** Shared desktop/mobile homepage. Reads all live tasks through the personal port. */
export function PersonalTodoHome({
  port = personalTodoTasks,
  projectId,
  revision,
  embedded = false,
  externalBusy = false,
  onBusyChange,
  onOpenProject,
  onChanged,
  onOpenAgent,
  focusRevision,
}: {
  port?: PersonalTodoPort;
  projectId?: string;
  revision?: unknown;
  embedded?: boolean;
  externalBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onOpenProject: (id: string) => void;
  onChanged?: () => void;
  onOpenAgent?: () => void;
  focusRevision?: number;
}) {
  const [editing, setEditing] = useState<{
    base: PersonalTaskRead;
    task: WorkTask;
  } | null>(null);
  const [composerLocked, setComposerLocked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelLocked, setPanelLocked] = useState(false);
  const region = useRef<HTMLElement>(null);
  const [base, setBase] = useState<PersonalTaskRead | null>(null);
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [undo, setUndo] = useState<{
    attempt: Attempt;
    expiresAt: number;
  } | null>(null);
  const undoCandidate = useRef<{
    scopeKey: string;
    taskId: string;
    title: string;
    change: PersonalTaskChange;
    expiresAt: number;
    expectedVersion?: number;
  } | null>(null);
  const knownScope = useRef<string | null>(null);
  const rejection = useRef<string | null>(null);
  const alive = useRef(false),
    sequence = useRef(0),
    saving = useRef(false),
    attempt = useRef<Attempt | null>(null),
    needsRead = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const callbacks = useRef({
    onBusyChange,
    onChanged,
    externalBusy,
    draft: false,
  });
  callbacks.current = {
    onBusyChange,
    onChanged,
    externalBusy,
    draft: editing !== null || composerLocked || panelLocked,
  };
  const refresh = useCallback(async () => {
    if (
      saving.current ||
      attempt.current ||
      callbacks.current.externalBusy ||
      callbacks.current.draft
    ) {
      needsRead.current = true;
      return;
    }
    needsRead.current = false;
    const token = ++sequence.current;
    setRefreshing(true);
    try {
      const next = await port.read();
      if (
        !alive.current ||
        token !== sequence.current ||
        saving.current ||
        attempt.current ||
        callbacks.current.externalBusy ||
        callbacks.current.draft
      ) {
        needsRead.current = true;
        return;
      }
      setBase(next);
      if (knownScope.current && knownScope.current !== next.scopeKey) {
        setSelectedId(null);
        setUndo(null);
        undoCandidate.current = null;
        setNotice("");
        rejection.current = null;
      }
      knownScope.current = next.scopeKey;
      const candidate = undoCandidate.current;
      if (
        candidate &&
        candidate.expiresAt > Date.now() &&
        candidate.scopeKey === next.scopeKey
      ) {
        const exists =
          candidate.change.type === "restore"
            ? next.trash?.some((t) => t.id === candidate.taskId)
            : next.query.task(candidate.taskId);
        const deletedVersion = next.trash?.find(
          (t) => t.id === candidate.taskId,
        )?.version;
        if (
          exists &&
          (candidate.expectedVersion === undefined ||
            candidate.expectedVersion === deletedVersion)
        )
          setUndo(
            (current) =>
              current ?? {
                attempt: {
                  base: next,
                  taskId: candidate.taskId,
                  title: candidate.title,
                  change: candidate.change,
                },
                expiresAt: candidate.expiresAt,
              },
          );
      }
      setNow(new Date());
      setStale(false);
      setError(rejection.current ?? "");
    } catch (error) {
      if (alive.current && token === sequence.current) {
        setError(message(error));
        setStale(true);
      }
    } finally {
      if (alive.current && token === sequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [port]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(
      () => {
        setUndo(null);
        undoCandidate.current = null;
      },
      Math.max(0, undo.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const sync = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const clock = window.setInterval(() => {
      // Moving a row to another date group would remount its inline draft.
      if (!callbacks.current.draft && !saving.current && !attempt.current)
        setNow(new Date());
    }, 15000);
    window.addEventListener("focus", sync);
    window.addEventListener("praxis-lan-sync", sync);
    window.addEventListener("praxis-task-editor-closed", sync);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive.current = false;
      ++sequence.current;
      window.clearInterval(clock);
      window.removeEventListener("focus", sync);
      window.removeEventListener("praxis-lan-sync", sync);
      window.removeEventListener("praxis-task-editor-closed", sync);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [revision, refresh]);
  useEffect(() => {
    if (!focusRevision) return;
    const frame = requestAnimationFrame(() =>
      region.current
        ?.querySelector<HTMLInputElement>("[data-personal-capture]")
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusRevision, loading]);
  useEffect(() => {
    if (!externalBusy && !editing && !composerLocked && !panelLocked && needsRead.current)
      void refresh();
  }, [externalBusy, editing, composerLocked, panelLocked, refresh]);
  useEffect(() => {
    onBusyChange?.(
      busy || pending !== null || editing !== null || composerLocked || panelLocked,
    );
    return () => onBusyChange?.(false);
  }, [busy, pending, editing, composerLocked, panelLocked, onBusyChange]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (saving.current || attempt.current || callbacks.current.draft)
        event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, []);

  async function perform(next: Attempt) {
    if (saving.current || callbacks.current.externalBusy) return;
    saving.current = true;
    ++sequence.current;
    setRefreshing(false);
    attempt.current = next;
    setPending(next);
    setBusy(true);
    setError("");
    rejection.current = null;
    setNotice("");
    setUndo(null);
    undoCandidate.current = null;
    let committed = false;
    let clearMotion = () => {};
    try {
      const receipt = await port.change(next.base, next.taskId, next.change);
      committed = true;
      if (next.change.type === "status" && next.change.status === "completed")
        clearMotion = await animateTaskCompletion(next.taskId);
      if (next.change.type === "status" && receipt?.operationId)
        undoCandidate.current = {
          scopeKey: next.base.scopeKey,
          taskId: next.taskId,
          title: next.title,
          change: { type: "undoStatus", operationId: receipt.operationId },
          expiresAt: Date.now() + 10000,
        };
      else if (next.change.type === "delete")
        undoCandidate.current = {
          scopeKey: next.base.scopeKey,
          taskId: next.taskId,
          title: next.title,
          change: { type: "restore" },
          expiresAt: Date.now() + 10000,
          expectedVersion: next.base.query.task(next.taskId)!.version + 1,
        };
      attempt.current = null;
      if (alive.current) {
        setPending(null);
        setEditing(null);
        setSelectedId(null);
        callbacks.current.draft = false;
        setNotice(
          `${next.change.type === "edit" ? "已更新" : next.change.type === "delete" ? "已移到已删除任务" : next.change.type === "restore" ? "已恢复" : next.change.type === "undoStatus" ? "已撤销状态修改" : next.change.type === "status" && next.change.status === "completed" ? "已完成" : next.change.type === "status" && next.change.status === "in_progress" ? "已开始" : "已重新打开"}「${next.title}」`,
        );
      }
    } catch (error) {
      if (error instanceof PersonalTaskRejectedError) {
        rejection.current = message(error);
        attempt.current = null;
        if (alive.current) {
          setPending(null);
          setStale(true);
        }
      }
      if (alive.current) setError(message(error));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
    if (committed && alive.current) {
      try {
        await refresh();
        callbacks.current.onChanged?.();
        heading.current?.focus({ preventScroll: true });
      } finally { clearMotion(); }
    } else {
      clearMotion();
    }
  }
  const query = base
    ? personalTaskQuery(
        {
          ...base.work,
          tasks: base.work.tasks.filter((t) => t.projectId === (projectId ?? null)),
        },
        now,
        base.fallbackZone,
      )
    : null;
  const total = query
    ? order.reduce((n, key) => n + query.groups[key].length, 0)
    : 0;
  const locked =
    busy ||
    pending !== null ||
    externalBusy ||
    stale ||
    refreshing ||
    editing !== null ||
    composerLocked ||
    panelLocked;
  const useDailyActions = desktopAvailable;
  const selectedTask = query?.tasks.find((task) => task.id === selectedId);
  const scopedTrash = (base?.trash ?? []).filter(
    (task) => task.projectId === (projectId ?? null),
  );
  async function refreshFromDetails() {
    const next = await port.read();
    setBase(next);
    setNow(new Date());
    callbacks.current.onChanged?.();
    return next;
  }
  function openDetails(task: WorkTask) {
    if (useDailyActions) setSelectedId(selectedId === task.id ? null : task.id);
    else if (base) setEditing({ base, task });
  }
  function row(task: NonNullable<typeof query>["tasks"][number]) {
    const project = base?.work.projects.find((p) => p.id === task.projectId);
    return (
      <li className={`personal-todo-row${useDailyActions ? " uses-daily-actions" : ""}${task.status === "completed" ? " completed" : ""}${selectedId === task.id ? " selected" : ""}`} key={task.id} data-task-id={task.id} data-completion-row="">
        {useDailyActions ? (
          <TaskCompletionButton
            title={task.title}
            completed={task.status === "completed"}
            busy={busy && pending?.taskId === task.id}
            disabled={locked}
            onToggle={() => base && void perform({base, taskId: task.id, title: task.title, change: {type: "status", status: task.status === "completed" ? "todo" : "completed"}})}
          />
        ) : (
        <button
          type="button"
          className="personal-todo-check"
          aria-label={`${task.status === "completed" ? "重新打开" : "完成"}：${task.title}`}
          aria-pressed={task.status === "completed"}
          disabled={locked}
          onClick={() =>
            base &&
            void perform({
              base,
              taskId: task.id,
              title: task.title,
              change: {
                type: "status",
                status: task.status === "completed" ? "todo" : "completed",
              },
            })
          }
        >
          {task.status === "completed" ? "✓" : ""}
        </button>
        )}
        <div className="personal-todo-content">
          <button
            type="button"
            className="personal-todo-title"
            disabled={locked}
            aria-expanded={useDailyActions ? selectedId === task.id : undefined}
            onClick={() => openDetails(task)}
          >
            <TaskCompletionTitle taskId={task.id}>{task.title}</TaskCompletionTitle>
          </button>
          <div className="personal-todo-meta">
            {task.status !== "todo" && (
              <span className="personal-todo-status" data-state={task.status}>
                {task.label}
              </span>
            )}
            {task.deadline && (
              <span>
                截止{" "}
                {timeLabel(
                  task.deadline,
                  task.deadline.kind === "instant"
                    ? task.deadline.displayTimezone
                    : query!.timeZone,
                )}
              </span>
            )}
            {task.projectId && !projectId ? (
              <button
                type="button"
                disabled={locked}
                className="personal-todo-project"
                onClick={() => onOpenProject(task.projectId!)}
              >
                {project?.name ?? "原项目"}
              </button>
            ) : null}
          </div>
        </div>
        {useDailyActions ? (
          <TaskActionMenu label={`更多操作：${task.title}`} disabled={locked}>
            {(close) => (
              <>
                <button type="button" onClick={() => { openDetails(task); close(); }}>打开任务详情</button>
                {task.status !== "completed" && (
                  <button type="button" onClick={() => {
                    close();
                    if (base) void perform({base, taskId: task.id, title: task.title, change: {type: "status", status: task.status === "in_progress" ? "todo" : "in_progress"}});
                  }}>{task.status === "in_progress" ? "设为待办" : "开始任务"}</button>
                )}
                <button
                  type="button"
                  disabled={!!task.parentId || base!.work.tasks.some((other) => other.parentId === task.id)}
                  title="移到已删除任务，可恢复"
                  onClick={() => {
                    close();
                    if (base) void perform({base, taskId: task.id, title: task.title, change: {type: "delete"}});
                  }}
                >删除任务</button>
              </>
            )}
          </TaskActionMenu>
        ) : (
        <div className="personal-task-row-actions">
          <select
            aria-label={`任务状态：${task.title}`}
            value={task.status}
            disabled={locked}
            onChange={(e) =>
              base &&
              void perform({
                base,
                taskId: task.id,
                title: task.title,
                change: {
                  type: "status",
                  status: e.target.value as
                    "todo" | "in_progress" | "completed",
                },
              })
            }
          >
            {!["todo", "in_progress", "completed"].includes(task.status) && (
              <option value={task.status} disabled>
                {task.label}（旧状态）
              </option>
            )}
            <option value="todo">待办</option>
            <option value="in_progress">进行中</option>
            <option value="completed">已完成</option>
          </select>
          <button
            type="button"
            className="personal-todo-delete"
            aria-label={`删除：${task.title}`}
            disabled={
              locked ||
              !!task.parentId ||
              query!.tasks.some((t) => t.parentId === task.id)
            }
            title={
              task.parentId || query!.tasks.some((t) => t.parentId === task.id)
                ? "包含子任务，暂不能在这里删除"
                : "移到已删除任务，可恢复"
            }
            onClick={() =>
              base &&
              void perform({
                base,
                taskId: task.id,
                title: task.title,
                change: { type: "delete" },
              })
            }
          >
            删除
          </button>
        </div>
        )}
        {editing?.task.id === task.id && (
          <PersonalTaskInlineEditor
            key={task.id}
            task={editing.task}
            locked={busy || pending !== null || externalBusy}
            stale={stale}
            failure={error}
            onRetry={
              pending && !busy
                ? () => attempt.current && void perform(attempt.current)
                : undefined
            }
            onSave={(change) =>
              void perform({
                base: editing.base,
                taskId: task.id,
                title: task.title,
                change,
              })
            }
            onCancel={() => {
              setEditing(null);
              callbacks.current.draft = false;
              if (needsRead.current || stale) {
                rejection.current = null;
                void refresh();
              }
            }}
          />
        )}
      </li>
    );
  }
  return (
    <section
      ref={region}
      className={`personal-todo-home${embedded ? " is-embedded" : ""}${projectId ? " is-project-tasks" : ""}`}
      aria-label={projectId ? "项目任务" : "杂事"}
      aria-busy={loading || refreshing || busy}
    >
      <header className="personal-todo-header">
        <div>
          {embedded ? (
            <h2 ref={heading} tabIndex={-1} className="sr-only">
              {projectId ? "项目任务" : "杂事"}
            </h2>
          ) : (
            <h1 ref={heading} tabIndex={-1}>
              杂事
            </h1>
          )}
          <p>
            {loading
              ? "正在读取个人任务…"
              : query
                ? `${total ? `尚有 ${total} 项任务待完成` : "暂无待办任务"}${stale ? "（上次读取）" : ""}`
                : "尚未读取个人任务"}
          </p>
        </div>
        {onOpenAgent && !projectId && (
          <div className="personal-todo-tools">
            <button
              type="button"
              className="primary"
              aria-label="下一步建议"
              disabled={locked || loading}
              onClick={onOpenAgent}
            >
              ✦ 下一步建议
            </button>
          </div>
        )}
      </header>
      {base && port.create && (
        <PersonalTaskComposer
          key={projectId ?? "independent"}
          base={base}
          projectId={projectId ?? null}
          port={port}
          disabled={
            busy ||
            pending !== null ||
            externalBusy ||
            stale ||
            refreshing ||
            editing !== null
          }
          onDraftChange={setComposerLocked}
          onCreated={(next, title) => {
            rejection.current = null;
            setBase(next);
            setNow(new Date());
            setStale(false);
            setError("");
            setNotice(`已添加「${title}」`);
            callbacks.current.onChanged?.();
          }}
        />
      )}
      {notice && (
        <p className="personal-todo-notice" role="status">
          {notice}
        </p>
      )}
      {undo && undo.expiresAt > Date.now() && (
        <p className="personal-todo-notice" role="status">
          10秒内可撤销{" "}
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              if (undo.expiresAt > Date.now()) void perform(undo.attempt);
            }}
          >
            撤销上次操作
          </button>
        </p>
      )}
      {error && (
        <div className="personal-todo-error" role="alert">
          <p>{error}</p>
          {pending ? (
            <>
              <p>保存结果尚未确认，请重试原操作。</p>
              {!editing && (
                <button
                  type="button"
                  disabled={busy || externalBusy}
                  onClick={() =>
                    attempt.current && void perform(attempt.current)
                  }
                >
                  重试原操作
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={
                refreshing || externalBusy || editing !== null || composerLocked
              }
              onClick={() => {
                rejection.current = null;
                void refresh();
              }}
            >
              重新读取
            </button>
          )}
        </div>
      )}
      {loading && (
        <p className="personal-todo-empty" role="status">
          正在读取本机任务…
        </p>
      )}
      {!loading && query && (
        <>
          {total === 0 && (
            <div className="personal-todo-empty">
              <h2>暂无待办任务</h2>
              <p>写下新的任务，开始推进。</p>
            </div>
          )}
          {order
            .filter((key) => query.groups[key].length > 0)
            .map((key) => (
              <section
                className="personal-todo-group"
                data-group={key}
                key={key}
                aria-labelledby={`personal-group-${key}`}
              >
                <h2 id={`personal-group-${key}`}>
                  <i aria-hidden="true">{icons[key]}</i>
                  {labels[key]} <span>{query.groups[key].length}</span>
                </h2>
                <ul>{query.groups[key].map(row)}</ul>
              </section>
            ))}
          {query.completed.length > 0 && (
            <details className="personal-todo-completed">
              <summary>
                已完成 <span>{query.completed.length}</span>
              </summary>
              <ul>{query.completed.map(row)}</ul>
            </details>
          )}
          {scopedTrash.length > 0 ? (
            <details className="personal-todo-completed">
              <summary>
                已删除任务{" "}
                <span>
                  {scopedTrash.length}
                </span>
              </summary>
              <ul>
                {scopedTrash
                  .map((task) => (
                    <li className="personal-todo-row" key={task.id}>
                      <span className="personal-todo-content">
                        {task.title}
                      </span>
                      <button
                        type="button"
                        disabled={locked || !task.canRestore}
                        aria-label={`恢复：${task.title}`}
                        onClick={() =>
                          void perform({
                            base: base!,
                            taskId: task.id,
                            title: task.title,
                            change: { type: "restore" },
                          })
                        }
                      >
                        恢复
                      </button>
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {useDailyActions && selectedTask && base && (
        <PersonalTaskDetails
          key={selectedTask.id}
          task={selectedTask}
          base={base}
          onRefresh={refreshFromDetails}
          onClose={() => setSelectedId(null)}
          onComplete={async () => {
            await perform({base, taskId: selectedTask.id, title: selectedTask.title, change: {type: "status", status: selectedTask.status === "completed" ? "todo" : "completed"}});
          }}
          onOpenProject={onOpenProject}
          onLockedChange={setPanelLocked}
        />
      )}
    </section>
  );
}
