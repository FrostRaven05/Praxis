import { useRef, useState, type DragEvent } from "react";
import {
  calendarDate,
  projectTree,
  taskStates,
  type Project,
  type ProjectTask,
} from "@praxis/application";
import { workspace } from "./storage";
import { planning } from "./PlanningPanel";
import { TaskDetailsButton } from "./TaskDetailsButton";
import { TaskActionMenu } from "./TaskActionMenu";
import { TaskMoveControls } from "./TaskMoveControls";
import { SubtaskComposer } from "./SubtaskComposer";

export function ProjectTaskList({
  project,
  tasks,
  busy,
  showCancelled,
  showCompleted,
  onRun,
  onSaved,
  onDay,
}: {
  project: Project;
  tasks: ProjectTask[];
  busy: boolean;
  showCancelled: boolean;
  showCompleted: boolean;
  onRun: (action: () => Promise<void>) => Promise<void>;
  onSaved: () => Promise<unknown>;
  onDay: (date: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<{
    id: string;
    position: "before" | "after" | "inside";
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    taskId: string;
    parent: ProjectTask;
    version: number;
  } | null>(null);
  const source = useRef<string | null>(null);
  const tree = projectTree(tasks);
  const hidden = new Set<string>();
  const visible = tree.filter((task) => {
    const parentHidden =
      !!task.parentTaskId &&
      (hidden.has(task.parentTaskId) || collapsed.has(task.parentTaskId));
    const hiddenState =
      (!showCancelled && task.status === "cancelled") ||
      // Expanded branches retain their completed children so progress remains
      // inspectable and completion can be undone without changing view options.
      (!showCompleted && !task.parentTaskId && task.status === "completed");
    if (parentHidden || hiddenState) hidden.add(task.taskId);
    return !parentHidden && !hiddenState;
  });
  function clearDrag() {
    source.current = null;
    setDragging(null);
    setTarget(null);
  }
  function accepts(task: ProjectTask) {
    if (
      busy ||
      pendingMove ||
      !source.current ||
      task.taskId === source.current
    )
      return false;
    let ancestor: ProjectTask | undefined = task;
    while (ancestor) {
      if (ancestor.taskId === source.current) return false;
      ancestor = tree.find((item) => item.taskId === ancestor?.parentTaskId);
    }
    return true;
  }
  function dropPosition(
    event: DragEvent<HTMLElement>,
    task: ProjectTask,
  ): "before" | "after" | "inside" {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    if (
      fraction >= 0.3 &&
      fraction <= 0.7 &&
      !["completed", "cancelled"].includes(task.status)
    )
      return "inside";
    return fraction < 0.5 ? "before" : "after";
  }
  async function persistMove(
    taskId: string,
    parentTaskId: string | null,
    beforeTaskId: string | null,
    version: number,
    confirmSummaryPlan = false,
  ) {
    await onRun(async () => {
      await workspace.execute({
        kind: "move",
        projectId: project.id,
        expectedPlanVersion: version,
        taskId,
        parentTaskId,
        beforeTaskId,
        confirmSummaryPlan,
      });
      await onSaved();
      setPendingMove(null);
      if (parentTaskId)
        setCollapsed((previous) => {
          const next = new Set(previous);
          next.delete(parentTaskId);
          return next;
        });
    });
  }
  async function reorder(
    task: ProjectTask,
    position: "before" | "after" | "inside",
  ) {
    const taskId = source.current;
    if (!taskId || !accepts(task)) {
      clearDrag();
      return;
    }
    const parentTaskId =
      position === "inside" ? task.taskId : (task.parentTaskId ?? null);
    const siblings = tree.filter(
      (item) =>
        (item.parentTaskId ?? null) === parentTaskId && item.taskId !== taskId,
    );
    const index = siblings.findIndex((item) => item.taskId === task.taskId);
    const beforeTaskId =
      position === "inside"
        ? null
        : position === "after"
          ? (siblings[index + 1]?.taskId ?? null)
          : task.taskId;
    clearDrag();
    if (
      position === "inside" &&
      !tree.some((item) => item.parentTaskId === task.taskId) &&
      task.executionDate
    ) {
      setPendingMove({
        taskId,
        parent: task,
        version: project.planVersion ?? 0,
      });
      return;
    }
    await persistMove(
      taskId,
      parentTaskId,
      beforeTaskId,
      project.planVersion ?? 0,
    );
  }
  async function complete(task: ProjectTask) {
    await onRun(async () => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await workspace.execute({
        kind: "status",
        taskId: task.taskId,
        expectedVersion: task.version,
        status: task.status === "completed" ? "todo" : "completed",
        reason: "",
        date: calendarDate(new Date(), zone),
        timeZone: zone,
      });
      await onSaved();
    });
  }
  return (
    <>
      <p className="sr-only" id="project-reorder-help">
        拖到任务上方或下方排序，拖到中间成为子任务；也可通过更多操作调整顺序和层级。
      </p>
      {pendingMove && (
        <div
          className="project-move-confirm"
          role="group"
          aria-label="确认移动为子任务"
        >
          <p>
            “{pendingMove.parent.title}
            ”将变为父任务，其已有每日安排会移出执行清单，历史记录保留。
          </p>
          <button disabled={busy} onClick={() => setPendingMove(null)}>
            取消移动
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void persistMove(
                pendingMove.taskId,
                pendingMove.parent.taskId,
                null,
                pendingMove.version,
                true,
              )
            }
          >
            确认移动
          </button>
        </div>
      )}
      <ul className="task-list project-tasks" aria-label="项目任务列表">
        {visible.map((task) => (
          <li
            key={task.taskId}
            data-task-id={task.taskId}
            className={`inbox-row tree-task${task.status === "completed" ? " completed" : ""}${dragging === task.taskId ? " is-dragging" : ""}${target?.id === task.taskId ? " drop-" + target.position : ""}`}
            style={{ marginLeft: Math.min(task.depth, 8) * 18 }}
            draggable={!busy && !pendingMove}
            onDragStart={(event) => {
              if (
                busy ||
                pendingMove ||
                (event.target as HTMLElement).closest(
                  "input,textarea,select,.task-action-popover",
                )
              ) {
                event.preventDefault();
                return;
              }
              source.current = task.taskId;
              setDragging(task.taskId);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "application/praxis-project-task",
                task.taskId,
              );
            }}
            onDragEnd={clearDrag}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setTarget(null);
            }}
            onDragOver={(event) => {
              if (!accepts(task)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTarget({
                id: task.taskId,
                position: dropPosition(event, task),
              });
            }}
            onDrop={(event) => {
              event.preventDefault();
              void reorder(task, dropPosition(event, task));
            }}
          >
            <span className="project-task-grip" aria-hidden="true">
              <svg viewBox="0 0 12 20">
                <path d="M4 4h.1M8 4h.1M4 10h.1M8 10h.1M4 16h.1M8 16h.1" />
              </svg>
            </span>
            {task.hasChildren ? (
              <button
                className="project-task-fold"
                disabled={busy}
                aria-label={
                  (collapsed.has(task.taskId)
                    ? "展开子任务："
                    : "收起子任务：") + task.title
                }
                aria-expanded={!collapsed.has(task.taskId)}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(task.taskId)) next.delete(task.taskId);
                    else next.add(task.taskId);
                    return next;
                  })
                }
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d={
                      collapsed.has(task.taskId)
                        ? "m9 6 6 6-6 6"
                        : "m6 9 6 6 6-6"
                    }
                  />
                </svg>
              </button>
            ) : task.status !== "cancelled" ? (
              <button
                className="completion-toggle"
                aria-label={
                  task.status === "completed" ? "撤销完成" : "标为完成"
                }
                aria-pressed={task.status === "completed"}
                title={task.title}
                disabled={busy}
                onClick={() => void complete(task)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  {task.status === "completed" && (
                    <path className="completion-check" d="m7.5 12 3 3 6-6" />
                  )}
                </svg>
              </button>
            ) : (
              <span className="project-task-cancelled" aria-label="已取消">
                ×
              </span>
            )}
            <div className="project-task-content">
              <div className="project-task-heading">
                <TaskDetailsButton
                  taskId={task.taskId}
                  disabled={busy}
                  label={task.title}
                  className="project-task-title"
                />
                {task.important && (
                  <span
                    className="task-important"
                    title="重要任务"
                    aria-label="重要任务"
                  >
                    ★
                  </span>
                )}
              </div>
              {(task.hasChildren ||
                task.executionDate ||
                task.completionDate ||
                ["in_progress", "blocked", "cancelled"].includes(
                  task.status,
                )) && (
                <p className="task-meta">
                  {task.hasChildren ? (
                    <span aria-label="子任务完成进度">
                      {task.leafDone} / {task.leafTotal}
                    </span>
                  ) : (
                    <>
                      {(task.completionDate || task.executionDate) && (
                        <span className="project-task-date">
                          {task.completionDate ?? task.executionDate}
                        </span>
                      )}
                      {["in_progress", "blocked", "cancelled"].includes(
                        task.status,
                      ) && <span>{taskStates[task.status]}</span>}
                      {task.statusReason && (
                        <span
                          className="project-task-reason"
                          title={task.statusReason}
                        >
                          {task.statusReason}
                        </span>
                      )}
                    </>
                  )}
                </p>
              )}
            </div>
            <TaskActionMenu
              className="project-task-actions"
              key={task.taskId + ":" + task.version}
              label={"更多操作：" + task.title}
              disabled={busy}
            >
              <div className="project-task-action-menu">
                <TaskDetailsButton taskId={task.taskId} disabled={busy} />
                {!task.hasChildren &&
                  (task.executionDate ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        onDay(task.completionDate ?? task.executionDate!)
                      }
                    >
                      {task.status === "completed"
                        ? "查看完成记录"
                        : "查看安排"}
                    </button>
                  ) : ["todo", "in_progress", "blocked"].includes(
                      task.status,
                    ) ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void onRun(async () => {
                          const zone =
                            Intl.DateTimeFormat().resolvedOptions().timeZone;
                          await planning.schedule(
                            task,
                            calendarDate(new Date(), zone),
                            zone,
                          );
                          await onSaved();
                        })
                      }
                    >
                      加入今日
                    </button>
                  ) : null)}
                <TaskMoveControls
                  task={task}
                  tasks={tasks}
                  project={project}
                  onSaved={onSaved}
                />
                <SubtaskComposer task={task} onSaved={onSaved} />
              </div>
            </TaskActionMenu>
          </li>
        ))}
      </ul>
      {tasks.length > 0 && visible.length === 0 && (
        <p className="project-list-empty">
          {tasks.every((task) => task.status === "completed")
            ? "所有任务已完成"
            : "暂无待办任务"}
        </p>
      )}
    </>
  );
}
