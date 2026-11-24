import { feedbackMessage } from "./feedback-message";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listedPersonalTasks,
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
import { PersonalTaskDetails } from "./PersonalTaskDetails";
import { currentSubtask } from "./current-subtask";
import { noteSubtitle } from "./task-note";
import { desktopAvailable } from "./storage";
import { assignPomodoroTask, readPomodoroState, writePomodoroState } from "./pomodoro";
import {
  computeNextStepHandoff,
  parentToAutoComplete,
  type NextStepHandoff,
} from "./next-step-handoff";
import { NextStepBanner } from "./NextStepBanner";
import { TaskAiInspiration } from "./TaskAiInspiration";
import { planning } from "./PlanningPanel";
import { calendarDate } from "@praxis/application";
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
  hideComposer = false,
  hideHistory = false,
  externalBusy = false,
  onBusyChange,
  onOpenProject,
  onChanged,
  onScheduleToday,
  onStartPomodoro,
  onPomodoroStarted,
  onOpenTaskEditor,
  focusRevision,
}: {
  port?: PersonalTodoPort;
  projectId?: string;
  revision?: unknown;
  embedded?: boolean;
  hideComposer?: boolean;
  hideHistory?: boolean;
  externalBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onOpenProject: (id: string) => void;
  onChanged?: () => void;
  onScheduleToday?: (task: WorkTask) => void | Promise<void>;
  onStartPomodoro?: (task: { id: string; title: string }) => void;
  onPomodoroStarted?: () => void;
  onOpenTaskEditor?: (task: WorkTask) => void;
  focusRevision?: number;
}) {
  const [editing, setEditing] = useState<{
    base: PersonalTaskRead;
    task: WorkTask;
  } | null>(null);
  const [composerLocked, setComposerLocked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [inspireTaskId, setInspireTaskId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<NextStepHandoff | null>(null);
  const rowMenuPanel = useRef<HTMLDivElement>(null);
  const [panelLocked, setPanelLocked] = useState(false);
  const region = useRef<HTMLElement>(null);
  const [base, setBase] = useState<PersonalTaskRead | null>(null);
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState("");
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
    setUndo(null);
    undoCandidate.current = null;
    let committed = false;
    let clearMotion = () => {};
    try {
      const receipt = await port.change(next.base, next.taskId, next.change);
      committed = true;
      if (next.change.type === "status" && next.change.status === "completed") {
        clearMotion = await animateTaskCompletion(next.taskId);
        const autoParentId = parentToAutoComplete(
          next.taskId,
          next.base.work.tasks,
        );
        if (autoParentId) {
          const afterSubtask = await port.read().catch(() => null);
          if (afterSubtask) {
            await port
              .change(afterSubtask, autoParentId, {
                type: "status",
                status: "completed",
              })
              .catch(() => undefined);
          }
        }
        const zone = next.base.query.timeZone;
        const today = calendarDate(new Date(), zone);
        const suggestion = computeNextStepHandoff(
          next.taskId,
          next.base.work,
          today,
          zone,
        );
        if (alive.current) {
          setHandoff(
            suggestion &&
              !(autoParentId && suggestion.kind === "complete_parent")
              ? suggestion
              : null,
          );
        }
      } else if (alive.current) {
        setHandoff(null);
      }
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
          tasks: listedPersonalTasks(
            base.work,
            projectId ?? null,
            now,
            base.fallbackZone,
          ),
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
  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const outside = (event: PointerEvent) => {
      if (rowMenuPanel.current?.contains(event.target as Node)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".personal-todo-more")
      )
        return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [rowMenu]);
  const selectedTask = query?.tasks.find((task) => task.id === selectedId);
  const menuTask = rowMenu
    ? query?.tasks.find((task) => task.id === rowMenu.id)
    : undefined;
  useLayoutEffect(() => {
    const panel = rowMenuPanel.current;
    if (!rowMenu || !panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(rowMenu.x, innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rowMenu.y + height + 12 <= innerHeight ? rowMenu.y : rowMenu.y - height)}px`;
    panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [rowMenu]);
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
  function rooted<T extends { id: string; parentId: string | null }>(tasks: readonly T[]) {
    return tasks.filter((task) => !task.parentId);
  }
  function openDetails(task: WorkTask) {
    if (useDailyActions) setSelectedId(selectedId === task.id ? null : task.id);
    else if (onOpenTaskEditor) onOpenTaskEditor(task);
    else if (base) setEditing({ base, task });
  }
  function row(task: NonNullable<typeof query>["tasks"][number]) {
    const project = base?.work.projects.find((p) => p.id === task.projectId);
    const subtitle = noteSubtitle(task.notes).trim();
    const objective =
      task.status === "completed" ? null : currentSubtask(query!.tasks, task.id);
    return (
      <li
        className={`personal-todo-row${useDailyActions ? " uses-daily-actions" : ""}${task.status === "completed" ? " completed" : ""}${selectedId === task.id ? " selected" : ""}`}
        key={task.id}
        data-task-id={task.id}
        data-completion-row=""
        onContextMenu={(event) => {
          if (!useDailyActions || locked) return;
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest("input, textarea, [contenteditable='true']")
          )
            return;
          event.preventDefault();
          setRowMenu({ id: task.id, x: event.clientX, y: event.clientY });
        }}
      >
        <TaskCompletionButton
          title={task.title}
          completed={task.status === "completed"}
          busy={busy && pending?.taskId === task.id}
          disabled={locked}
          onToggle={() =>
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
        />
        <div className="personal-todo-content">
          <button
            type="button"
            className="personal-todo-title"
            disabled={locked}
            aria-expanded={useDailyActions ? selectedId === task.id : undefined}
            onClick={() => openDetails(task)}
          >
            <TaskCompletionTitle taskId={task.id}>{task.title}</TaskCompletionTitle>
            {objective && (
              <span className="personal-todo-objective">
                <span className="personal-todo-objective-kicker">当前</span>
                <span className="personal-todo-objective-title" title={objective.title}>
                  {objective.title}
                </span>
              </span>
            )}
          </button>
          {subtitle && <span className="task-card-note">{subtitle}</span>}
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
        {useDailyActions ? null : (
          <button
            type="button"
            className="personal-todo-more"
            aria-label={`更多操作：${task.title}`}
            aria-haspopup="menu"
            aria-expanded={rowMenu?.id === task.id}
            disabled={locked}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setRowMenu(
                rowMenu?.id === task.id
                  ? null
                  : { id: task.id, x: rect.right, y: rect.bottom + 4 },
              );
            }}
          >
            ···
          </button>
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
          {loading ? (
            <p>正在读取个人任务…</p>
          ) : !query ? (
            <p>尚未读取个人任务</p>
          ) : null}
        </div>
      </header>
      {!hideComposer && base && port.create && (
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
          onCreated={(next) => {
            rejection.current = null;
            setBase(next);
            setNow(new Date());
            setStale(false);
            setError("");
            callbacks.current.onChanged?.();
          }}
        />
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
      {handoff && base && (
        <NextStepBanner
          handoff={handoff}
          disabled={locked}
          onStartPomodoro={(task) => {
            if (onStartPomodoro) {
              onStartPomodoro({ id: task.id, title: task.title });
            } else {
              writePomodoroState(
                assignPomodoroTask(
                  readPomodoroState(),
                  { id: task.id, title: task.title },
                  Date.now(),
                ),
              );
            }
            setHandoff(null);
          }}
          {...(onScheduleToday
            ? {
                onScheduleToday: async (task) => {
                  try {
                    await onScheduleToday(task);
                    await refresh();
                    callbacks.current.onChanged?.();
                  } catch (caught) {
                    if (alive.current) setError(message(caught));
                    throw caught;
                  }
                },
              }
            : desktopAvailable
              ? {
                  onScheduleToday: async (task) => {
                    try {
                      const zone = base.query.timeZone;
                      const today = calendarDate(new Date(), zone);
                      await planning.acceptSuggestion(
                        {
                          taskId: task.id,
                          title: task.title,
                          version: task.version,
                          createdAt: task.createdAt,
                        },
                        today,
                        zone,
                      );
                      await refresh();
                      callbacks.current.onChanged?.();
                    } catch (caught) {
                      if (alive.current) setError(message(caught));
                      throw caught;
                    }
                  },
                }
              : {})}
          onCompleteParent={async (parent) => {
            const latest = await port.read();
            await perform({
              base: latest,
              taskId: parent.id,
              title: parent.title,
              change: { type: "status", status: "completed" },
            });
          }}
          onOpenTask={(task) => {
            setHandoff(null);
            openDetails(task);
          }}
          onDismiss={() => setHandoff(null)}
        />
      )}
      {error && (
        <div className="personal-todo-error" role="alert">
          <p>{pending ? "保存结果未确认，本次操作已保留。" : feedbackMessage(error)}</p>
          {pending ? (
            <>
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
            .filter((key) => rooted(query.groups[key]).length > 0)
            .map((key) => (
              <section
                className="personal-todo-group"
                data-group={key}
                key={key}
                aria-labelledby={`personal-group-${key}`}
              >
                <h2 id={`personal-group-${key}`}>
                  <i aria-hidden="true">{icons[key]}</i>
                  {labels[key]} <span>{rooted(query.groups[key]).length}</span>
                </h2>
                <ul>{rooted(query.groups[key]).map(row)}</ul>
              </section>
            ))}
          {!hideHistory && rooted(query.completed).length > 0 && (
            <details className="personal-todo-completed">
              <summary>
                已完成 <span>{rooted(query.completed).length}</span>
              </summary>
              <ul>{rooted(query.completed).map(row)}</ul>
            </details>
          )}
          {!hideHistory && scopedTrash.length > 0 ? (
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
      {rowMenu && menuTask &&
        createPortal(
          <div
            ref={rowMenuPanel}
            className="task-action-popover"
            role="menu"
            aria-label={`任务操作：${menuTask.title}`}
            style={{ left: rowMenu.x, top: rowMenu.y }}
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !(event.target instanceof HTMLButtonElement)
              )
                return;
              const buttons = Array.from(
                rowMenuPanel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
              );
              const index = buttons.indexOf(event.target);
              if (index < 0) return;
              const next =
                event.key === "ArrowDown"
                  ? (index + 1) % buttons.length
                  : event.key === "ArrowUp"
                    ? (index + buttons.length - 1) % buttons.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                buttons[next]?.focus();
              }
            }}
          >
            {menuTask.status !== "completed" && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = { id: menuTask.id, title: menuTask.title };
                    setRowMenu(null);
                    if (onStartPomodoro) {
                      onStartPomodoro(target);
                    } else {
                      writePomodoroState(
                        assignPomodoroTask(
                          readPomodoroState(),
                          target,
                          Date.now(),
                        ),
                      );
                    }
                  }}
                >
                  用番茄钟执行
                </button>
                {!useDailyActions && onScheduleToday && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const target = menuTask;
                      setRowMenu(null);
                      void Promise.resolve(onScheduleToday(target))
                        .then(() => refresh())
                        .catch((caught) => {
                          if (alive.current) setError(message(caught));
                        });
                    }}
                  >
                    加入今日
                  </button>
                )}
                {!menuTask.parentId && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const targetId = menuTask.id;
                      setRowMenu(null);
                      setInspireTaskId(targetId);
                    }}
                  >
                    ✦ 帮我起个头 / 拆子任务
                  </button>
                )}
                {!useDailyActions && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const target = menuTask;
                      setRowMenu(null);
                      if (base)
                        void perform({
                          base,
                          taskId: target.id,
                          title: target.title,
                          change: {
                            type: "status",
                            status: target.status === "in_progress" ? "todo" : "in_progress",
                          },
                        });
                    }}
                  >
                    {menuTask.status === "in_progress" ? "回到待办" : "标记进行中"}
                  </button>
                )}
              </>
            )}
            {!useDailyActions && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = menuTask;
                  setRowMenu(null);
                  openDetails(target);
                }}
              >
                编辑详情
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              title="移到已删除任务，可恢复"
              onClick={() => {
                setRowMenu(null);
                if (base)
                  void perform({
                    base,
                    taskId: menuTask.id,
                    title: menuTask.title,
                    change: { type: "delete" },
                  });
              }}
            >
              删除任务
            </button>
          </div>,
          document.body,
        )}
      {inspireTaskId && (
        <TaskAiInspiration
          taskId={inspireTaskId}
          onClose={() => setInspireTaskId(null)}
          onChanged={() => refreshFromDetails()}
          {...(onPomodoroStarted || onStartPomodoro
            ? {
                onStartedPomodoro: () => {
                  if (onPomodoroStarted) onPomodoroStarted();
                  else {
                    const current = readPomodoroState();
                    if (current.task && onStartPomodoro) onStartPomodoro(current.task);
                  }
                },
              }
            : {})}
        />
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
          onDelete={async () => {
            await perform({base, taskId: selectedTask.id, title: selectedTask.title, change: { type: "delete" }});
          }}
          onOpenProject={onOpenProject}
          onLockedChange={setPanelLocked}
        />
      )}
    </section>
  );
}
