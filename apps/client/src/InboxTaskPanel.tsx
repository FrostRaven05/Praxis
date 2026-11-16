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
import { useAutosave } from "./useAutosave";
import { reminderLabel, specificDateLabel } from "./TaskPanelFields";
import { TaskDescription, TaskSubtitle } from "./TaskDescription";
import { TaskProjectControl } from "./TaskProjectControl";
import { TaskSubtasks } from "./TaskSubtasks";
import { TaskPanelActions } from "./TaskPanelActions";
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
  onDelete,
  contextLabel = "收件箱",
  projectId = null,
}: {
  task: InboxTask & { status?: string };
  contextLabel?: string;
  projectName?: string | null;
  projectId?: string | null;
  onSaved: (date: string) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
  onLockedChange: (locked: boolean) => void;
  onComplete: () => Promise<void>;
  onDelete?: () => Promise<void>;
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
  const [readError, setReadError] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [subtaskRevision, setSubtaskRevision] = useState(0);
  const baseRef = useRef<TaskDetails | null>(null);
  const pending = useRef<Pending | null>(null);
  const appliedDate = useRef("");
  const draft = { title, notes, date, criteria, important, deadline, estimate };
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const titleRef = useRef<HTMLTextAreaElement>(null);
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
    setReadError("");
  }
  useEffect(() => {
    let active = true;
    void taskDetailsStorage
      .read(task.taskId)
      .then((value) => {
        if (active) {
          setBase(value);
          baseRef.current = value;
          reset(value);
        }
      })
      .catch((error) => {
        if (active) setReadError(message(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.taskId]);
  useLayoutEffect(() => {
    const input = titleRef.current;
    if (!input) return;
    input.style.height = "auto";
    const contentHeight = input.scrollHeight + 2;
    input.style.height = Math.min(contentHeight, 160) + "px";
    input.style.overflowY = contentHeight > 160 ? "auto" : "hidden";
  }, [title]);
  const autosave = useAutosave({
    draft,
    enabled: !!base && !loading,
    hasChanges: (value) => {
      const current = baseRef.current;
      if (!current) return false;
      try {
        return (
          value.title.trim() !== current.title ||
          value.notes !== current.notes ||
          value.criteria !== current.completionCriteria ||
          value.important !== current.important ||
          value.deadline !== deadlineToLocal(current.deadline) ||
          parseMinutes(value.estimate) !== current.estimatedMinutes ||
          value.date !== appliedDate.current
        );
      } catch {
        return true;
      }
    },
    validate: (value) => {
      if (!value.title.trim()) throw new Error("请填写任务标题");
      if (value.date && !validCalendarDate(value.date))
        throw new Error("请选择有效的安排日期");
      parseMinutes(value.estimate);
      if (value.deadline !== deadlineToLocal(baseRef.current!.deadline))
        deadlineFromLocal(value.deadline);
    },
    persist: async (value) => {
      try {
        let operation = pending.current;
        if (!operation) {
          const base = baseRef.current!;
          const {
            title,
            notes,
            date,
            criteria,
            important,
            deadline,
            estimate,
          } = value;
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
          pending.current = operation;
        }
        if (!operation.saved)
          operation.saved = await editor.save(operation.base, operation.fields);
        baseRef.current = operation.saved;
        setBase(operation.saved);
        if (operation.date && !operation.scheduled) {
          // Finish newer text edits before leaving the inbox to show the schedule.
          if (JSON.stringify(latestDraft.current) !== JSON.stringify(value)) {
            pending.current = null;
            await onSaved("");
            return;
          }
          setScheduling(true);
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
          appliedDate.current = operation.date;
        }
        await onSaved(operation.date);
        pending.current = null;
      } finally {
        setScheduling(false);
      }
    },
  });
  const { busy, dirty } = autosave;
  const error = readError || autosave.error;
  const locked =
    loading || !base || scheduling || !!(pending.current?.date && autosave.error);
  useEffect(() => {
    onLockedChange(busy || dirty || loading || autosave.pending);
    return () => onLockedChange(false);
  }, [busy, dirty, loading, autosave.pending, onLockedChange]);
  async function close() {
    if (!baseRef.current || (await autosave.flush())) onClose();
  }
  function changed<T>(setter: (value: T) => void, value: T, discrete = false) {
    autosave.changed(discrete);
    setter(value);
  }
  return (
    <aside
      id="inbox-task-panel"
      className="task-detail reference-task-panel inbox-task-panel"
      aria-label={`${contextLabel}任务详情`}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          document.querySelector(".date-picker-popover")
        )
          return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void autosave.save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          void close();
        }
      }}
    >
      <header className="task-panel-toolbar">
        <TaskProjectControl
          taskId={task.taskId}
          projectId={projectId}
          disabled={locked || busy}
          onChanging={() => autosave.flush()}
          onChanged={() => onReload()}
        />
        <div className="task-panel-toolbar-actions">
          <button
            type="button"
            className="task-panel-dismiss"
            aria-label="关闭任务详情"
            disabled={busy}
            onClick={() => void close()}
          >
            <TaskPanelIcon name="chevron" />
          </button>
        </div>
      </header>
      <div className="task-panel-scroll">
        <form
          id="inbox-panel-editor"
          className="task-panel-form"
          aria-label={`编辑${contextLabel}任务`}
          onSubmit={(event) => {
            event.preventDefault();
            void autosave.save();
          }}
          onCompositionStart={autosave.onCompositionStart}
          onCompositionEnd={autosave.onCompositionEnd}
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
                onChange={(event) => changed(setTitle, event.target.value)}
              />
              <TaskSubtitle
                value={notes}
                disabled={locked}
                onChange={(value) => changed(setNotes, value)}
              />
              <div className="task-date-options" aria-label="安排日期快捷选项">
                <button
                  type="button"
                  aria-pressed={date === today}
                  disabled={locked || task.status === "completed"}
                  onClick={() => changed(setDate, today, true)}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-pressed={date === tomorrow(today)}
                  disabled={locked || task.status === "completed"}
                  onClick={() => changed(setDate, tomorrow(today), true)}
                >
                  明天
                </button>
                <DatePicker
                  value={date}
                  onChange={(value) => changed(setDate, value, true)}
                  label="安排日期"
                  disabled={locked || task.status === "completed"}
                  className={
                    !!date && date !== today && date !== tomorrow(today)
                      ? "selected task-date-chip"
                      : "task-date-chip"
                  }
                  display={
                    !date || date === today || date === tomorrow(today)
                      ? "选择日期"
                      : specificDateLabel(date)
                  }
                />
                <button
                  type="button"
                  aria-pressed={!date}
                  onClick={() => changed(setDate, "", true)}
                >
                  没有日期
                </button>
              </div>
            </div>
            <div className="task-panel-field task-reminder">
              <TaskPanelIcon name="clock" />
              <DatePicker
                id="panel-deadline"
                label="提醒"
                mode="datetime"
                clearable
                className="date-picker-field"
                value={deadline}
                disabled={locked}
                display={reminderLabel(deadline)}
                onChange={(value) => changed(setDeadline, value, true)}
              />
            </div>
            <TaskSubtasks
              key={`${task.taskId}:${subtaskRevision}`}
              taskId={task.taskId}
              disabled={locked}
              onChanged={() => onSaved("")}
            />
            <TaskDescription
              value={notes}
              disabled={locked}
              onChange={(value) => changed(setNotes, value)}
            />
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
            {base && (
              <button disabled={busy} onClick={() => void autosave.save()}>
                重试自动保存
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => {
                void onReload().catch((error) => setReadError(message(error)));
              }}
            >
              重新加载
            </button>
          </div>
        )}
      </div>
      {(autosave.busy || autosave.error || autosave.dirty) && (
        <footer className="task-panel-footer" role="status" aria-live="polite">
          <span>
            <span className="status-dot" />
            {autosave.status}
          </span>
        </footer>
      )}
      <TaskPanelActions
        taskId={task.taskId}
        disabled={locked}
        {...(onDelete ? { onDelete } : {})}
        onClose={onClose}
        onChanged={async () => {
          setSubtaskRevision((value) => value + 1);
          await onSaved("");
        }}
        onRefined={(value) => {
          setTitle(value.title);
          setNotes(value.notes);
          if (baseRef.current) {
            const next = {
              ...baseRef.current,
              title: value.title,
              notes: value.notes,
              version: baseRef.current.version + 1,
            };
            baseRef.current = next;
            setBase(next);
          }
        }}
      />
    </aside>
  );
}
