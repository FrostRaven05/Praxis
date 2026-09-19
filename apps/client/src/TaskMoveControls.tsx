import { useState } from "react";
import {
  projectTree,
  type Project,
  type ProjectTask,
} from "@praxis/application";
import { workspace } from "./storage";
export function TaskMoveControls({
  task,
  tasks,
  project,
  onSaved,
}: {
  task: ProjectTask;
  tasks: ProjectTask[];
  project: Project;
  onSaved: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [parent, setParent] = useState(task.parentTaskId ?? ""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [base, setBase] = useState(project);
  const tree = projectTree(tasks),
    siblings = tree.filter(
      (t) => (t.parentTaskId ?? null) === (task.parentTaskId ?? null),
    ),
    index = siblings.findIndex((t) => t.taskId === task.taskId);
  const descendants = new Set([task.taskId]);
  for (const t of tree)
    if (t.parentTaskId && descendants.has(t.parentTaskId))
      descendants.add(t.taskId);
  async function move(
    target: string | null,
    before: string | null,
    revision: number,
    confirm = false,
  ) {
    setBusy(true);
    setError("");
    try {
      await workspace.execute({
        kind: "move",
        projectId: project.id,
        expectedPlanVersion: revision,
        taskId: task.taskId,
        parentTaskId: target,
        beforeTaskId: before,
        confirmSummaryPlan: confirm,
      });
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="task-move">
      <button
        aria-label="上移任务"
        disabled={busy || index === 0}
        onClick={() =>
          void move(
            task.parentTaskId ?? null,
            siblings[index - 1]!.taskId,
            project.planVersion ?? 0,
          )
        }
      >
        ↑
      </button>
      <button
        aria-label="下移任务"
        disabled={busy || index === siblings.length - 1}
        onClick={() =>
          void move(
            task.parentTaskId ?? null,
            siblings[index + 2]?.taskId ?? null,
            project.planVersion ?? 0,
          )
        }
      >
        ↓
      </button>
      <button
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          setBase(project);
          setParent(task.parentTaskId ?? "");
          setConfirmed(false);
          setError("");
        }}
      >
        移动层级
      </button>
      {open && (
        <form
          aria-label="移动任务"
          onSubmit={(e) => {
            e.preventDefault();
            void move(parent || null, null, base.planVersion ?? 0, confirmed);
          }}
        >
          <label>
            目标父任务
            <select
              disabled={busy}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">项目根层级</option>
              {tree
                .filter(
                  (t) =>
                    !descendants.has(t.taskId) &&
                    !["completed", "cancelled"].includes(t.status),
                )
                .map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
          {parent && tasks.find((t) => t.taskId === parent)?.executionDate && (
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              确认目标父任务转为汇总项，其已有安排退出执行清单，历史保留
            </label>
          )}
          <p className="task-meta">
            整棵子树一起移动，放到目标层级末尾；任务日期保持不变。
          </p>
          <button disabled={busy}>确认移动</button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
