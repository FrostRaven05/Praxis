import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PersonalTaskRead, WorkTask } from "@praxis/application";
import { personalTasks } from "./personal-task-storage";
import { reorderIds } from "./subtask-order";
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
  const [error, setError] = useState("");
  const [optimistic, setOptimistic] = useState<{ id: string; title: string }[]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [saving, setSaving] = useState(0);
  const alive = useRef(true);
  const baseRef = useRef<PersonalTaskRead | null>(null);
  const savingRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOnCommit = useRef(false);
  const tail = useRef(Promise.resolve());
  baseRef.current = base;
  useEffect(() => {
    alive.current = true;
    setBase(null);
    setError("");
    setOptimistic([]);
    setPreview(null);
    void personalTasks
      .read()
      .then((next) => {
        if (!alive.current) return;
        baseRef.current = next;
        setBase(next);
      })
      .catch(() => {
        if (alive.current) setBase(null);
      });
    return () => {
      alive.current = false;
    };
  }, [taskId]);
  useLayoutEffect(() => {
    if (!focusOnCommit.current) return;
    focusOnCommit.current = false;
    inputRef.current?.focus();
  });
  function holdFocus() {
    focusOnCommit.current = true;
    inputRef.current?.focus();
  }
  function enqueue(work: () => Promise<void>) {
    savingRef.current += 1;
    if (alive.current) setSaving((count) => count + 1);
    const run = tail.current.then(work, work);
    tail.current = run.then(
      () => undefined,
      () => undefined,
    );
    void run.finally(() => {
      savingRef.current = Math.max(0, savingRef.current - 1);
      if (alive.current) setSaving((count) => Math.max(0, count - 1));
    });
  }
  const parent = base?.work.tasks.find((task) => task.id === taskId);
  if (!parent || parent.parentId) return null;
  const saved = base!.work.tasks
    .filter((task) => task.parentId === taskId && task.status !== "cancelled")
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const savedIds = saved.map((task) => task.id);
  const ordered =
    preview &&
    preview.length === saved.length &&
    preview.every((id) => savedIds.includes(id))
      ? preview.flatMap((id) => {
          const task = saved.find((item) => item.id === id);
          return task ? [task] : [];
        })
      : saved;
  const pending = optimistic.filter((item) => !savedIds.includes(item.id));
  const count = ordered.length + pending.length;
  const slot = Math.min(count + 1, limit);
  async function reload() {
    const next = await personalTasks.read();
    baseRef.current = next;
    if (alive.current) setBase(next);
    try {
      await onChanged?.();
    } catch {
      /* 子任务已经保存，列表刷新失败时保留面板里的结果 */
    }
    return next;
  }
  function add(raw: string) {
    const text = raw.trim();
    if (!text || count >= limit) return;
    const id = crypto.randomUUID();
    setTitle((current) => (current.trim() === text ? "" : current));
    setOptimistic((items) => [...items, { id, title: text }]);
    holdFocus();
    enqueue(async () => {
      try {
        const current = baseRef.current;
        const owner = current?.work.tasks.find((task) => task.id === taskId);
        if (!current || !owner) throw Error("父任务已不存在，请重新读取");
        await personalTasks.create(current, {
          taskId: id,
          title: text,
          notes: "",
          deadline: null,
          projectId: owner.projectId,
          parentId: owner.id,
        });
        await reload();
        holdFocus();
      } catch (caught) {
        if (!alive.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setTitle((current) => (current.trim() ? current : text));
        holdFocus();
      } finally {
        if (alive.current)
          setOptimistic((items) => items.filter((item) => item.id !== id));
      }
    });
  }
  function toggle(task: WorkTask) {
    enqueue(async () => {
      const current = baseRef.current;
      if (!current) return;
      try {
        await personalTasks.change(current, task.id, {
          type: "status",
          status: task.status === "completed" ? "todo" : "completed",
        });
        await reload();
      } catch (caught) {
        if (alive.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
  }
  function remove(task: WorkTask) {
    enqueue(async () => {
      const current = baseRef.current;
      if (!current) return;
      try {
        await personalTasks.change(current, task.id, { type: "delete" });
        await reload();
      } catch (caught) {
        if (alive.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
  }
  function commitOrder(from: string, to: string, after: boolean) {
    const next = reorderIds(
      ordered.map((task) => task.id),
      from,
      to,
      after,
    );
    if (!next || savingRef.current > 0) return;
    setPreview(next);
    enqueue(async () => {
      try {
        const current = baseRef.current;
        if (!current) throw Error("请重新读取");
        await personalTasks.change(current, taskId, {
          type: "reorder",
          orderedIds: next,
        });
        await reload();
      } catch (caught) {
        if (alive.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (alive.current) setPreview(null);
      }
    });
  }
  return (
    <div className="task-panel-field task-subtasks">
      <TaskPanelIcon name="branch" />
      <div className="task-panel-field-body">
        {(ordered.length > 0 || pending.length > 0) && (
          <ul className="task-subtask-list">
            {ordered.map((task) => (
              <li
                key={task.id}
                draggable={!disabled && saving === 0}
                className={[
                  dragging === task.id ? "is-dragging" : "",
                  drop?.id === task.id
                    ? drop.after
                      ? "drop-after"
                      : "drop-before"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragStart={(event) => {
                  if (event.target instanceof Element && event.target.closest("button")) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData("text/plain", task.id);
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(task.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDrop(null);
                }}
                onDragOver={(event) => {
                  if (!dragging || dragging === task.id || disabled) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const box = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > box.top + box.height / 2;
                  setDrop((current) =>
                    current?.id === task.id && current.after === after
                      ? current
                      : { id: task.id, after },
                  );
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragging;
                  const after =
                    drop?.id === task.id
                      ? drop.after
                      : event.clientY >
                        event.currentTarget.getBoundingClientRect().top +
                          event.currentTarget.getBoundingClientRect().height / 2;
                  setDragging(null);
                  setDrop(null);
                  if (from) commitOrder(from, task.id, after);
                }}
              >
                <span
                  className="task-subtask-grip"
                  title="拖拽排序"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="task-subtask-check"
                  aria-label={`${task.status === "completed" ? "重新打开" : "完成"}：${task.title}`}
                  aria-pressed={task.status === "completed"}
                  disabled={disabled || saving > 0}
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
                  disabled={disabled || saving > 0}
                  onClick={() => remove(task)}
                >
                  ×
                </button>
              </li>
            ))}
            {pending.map((item) => (
              <li key={item.id} className="is-pending">
                <span className="task-subtask-grip" aria-hidden="true" />
                <span className="task-subtask-check" aria-hidden="true" />
                <span className="task-subtask-title">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
        {count < limit && (
          <input
            ref={inputRef}
            className="task-subtask-input"
            aria-label={`添加子任务：${parent.title}`}
            placeholder={`添加子任务 (${slot}/20)`}
            value={title}
            disabled={disabled}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              void add(event.currentTarget.value);
            }}
          />
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
