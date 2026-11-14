import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PersonalTaskRead, WorkTask } from "@praxis/application";
import { personalTasks } from "./personal-task-storage";
import { TaskPanelIcon } from "./TaskPanelIcon";

const limit = 20;

export function TaskSubtasks({
  taskId,
  disabled = false,
  onChanged,
}: {
  taskId: string;
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const [base, setBase] = useState<PersonalTaskRead | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const draft = useRef<{ title: string; taskId: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    setBase(null);
    setError("");
    void personalTasks
      .read()
      .then((next) => {
        if (alive.current) setBase(next);
      })
      .catch(() => {
        if (alive.current) setBase(null);
      });
    return () => {
      alive.current = false;
    };
  }, [taskId]);
  const parent = base?.work.tasks.find((task) => task.id === taskId);
  if (!parent || parent.parentId) return null;
  const children = base!.work.tasks
    .filter((task) => task.parentId === taskId && task.status !== "cancelled")
    .sort((a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt));
  const slot = Math.min(children.length + 1, limit);
  async function reload() {
    const next = await personalTasks.read();
    if (alive.current) setBase(next);
    try {
      await onChanged?.();
    } catch {
      /* 子任务已经保存，列表刷新失败时保留面板里的结果 */
    }
    return next;
  }
  async function run(work: (current: PersonalTaskRead) => Promise<void>) {
    if (!base || busy) return;
    setBusy(true);
    setError("");
    try {
      await work(base);
      await reload();
    } catch (caught) {
      if (alive.current)
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text || children.length >= limit) return;
    const same = draft.current?.title === text;
    const id = same ? draft.current!.taskId : crypto.randomUUID();
    draft.current = { title: text, taskId: id };
    await run(async (current) => {
      await personalTasks.create(current, {
        taskId: id,
        title: text,
        notes: "",
        deadline: null,
        projectId: parent!.projectId,
        parentId: parent!.id,
      });
      draft.current = null;
      if (alive.current) setTitle("");
    });
  }
  function toggle(task: WorkTask) {
    void run((current) =>
      personalTasks.change(current, task.id, {
        type: "status",
        status: task.status === "completed" ? "todo" : "completed",
      }).then(() => undefined),
    );
  }
  function remove(task: WorkTask) {
    void run((current) =>
      personalTasks.change(current, task.id, { type: "delete" }).then(
        () => undefined,
      ),
    );
  }
  return (
    <div className="task-panel-field task-subtasks">
      <TaskPanelIcon name="branch" />
      <div className="task-panel-field-body">
        {children.length > 0 && (
          <ul className="task-subtask-list">
            {children.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="task-subtask-check"
                  aria-label={`${task.status === "completed" ? "重新打开" : "完成"}：${task.title}`}
                  aria-pressed={task.status === "completed"}
                  disabled={disabled || busy}
                  onClick={() => toggle(task)}
                >
                  {task.status === "completed" ? "✓" : ""}
                </button>
                <span
                  className={
                    task.status === "completed"
                      ? "task-subtask-title completed"
                      : "task-subtask-title"
                  }
                >
                  {task.title}
                </span>
                <button
                  type="button"
                  className="task-subtask-delete"
                  aria-label={`删除子任务：${task.title}`}
                  disabled={disabled || busy}
                  onClick={() => remove(task)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {children.length < limit && (
          <form onSubmit={(event) => void add(event)}>
            <input
              className="task-subtask-input"
              aria-label={`添加子任务：${parent.title}`}
              placeholder={`添加子任务 (${slot}/20)`}
              value={title}
              disabled={disabled || busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
