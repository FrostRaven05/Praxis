import { useState } from "react";
import {
  calendarDate,
  taskStates,
  projectTree,
  type ProjectTask,
} from "@praxis/application";
import { workspace } from "./storage";
import { TaskDetailsButton } from "./TaskDetailsButton";
const columns = ["todo", "in_progress", "blocked", "completed"];
export function KanbanView({
  tasks,
  onSaved,
}: {
  tasks: ProjectTask[];
  onSaved: () => Promise<unknown>;
}) {
  const leaves = projectTree(tasks).filter((t) => !t.hasChildren);
  const [transition, setTransition] = useState<{
      task: ProjectTask;
      status: string;
    } | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [showCancelled, setShowCancelled] = useState(false);
  function choose(task: ProjectTask, status: string) {
    if (task.status === status) return;
    setTransition({ task, status });
    setReason("");
    setError("");
  }
  async function save() {
    if (!transition) return;
    setBusy(true);
    setError("");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await workspace.execute({
        kind: "status",
        taskId: transition.task.taskId,
        expectedVersion: transition.task.version,
        status: transition.status,
        reason,
        date: calendarDate(new Date(), zone),
        timeZone: zone,
      });
      await onSaved();
      setTransition(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function card(task: ProjectTask) {
    return (
      <article
        className="kanban-card"
        key={task.taskId}
        draggable={!busy && !transition}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/praxis-task", task.taskId);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <strong>{task.title}</strong>
        <p className="task-meta">
          {task.executionDate ? "每日安排：" + task.executionDate : "尚未安排"}
          {task.statusReason && " · " + task.statusReason}
        </p>
        <TaskDetailsButton
          taskId={task.taskId}
          onSaved={onSaved}
          disabled={busy}
        />
        <label>
          切换状态
          <select
            disabled={busy || !!transition}
            value={task.status}
            onChange={(e) => choose(task, e.target.value)}
          >
            {Object.entries(taskStates).map(([k, v]) => (
              <option
                key={k}
                value={k}
                disabled={task.status === "completed" && k === "cancelled"}
              >
                {v}
              </option>
            ))}
            {task.status === "cancelled" && (
              <option value="restore">恢复取消前状态</option>
            )}
          </select>
        </label>
      </article>
    );
  }
  return (
    <section aria-label="项目看板">
      <p className="task-meta">
        拖动叶子任务到目标列，或使用状态菜单。汇总父项的进度在任务视图显示。
      </p>
      {transition && (
        <form
          className="workspace-editor"
          aria-label="确认状态变更"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <h3>
              {transition.task.title} →{" "}
              {taskStates[transition.status] ?? "恢复取消前状态"}
            </h3>
            {["blocked", "cancelled"].includes(transition.status) && (
              <label>
                原因
                <textarea
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {transition.status === "completed" && (
              <p>按实际完成日记录结果。未安排任务也会出现在今日已完成中。</p>
            )}
            {transition.task.status === "completed" && (
              <p>此次变更会撤销原完成记录，历史仍保留。</p>
            )}
            <button>确认状态变更</button>{" "}
            <button type="button" onClick={() => setTransition(null)}>
              取消
            </button>
          </fieldset>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      <div className="kanban-board">
        {columns.map((state) => (
          <section
            key={state}
            className="kanban-column"
            data-status={state}
            onDragOver={(e) => {
              if (!busy && !transition) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (busy || transition) return;
              const task = leaves.find(
                (t) =>
                  t.taskId ===
                  e.dataTransfer.getData("application/praxis-task"),
              );
              if (task) choose(task, state);
            }}
          >
            <h3>
              {taskStates[state]}{" "}
              <small>{leaves.filter((t) => t.status === state).length}</small>
            </h3>
            {leaves.filter((t) => t.status === state).map(card)}
          </section>
        ))}
      </div>
      <button onClick={() => setShowCancelled(!showCancelled)}>
        {showCancelled ? "收起" : "查看"}已取消任务（
        {leaves.filter((t) => t.status === "cancelled").length}）
      </button>
      {showCancelled && (
        <div className="cancelled-tasks">
          {leaves.filter((t) => t.status === "cancelled").map(card)}
        </div>
      )}
    </section>
  );
}
