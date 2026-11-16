import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  PersonalTaskChange,
  PersonalTaskRead,
  WorkTask,
} from "@praxis/application";
import { personalTasks } from "./personal-task-storage";
import { reorderIds } from "./subtask-order";
import { TaskPanelIcon } from "./TaskPanelIcon";

const limit = 20;

const conflicted = (caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /STATE_CONFLICT|内容已更新|任务已改变|请重新预览|请重新打开/.test(
    message,
  );
};

export function TaskSubtasks({
  taskId,
  disabled = false,
  revision = 0,
  onChanged,
}: {
  taskId: string;
  disabled?: boolean;
  /** Bumps when the open task is saved, so this list drops its stale snapshot. */
  revision?: number;
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
  useEffect(() => {
    if (!baseRef.current) return;
    let active = true;
    void personalTasks
      .read()
      .then((next) => {
        if (!active) return;
        baseRef.current = next;
        setBase(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [revision]);
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
  async function readLatest() {
    const next = await personalTasks.read();
    baseRef.current = next;
    if (alive.current) setBase(next);
    return next;
  }
  async function reload() {
    const next = await readLatest();
    try {
      await onChanged?.();
    } catch {
      /* 子任务已经保存，列表刷新失败时保留面板里的结果 */
    }
    return next;
  }
  async function applyChange(id: string, change: PersonalTaskChange) {
    const first = baseRef.current;
    if (!first) throw Error("请重新读取");
    try {
      await personalTasks.change(first, id, change);
    } catch (caught) {
      if (!conflicted(caught)) throw caught;
      const next = await readLatest();
      await personalTasks.change(next, id, change);
    }
  }
  function showFailure(caught: unknown) {
    if (!alive.current) return;
    if (conflicted(caught)) {
      void readLatest().catch(() => undefined);
      setError("列表已更新，请再试一次");
      return;
    }
    setError(caught instanceof Error ? caught.message : String(caught));
  }
  function add(raw: string) {
    const text = raw.trim();
    if (!text || count >= limit) return;
    const id = crypto.randomUUID();
    setTitle((current) => (current.trim() === text ? "" : current));
    setOptimistic((items) => [...items, { id, title: text }]);
    holdFocus();
    enqueue(async () => {
      const draft = {
        taskId: id,
        title: text,
        notes: "",
        deadline: null,
      };
      try {
        const current = baseRef.current;
        const owner = current?.work.tasks.find((task) => task.id === taskId);
        if (!current || !owner) throw Error("父任务已不存在，请重新读取");
        const create = (
          base: PersonalTaskRead,
          projectId: string | null,
          parentId: string,
        ) =>
          personalTasks.create(base, { ...draft, projectId, parentId });
        try {
          await create(current, owner.projectId, owner.id);
        } catch (caught) {
          if (!conflicted(caught)) throw caught;
          const next = await readLatest();
          const parent = next.work.tasks.find((task) => task.id === taskId);
          if (!parent) throw Error("父任务已不存在，请重新读取");
          await create(next, parent.projectId, parent.id);
        }
        if (alive.current) setError("");
        await reload();
        holdFocus();
      } catch (caught) {
        showFailure(caught);
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
      if (!baseRef.current) return;
      try {
        await applyChange(task.id, {
          type: "status",
          status: task.status === "completed" ? "todo" : "completed",
        });
        if (alive.current) setError("");
        await reload();
      } catch (caught) {
        showFailure(caught);
      }
    });
  }
  function remove(task: WorkTask) {
    enqueue(async () => {
      if (!baseRef.current) return;
      try {
        await applyChange(task.id, { type: "delete" });
        if (alive.current) setError("");
        await reload();
      } catch (caught) {
        showFailure(caught);
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
        await applyChange(taskId, {
          type: "reorder",
          orderedIds: next,
        });
        if (alive.current) setError("");
        await reload();
      } catch (caught) {
        showFailure(caught);
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
