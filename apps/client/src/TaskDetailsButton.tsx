import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TaskDetailEditor,
  deadlineFromLocal,
  deadlineToLocal,
  parseMinutes,
  type TaskDetails,
} from "@praxis/application";
import { taskDetailsStorage } from "./storage";
import { DatePicker } from "./DatePicker";
const editor = new TaskDetailEditor(taskDetailsStorage);
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function TaskDetailsButton({
  taskId,
  onSaved,
  disabled = false,
  label = "编辑详情",
  className = "details-button",
}: {
  taskId: string;
  onSaved: () => Promise<unknown>;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <TaskDetailsDialog
            taskId={taskId}
            onClose={async (changed) => {
              if (changed) await onSaved();
              setOpen(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}
function TaskDetailsDialog({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: (changed: boolean) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState<TaskDetails | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const changed = useRef(false);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void taskDetailsStorage
      .read(taskId)
      .then((value) => {
        if (active) setBase(value);
      })
      .catch((e) => {
        if (active) setError(text(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taskId, reload]);
  async function close() {
    if (busy) return;
    setBusy(true);
    try {
      await onClose(changed.current);
    } catch (e) {
      setError(text(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="task-details-dialog"
      aria-labelledby="full-details-title"
      onCancel={(e) => {
        e.preventDefault();
        void close();
      }}
    >
      <header>
        <div>
          <p className="eyebrow">TASK DETAILS</p>
          <h2 id="full-details-title">编辑任务详情</h2>
        </div>
        <button
          aria-label="关闭详情编辑"
          disabled={busy}
          onClick={() => void close()}
        >
          ×
        </button>
      </header>
      <fieldset disabled={busy}>
        {loading ? (
          <p role="status">正在读取任务…</p>
        ) : base ? (
          <DetailForm
            key={taskId + ":" + reload}
            initial={base}
            onBusy={setBusy}
            onSaved={(value) => {
              changed.current = true;
              setBase(value);
            }}
          />
        ) : null}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="details-reload"
          disabled={busy || loading}
          onClick={() => setReload((n) => n + 1)}
        >
          重新加载（放弃本次编辑）
        </button>
      </fieldset>
    </dialog>
  );
}
function DetailForm({
  initial,
  onSaved,
  onBusy,
}: {
  initial: TaskDetails;
  onSaved: (task: TaskDetails) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [base, setBase] = useState(initial);
  const [title, setTitle] = useState(initial.title),
    [notes, setNotes] = useState(initial.notes),
    [criteria, setCriteria] = useState(initial.completionCriteria),
    [important, setImportant] = useState(initial.important),
    [deadline, setDeadline] = useState(deadlineToLocal(initial.deadline)),
    [estimate, setEstimate] = useState(
      initial.estimatedMinutes?.toString() ?? "",
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  return (
    <form
      className="full-details-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        onBusy(true);
        setError("");
        setNotice("");
        void (async () => {
          try {
            const saved = await editor.save(base, {
              title,
              notes,
              completionCriteria: criteria,
              important,
              deadline:
                deadline === deadlineToLocal(base.deadline)
                  ? base.deadline
                  : deadlineFromLocal(deadline),
              deadlineTimeZone: !deadline
                ? null
                : deadline === deadlineToLocal(base.deadline)
                  ? base.deadlineTimeZone
                  : Intl.DateTimeFormat().resolvedOptions().timeZone,
              estimatedMinutes: parseMinutes(estimate),
            });
            setBase(saved);
            setTitle(saved.title);
            setNotice("任务详情已保存到本机");
            onSaved(saved);
          } catch (e) {
            setError(text(e));
          } finally {
            setBusy(false);
            onBusy(false);
          }
        })();
      }}
    >
      <label htmlFor="details-title">任务名称</label>
      <input
        autoFocus
        id="details-title"
        value={title}
        disabled={busy}
        onChange={(e) => {
          setTitle(e.target.value);
          setNotice("");
        }}
      />
      <label htmlFor="details-notes">备注</label>
      <textarea
        id="details-notes"
        rows={3}
        value={notes}
        disabled={busy}
        onChange={(e) => {
          setNotes(e.target.value);
          setNotice("");
        }}
      />
      <label htmlFor="details-criteria">完成标准</label>
      <textarea
        id="details-criteria"
        rows={2}
        value={criteria}
        disabled={busy}
        onChange={(e) => {
          setCriteria(e.target.value);
          setNotice("");
        }}
        placeholder="怎样算完成这项任务？"
      />
      <label className="importance-field">
        <input
          type="checkbox"
          checked={important}
          disabled={busy}
          onChange={(e) => {
            setImportant(e.target.checked);
            setNotice("");
          }}
        />
        重要任务
      </label>
      <p className="field-help">任务重要度用于长期判断，与每日重点分别保存。</p>
      <label htmlFor="details-deadline">截止时间（本地时间）</label>
      <DatePicker
        id="details-deadline"
        label="截止时间（本地时间）"
        mode="datetime"
        clearable
        className="date-picker-field"
        value={deadline}
        disabled={busy}
        onChange={(date) => {
          setDeadline(date);
          setNotice("");
        }}
      />
      <p className="field-help">可留空。调整安排日期不会改变截止时间。</p>
      <label htmlFor="details-estimate">预估工作量（分钟）</label>
      <input
        id="details-estimate"
        type="number"
        min={1}
        max={1440}
        value={estimate}
        disabled={busy}
        onChange={(e) => {
          setEstimate(e.target.value);
          setNotice("");
        }}
        placeholder="未知"
      />
      <p className="field-help">
        留空表示未知。加入日期时作为预计投入，已有安排的估时保留不变。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p role="status" className="details-notice">
        {notice}
      </p>
      <button type="submit" disabled={busy}>
        {busy ? "保存中…" : "保存任务详情"}
      </button>
    </form>
  );
}
