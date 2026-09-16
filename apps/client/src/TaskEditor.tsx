import { useState } from "react";
import {
  EditTask,
  type DailyTask,
  type EditReceipt,
} from "@praxis/application";
import { editStorage } from "./storage";
const editor = new EditTask(editStorage);
export function TaskEditor({
  task,
  onSaved,
}: {
  task: DailyTask;
  onSaved: (receipt: EditReceipt) => Promise<void>;
}) {
  // Keep the version originally presented with this draft; background refresh cannot silently overwrite it.
  const [base] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState(task.executionDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="task-editor"
      aria-label="编辑任务"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError("");
        void editor
          .save(
            base,
            title,
            date,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          )
          .then(onSaved)
          .catch((error) =>
            setError(error instanceof Error ? error.message : String(error)),
          )
          .finally(() => setSaving(false));
      }}
    >
      <label htmlFor="edit-title">任务标题</label>
      <input
        id="edit-title"
        aria-label="编辑任务标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={saving}
      />
      <label htmlFor="edit-date">安排日期</label>
      <input
        id="edit-date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        disabled={saving || base.status === "completed"}
      />
      {base.status === "completed" && <p>已完成任务保留原安排日期。</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={
          saving || (title.trim() === base.title && date === base.executionDate)
        }
      >
        {saving ? "保存中…" : "保存修改"}
      </button>
    </form>
  );
}
export const undoEdit = (receipt: EditReceipt) =>
  editor.undo(receipt, Intl.DateTimeFormat().resolvedOptions().timeZone);
