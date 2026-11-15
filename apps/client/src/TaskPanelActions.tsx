import { useState } from "react";
import { personalTasks } from "./personal-task-storage";
import { TaskAiInspiration } from "./TaskAiInspiration";

const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function TaskPanelActions({
  taskId,
  disabled = false,
  onDelete,
  onChanged,
  onClose,
  onRefined,
}: {
  taskId: string;
  disabled?: boolean;
  onDelete?: () => Promise<void>;
  onChanged: () => Promise<unknown> | void;
  onClose: () => void;
  onRefined?: (value: { title: string; notes: string }) => void;
}) {
  const [inspiring, setInspiring] = useState(false);
  const [busy, setBusy] = useState<"delete" | null>(null);
  const [error, setError] = useState("");
  const locked = disabled || busy !== null;

  async function remove() {
    if (locked) return;
    setBusy("delete");
    setError("");
    try {
      if (onDelete) {
        await onDelete();
        return;
      }
      const base = await personalTasks.read();
      await personalTasks.change(base, taskId, { type: "delete" });
      await onChanged();
      onClose();
    } catch (caught) {
      setError(text(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="task-panel-actions">
      {inspiring && (
        <TaskAiInspiration
          taskId={taskId}
          onClose={() => setInspiring(false)}
          onChanged={onChanged}
          {...(onRefined ? { onRefined } : {})}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="task-panel-ai"
        disabled={locked}
        aria-label="AI 切分子任务"
        title="AI 切分子任务"
        onClick={() => setInspiring(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 18h6" />
          <path d="M10 21h4" />
          <path d="M8.2 14.2A6 6 0 1 1 15.8 14c-.6.7-1.1 1.5-1.3 2.4H9.5c-.2-.9-.7-1.7-1.3-2.2Z" />
          <path d="M18.2 3.2 19 5l1.8.8L19 6.6l-.8 1.8-.8-1.8L15.6 5.8 17.4 5Z" />
        </svg>
      </button>
      <button
        type="button"
        className="task-panel-delete"
        disabled={locked}
        aria-label={busy === "delete" ? "正在删除" : "删除任务"}
        title={busy === "delete" ? "正在删除" : "删除任务"}
        onClick={() => void remove()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M9 7V4h6v3" />
          <path d="M7 7l1 13h8l1-13" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  );
}
