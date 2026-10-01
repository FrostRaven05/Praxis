import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  TaskDetailEditor,
  calendarDate,
  deadlineFromLocal,
  deadlineToLocal,
  parseMinutes,
  validCalendarDate,
  type InboxTask,
  type TaskDetails,
  type TaskDetailFields,
} from "@praxis/application";
import { taskDetailsStorage } from "./storage";
import { planning } from "./PlanningPanel";
import { DatePicker } from "./DatePicker";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { shiftCalendarDate } from "./calendar-controls";
const editor = new TaskDetailEditor(taskDetailsStorage);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const tomorrow = (date: string) => shiftCalendarDate(date, 1);
type Pending = {
  base: TaskDetails;
  fields: TaskDetailFields;
  date: string;
  saved: TaskDetails | null;
  scheduled: boolean;
};

export function InboxTaskPanel({
  task,
  onSaved,
  onReload,
  onClose,
  onLockedChange,
}: {
  task: InboxTask;
  onSaved: (date: string) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const [base, setBase] = useState<TaskDetails | null>(null);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [criteria, setCriteria] = useState("");
  const [important, setImportant] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [estimate, setEstimate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const saving = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calendarDate(new Date(), zone);
  function reset(value: TaskDetails) {
    setTitle(value.title);
    setNotes(value.notes);
    setCriteria(value.completionCriteria);
    setImportant(value.important);
    setDeadline(deadlineToLocal(value.deadline));
    setEstimate(value.estimatedMinutes?.toString() ?? "");
    setDate("");
    setNotice("");
    setError("");
  }
  useEffect(() => {
    let active = true;
    void taskDetailsStorage
      .read(task.taskId)
      .then((value) => {
        if (active) {
          setBase(value);
          reset(value);
        }
      })
      .catch((error) => {
        if (active) setError(message(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.taskId]);
  useLayoutEffect(() => {
    for (const input of [titleRef.current, notesRef.current]) {
      if (input) {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight + 2, 160) + "px";
      }
    }
  }, [title, notes]);
  const dirty =
    !!pending ||
    !!(
      base &&
      (title.trim() !== base.title ||
        notes !== base.notes ||
        criteria !== base.completionCriteria ||
        important !== base.important ||
        deadline !== deadlineToLocal(base.deadline) ||
        estimate.trim() !== (base.estimatedMinutes?.toString() ?? "") ||
        date)
    );
  const locked = busy || loading || !base || !!pending;
  useEffect(() => {
    onLockedChange(busy || dirty || loading);
    return () => onLockedChange(false);
  }, [busy, dirty, loading, onLockedChange]);
  function close() {
    if (busy) return;
    if (dirty) setNotice("修改尚未保存，可保存或取消修改。");
    else onClose();
  }
  async function save() {
    if (!base || saving.current || !dirty) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let operation = pending;
      if (!operation) {
        if (!title.trim()) throw new Error("请填写任务标题");
        if (date && !validCalendarDate(date))
          throw new Error("请选择有效的安排日期");
        const deadlineValue =
          deadline === deadlineToLocal(base.deadline)
            ? base.deadline
            : deadlineFromLocal(deadline);
        const fields = {
          title: title.trim(),
          notes,
          completionCriteria: criteria,
          important,
          deadline: deadlineValue,
          deadlineTimeZone:
            deadlineValue === null
              ? null
              : deadline === deadlineToLocal(base.deadline)
                ? base.deadlineTimeZone
                : zone,
          estimatedMinutes: parseMinutes(estimate),
        };
        const unchanged = Object.keys(fields).every(
          (key) =>
            fields[key as keyof TaskDetailFields] ===
            base[key as keyof TaskDetailFields],
        );
        operation = {
          base,
          fields,
          date,
          saved: unchanged ? base : null,
          scheduled: false,
        };
        setPending(operation);
      }
      if (!operation.saved)
        operation.saved = await editor.save(operation.base, operation.fields);
      if (operation.date && !operation.scheduled) {
        await planning.schedule(
          {
            ...task,
            version: operation.saved.version,
            title: operation.saved.title,
          },
          operation.date,
          zone,
        );
        operation.scheduled = true;
      }
      await onSaved(operation.date);
      setBase(operation.saved);
      reset(operation.saved);
      setPending(null);
    } catch (error) {
      setError(message(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <aside
      id="inbox-task-panel"
      className="task-detail reference-task-panel inbox-task-panel"
      aria-label="收件箱任务详情"
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          document.querySelector(".date-picker-popover")
        )
          return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="task-panel-toolbar">
        <span className="task-status-pill">待办</span>
        <span className="task-status-pill">收件箱</span>
        <div className="task-panel-toolbar-actions">
          <button
            type="button"
            aria-label="关闭任务详情"
            disabled={busy}
            onClick={close}
          >
            <TaskPanelIcon name="close" />
          </button>
        </div>
      </header>
      <div className="task-panel-scroll">
        <form
          id="inbox-panel-editor"
          className="task-panel-form"
          aria-label="编辑收件箱任务"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={locked}>
            <div className="task-panel-intro">
              <label className="sr-only" htmlFor="panel-title">
                任务标题
              </label>
              <textarea
                ref={titleRef}
                id="panel-title"
                aria-label="编辑任务标题"
                className="task-panel-title"
                rows={1}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <label className="sr-only" htmlFor="panel-notes">
                任务描述
              </label>
              <textarea
                ref={notesRef}
                id="panel-notes"
                className="task-panel-notes"
                rows={1}
                placeholder="添加描述"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <div className="task-date-options" aria-label="安排日期快捷选项">
                <button
                  type="button"
                  aria-pressed={date === today}
                  disabled={locked}
                  onClick={() => setDate(today)}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-pressed={date === tomorrow(today)}
                  disabled={locked}
                  onClick={() => setDate(tomorrow(today))}
                >
                  明天
                </button>
                <DatePicker
                  value={date}
                  onChange={setDate}
                  label="安排日期"
                  disabled={locked}
                  className={
                    !!date && date !== today && date !== tomorrow(today)
                      ? "selected"
                      : ""
                  }
                  display={
                    date === today || date === tomorrow(today)
                      ? "选择日期"
                      : undefined
                  }
                />
                <button
                  type="button"
                  aria-pressed={!date}
                  onClick={() => setDate("")}
                >
                  没有日期
                </button>
              </div>
            </div>
            <div className="task-panel-field">
              <TaskPanelIcon name="clock" />
              <div className="task-panel-field-body">
                <label htmlFor="panel-deadline">截止时间</label>
                <DatePicker
                  id="panel-deadline"
                  label="截止时间（本地时间）"
                  mode="datetime"
                  clearable
                  className="date-picker-field"
                  value={deadline}
                  disabled={locked}
                  onChange={setDeadline}
                />
              </div>
            </div>
            <div className="task-panel-field">
              <TaskPanelIcon name="work" />
              <div className="task-panel-field-body">
                <label htmlFor="panel-estimate">预估工作量</label>
                <div className="task-effort-editor">
                  <div className="task-effort-options">
                    {[15, 30, 60].map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        aria-pressed={estimate === String(minutes)}
                        onClick={() => setEstimate(String(minutes))}
                      >
                        {minutes} 分钟
                      </button>
                    ))}
                  </div>
                  <input
                    id="panel-estimate"
                    aria-label="预估工作量（分钟）"
                    type="number"
                    min={1}
                    max={1440}
                    value={estimate}
                    placeholder="分钟"
                    title="自定义分钟，留空表示未知"
                    onChange={(event) => setEstimate(event.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="task-panel-field">
              <TaskPanelIcon name="criteria" />
              <div className="task-panel-field-body">
                <label htmlFor="panel-criteria">完成标准</label>
                <textarea
                  id="panel-criteria"
                  rows={2}
                  value={criteria}
                  placeholder="怎样算完成这项任务？"
                  onChange={(event) => setCriteria(event.target.value)}
                />
              </div>
            </div>
            <div className="task-panel-field">
              <TaskPanelIcon name="check" />
              <label className="task-panel-importance">
                <input
                  type="checkbox"
                  checked={important}
                  onChange={(event) => setImportant(event.target.checked)}
                />
                重要任务
              </label>
            </div>
          </fieldset>
        </form>
        {loading && (
          <p className="task-panel-feedback" role="status">
            正在读取任务详情…
          </p>
        )}
        {error && (
          <div className="task-panel-feedback error" role="alert">
            {error}
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onReload()
                  .catch((error) => setError(message(error)))
                  .finally(() => setBusy(false));
              }}
            >
              重新加载
            </button>
          </div>
        )}
        <p className="task-panel-feedback" role="status">
          {notice}
        </p>
      </div>
      <footer className="task-panel-footer">
        <span>
          <span className="status-dot" />
          {dirty ? "有未保存的修改" : "本机保存"}
        </span>
        {dirty && !pending && (
          <button
            type="button"
            className="task-panel-cancel"
            disabled={busy}
            onClick={() => base && reset(base)}
          >
            取消修改
          </button>
        )}
        <button
          type="submit"
          form="inbox-panel-editor"
          disabled={busy || loading || !base || !dirty}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {busy ? "保存中…" : pending ? "重试保存" : "保存修改"}
        </button>
      </footer>
    </aside>
  );
}
