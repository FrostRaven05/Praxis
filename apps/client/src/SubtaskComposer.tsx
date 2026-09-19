import { useState } from "react";
import { Subtasks, type ProjectTask } from "@praxis/application";
import { subtaskStorage } from "./storage";
const subtasks = new Subtasks(subtaskStorage);
export function SubtaskComposer({
  task,
  onSaved,
}: {
  task: ProjectTask;
  onSaved: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [base, setBase] = useState(task);
  return (
    <div className={open ? "subtask-composer open" : "subtask-composer"}>
      <button
        disabled={busy || task.status !== "todo"}
        title={task.status === "completed" ? "先撤销完成后再拆分" : undefined}
        onClick={() => {
          setBase(task);
          setOpen(!open);
        }}
      >
        拆分子任务
      </button>
      {open && (
        <form
          aria-label="添加子任务"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            void subtasks
              .add(base, text, confirmed)
              .then(async () => {
                await onSaved();
                setText("");
                setOpen(false);
                setConfirmed(false);
              })
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            子任务（每行一条）
            <textarea
              value={text}
              rows={3}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {base.executionDate && (
            <label className="summary-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              父任务已安排在 {base.executionDate}
              。确认转为汇总项，原安排退出执行清单，历史保留；子任务需单独安排。
            </label>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy}>保存子任务</button>
        </form>
      )}
    </div>
  );
}
