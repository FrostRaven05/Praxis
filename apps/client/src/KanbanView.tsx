import { feedbackMessage } from "./feedback-message";
import { useEffect, useId, useRef, useState } from "react";
import {
  calendarDate,
  taskStates,
  projectTree,
  type ProjectTask,
  type WorkspaceAction,
} from "@praxis/application";
import { workspace } from "./storage";
import { TaskDetailsButton } from "./TaskDetailsButton";
import { TaskCompletionButton } from "./TaskCompletionButton";
import { animateTaskCompletion } from "./task-completion-motion";

const columns = ["todo", "in_progress", "blocked", "completed"];
type StatusAction = Extract<WorkspaceAction, { kind: "status" }>;
type StatusRequest = {
  action: StatusAction;
  title: string;
  committed: boolean;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function KanbanView({
  tasks,
  onSaved,
  showCancelled = false,
  onBusyChange,
  disabled = false,
}: {
  tasks: ProjectTask[];
  onSaved: () => Promise<unknown>;
  showCancelled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const leaves = projectTree(tasks).filter((task) => task.depth === 0);
  const [transition, setTransition] = useState<{
    task: ProjectTask;
    status: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState<StatusRequest | null>(null);
  const [error, setError] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const headingId = useId();
  const ownedBusy = busy || !!transition || !!pending;
  const locked = disabled || ownedBusy;
  useEffect(() => {
    onBusyChange?.(ownedBusy);
    return () => onBusyChange?.(false);
  }, [ownedBusy, onBusyChange]);

  function request(
    task: ProjectTask,
    status: string,
    statusReason = "",
  ): StatusRequest {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      action: {
        kind: "status",
        taskId: task.taskId,
        expectedVersion: task.version,
        status,
        reason: statusReason,
        date: calendarDate(new Date(), zone),
        timeZone: zone,
      },
      title: task.title,
      committed: false,
    };
  }

  async function save(change: StatusRequest) {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    setPending(change);
    setError("");
    let clearMotion = () => {};
    try {
      // Keep the original version and date when retrying an uncertain reply.
      // If only the refresh failed, retry the read without repeating the write.
      if (!change.committed) {
        await workspace.execute(change.action);
        change.committed = true;
        if (change.action.status === "completed") clearMotion = await animateTaskCompletion(change.action.taskId);
      }
      await onSaved();
      setPending(null);
      setTransition(null);
      setReason("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      clearMotion();
      busyRef.current = false;
      setBusy(false);
    }
  }

  function choose(task: ProjectTask, status: string) {
    if (locked || busyRef.current || task.status === status) return;
    if (task.status === "cancelled" && status !== "restore") return;
    if (task.status === "completed" && status === "cancelled") return;
    setError("");
    if (status === "blocked" || status === "cancelled") {
      setTransition({ task, status });
      setReason("");
    } else {
      void save(request(task, status));
    }
  }

  async function reload() {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onSaved();
      setPending(null);
      setTransition(null);
      setReason("");
      setError("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function card(task: ProjectTask) {
    const parent = tasks.find(
      (candidate) => candidate.taskId === task.parentTaskId,
    );
    return (
      <article
        className={`kanban-card${task.status === "completed" ? " completed" : ""}${task.status === "cancelled" ? " cancelled" : ""}`}
        key={task.taskId}
        draggable={!locked && task.status !== "cancelled"}
        data-task-id={task.taskId}
        data-completion-row=""
        onDragStart={(event) => {
          if (locked || busyRef.current || task.status === "cancelled") {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData("application/praxis-task", task.taskId);
          event.dataTransfer.effectAllowed = "move";
          setDraggedId(task.taskId);
        }}
        onDragEnd={() => {
          setDraggedId(null);
          setDropTarget(null);
        }}
      >
        <div className="kanban-card-heading">
          {task.status !== "cancelled" ? (
            <TaskCompletionButton
              className="kanban-completion-toggle"
              completed={task.status === "completed"}
              title={task.title}
              disabled={locked}
              busy={busy && pending?.action.taskId === task.taskId}
              onToggle={() =>
                choose(task, task.status === "completed" ? "todo" : "completed")
              }
            />
          ) : (
            <span className="kanban-cancelled-mark" aria-label="已取消">
              −
            </span>
          )}
          <TaskDetailsButton
            taskId={task.taskId}
            disabled={locked}
            label={task.title}
            className="kanban-task-title"
            completionTitle
          />
        </div>
        {(parent || task.executionDate || task.important || tasks.some((child) => child.parentTaskId === task.taskId)) && (
          <div className="kanban-card-meta">
            {tasks.some((child) => child.parentTaskId === task.taskId) && (
              <span>
                {tasks.filter((child) => child.parentTaskId === task.taskId && child.status !== "cancelled").length} 个子任务
              </span>
            )}
            {parent && <span title={parent.title}>{parent.title}</span>}
            {task.executionDate && (
              <time dateTime={task.executionDate}>{task.executionDate}</time>
            )}
            {task.important && (
              <span
                className="kanban-important"
                title="重要任务"
                aria-label="重要任务"
              >
                ★
              </span>
            )}
          </div>
        )}
        {task.statusReason && (
          <p className="kanban-card-reason">{task.statusReason}</p>
        )}
      </article>
    );
  }

  const states =
    showCancelled && leaves.some((task) => task.status === "cancelled")
      ? [...columns, "cancelled"]
      : columns;
  return (
    <section className="project-board" aria-label="项目看板" aria-busy={busy}>
      {transition && (
        <form
          className="kanban-reason-form"
          aria-label={
            transition.status === "blocked" ? "阻塞原因" : "取消任务原因"
          }
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim())
              void save(
                pending ??
                  request(transition.task, transition.status, reason.trim()),
              );
          }}
        >
          <label htmlFor={headingId + "-reason"}>
            {transition.status === "blocked" ? "阻塞" : "取消"}：
            {transition.task.title}
          </label>
          <div className="kanban-reason-controls">
            <input
              autoFocus
              id={headingId + "-reason"}
              required
              value={reason}
              placeholder={
                transition.status === "blocked"
                  ? "填写阻塞原因"
                  : "填写取消原因"
              }
              disabled={busy || disabled || !!pending}
              onChange={(event) => setReason(event.target.value)}
            />
            <button type="submit" disabled={busy || disabled || !reason.trim()}>
              {busy ? "保存中…" : pending ? "重试" : "保存"}
            </button>
            <button
              type="button"
              disabled={busy || disabled || !!pending}
              onClick={() => {
                setTransition(null);
                setReason("");
                setPending(null);
                setError("");
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {error && (
        <div className="kanban-error" role="alert">
          <p>
            {pending?.committed
              ? "状态已保存，未能刷新看板。"
              : "未能更新任务状态。"}{" "}
            {feedbackMessage(error)}
          </p>
          {pending && !transition && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void save(pending)}
            >
              重试
            </button>
          )}
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void reload()}
          >
            重新读取
          </button>
        </div>
      )}
      <div className="kanban-board">
        {states.map((status) => {
          const cards = leaves.filter((task) => task.status === status);
          const dragged = leaves.find((task) => task.taskId === draggedId);
          const canDrop =
            !locked &&
            dragged &&
            dragged.status !== status &&
            !(dragged.status === "completed" && status === "cancelled");
          return (
            <section
              key={status}
              className={`kanban-column${dropTarget === status ? " kanban-drop-target" : ""}`}
              data-status={status}
              aria-labelledby={headingId + "-" + status}
              onDragOver={(event) => {
                if (canDrop) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTarget(status);
                }
              }}
              onDragLeave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setDropTarget((target) =>
                    target === status ? null : target,
                  );
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDropTarget(null);
                setDraggedId(null);
                if (locked || busyRef.current) return;
                const task = leaves.find(
                  (candidate) =>
                    candidate.taskId ===
                    event.dataTransfer.getData("application/praxis-task"),
                );
                if (task) choose(task, status);
              }}
            >
              <h3 id={headingId + "-" + status}>
                {status === "cancelled" ? "已取消" : taskStates[status]}
                <small>{cards.length}</small>
              </h3>
              {cards.map(card)}
              {!cards.length && <p className="kanban-empty">暂无任务</p>}
            </section>
          );
        })}
      </div>
    </section>
  );
}
