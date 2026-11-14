import { RelatedRecords } from "./RelatedRecords";
import { WorkTaskProperties } from "./WorkTaskProperties";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  TaskDetailEditor,
  calendarDate,
  deadlineFromLocal,
  deadlineToLocal,
  parseMinutes,
  validCalendarDate,
  taskStates,
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
  onComplete,
  contextLabel = "收件箱",
  projectName,
  canSchedule = true,
}: {
  task: InboxTask & { status?: string };
  contextLabel?: string;
  projectName?: string | undefined;
  canSchedule?: boolean;
  onSaved: (date: string) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
  onLockedChange: (locked: boolean) => void;
  onComplete: () => Promise<void>;
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
  const [propertiesBusy, setPropertiesBusy] = useState(false);
  const [readError, setReadError] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const baseRef = useRef<TaskDetails | null>(null);
  const pending = useRef<Pending | null>(null);
  const appliedDate = useRef("");
  const draft = { title, notes, date, criteria, important, deadline, estimate };
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
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
    for (const input of [titleRef.current, notesRef.current]) {
      if (input) {
        input.style.height = "auto";
        const contentHeight = input.scrollHeight + 2;
        input.style.height = Math.min(contentHeight, 160) + "px";
        input.style.overflowY = contentHeight > 160 ? "auto" : "hidden";
      }
    }
  }, [title, notes]);
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
      if (value.date && !canSchedule)
        throw new Error("含子任务的父任务请安排具体子任务。");
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
    loading ||
    propertiesBusy ||
    !base ||
    scheduling ||
    !!(pending.current?.date && autosave.error);
  useEffect(() => {
    onLockedChange(
      busy || dirty || loading || propertiesBusy || autosave.pending,
    );
    return () => onLockedChange(false);
  }, [busy, dirty, loading, propertiesBusy, autosave.pending, onLockedChange]);
  async function close() {
    if (propertiesBusy) return;
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
        <span className="task-status-pill">{taskStates[task.status ?? "todo"] ?? task.status}</span>
        <span className="task-status-pill">{contextLabel}</span>
        <div className="task-panel-toolbar-actions">
          <button
            type="button"
            aria-label={task.status === "completed" ? "撤销完成" : "标为完成"}
            title={task.status === "completed" ? "撤销完成" : "标为完成"}
            disabled={locked || busy || dirty}
            onClick={() => void onComplete()}
          >
            <TaskPanelIcon name="check" />
          </button>
          <button
            type="button"
            aria-label="关闭任务详情"
            disabled={busy}
            onClick={() => void close()}
          >
            <TaskPanelIcon name="close" />
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
                onChange={(event) => changed(setNotes, event.target.value)}
              />
              <div className="task-date-options" aria-label="安排日期快捷选项">
                <button
                  type="button"
                  aria-pressed={date === today}
                  disabled={locked || !canSchedule || task.status === "completed"}
                  onClick={() => changed(setDate, today, true)}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-pressed={date === tomorrow(today)}
                  disabled={locked || !canSchedule || task.status === "completed"}
                  onClick={() => changed(setDate, tomorrow(today), true)}
                >
                  明天
                </button>
                <DatePicker
                  value={date}
                  onChange={(value) => changed(setDate, value, true)}
                  label="安排日期"
                  disabled={locked || !canSchedule || task.status === "completed"}
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
                  onClick={() => changed(setDate, "", true)}
                >
                  没有日期
                </button>
              </div>
              {!canSchedule && <p className="field-help">含子任务的父任务请安排具体子任务。</p>}
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
                  onChange={(value) => changed(setDeadline, value, true)}
                />
              </div>
            </div>
            <details className="task-panel-extra">
              <summary>工作量、完成标准与重要标记</summary>
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
                          onClick={() =>
                            changed(setEstimate, String(minutes), true)
                          }
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
                      onChange={(event) =>
                        changed(setEstimate, event.target.value)
                      }
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
                    onChange={(event) =>
                      changed(setCriteria, event.target.value)
                    }
                  />
                </div>
              </div>
              <div className="task-panel-field">
                <TaskPanelIcon name="check" />
                <label className="task-panel-importance">
                  <input
                    type="checkbox"
                    checked={important}
                    onChange={(event) =>
                      changed(setImportant, event.target.checked, true)
                    }
                  />
                  重要任务
                </label>
              </div>
            </details>
          </fieldset>
        </form>
        <WorkTaskProperties
          taskId={task.taskId}
          version={base?.version ?? task.version}
          disabled={loading || busy || dirty || autosave.pending}
          onSaved={onReload}
          onBusyChange={setPropertiesBusy}
        />
        {projectName && (
          <div className="task-panel-field">
            <TaskPanelIcon name="folder" />
            <div className="task-panel-field-body">
              <span className="task-panel-field-label">所属项目</span>
              <span>{projectName}</span>
            </div>
          </div>
        )}
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

      <RelatedRecords targetType="task" targetId={task.taskId} />
      <footer className="task-panel-footer" role="status" aria-live="polite">
        <span>
          <span className="status-dot" />
          {autosave.status}
        </span>
      </footer>
    </aside>
  );
}
