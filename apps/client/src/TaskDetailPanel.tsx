import { RelatedRecords } from "./RelatedRecords";
import { TaskTimeLink } from "./TaskTimeLink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  EditTask,
  TaskDetailEditor,
  calendarDate,
  deadlineFromLocal,
  deadlineToLocal,
  parseMinutes,
  taskStates,
  validCalendarDate,
  type DailyTask,
  type EditReceipt,
  type TaskDetails,
} from "@praxis/application";
import { editStorage, taskDetailsStorage } from "./storage";
import { ProjectAssignment } from "./ProjectAssignment";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { DatePicker } from "./DatePicker";
import { getCurrentWindow } from "@tauri-apps/api/window";

const scheduleEditor = new EditTask(editStorage);
const detailsEditor = new TaskDetailEditor(taskDetailsStorage);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function tomorrow(date: string) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function TaskDetailPanel({
  task,
  onSaved,
  onUpdated,
  onPersisted,
  onClose,
  onComplete,
  onProject,
  onBusyChange,
  onDirtyChange,
  scheduleTimeZone,
}: {
  task: DailyTask;
  onSaved: (receipt: EditReceipt) => Promise<void>;
  onUpdated: () => Promise<void>;
  onPersisted: () => Promise<void>;
  onClose: () => void;
  onComplete: () => Promise<void>;
  onProject: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  scheduleTimeZone?: string;
}) {
  const [base, setBase] = useState<TaskDetails | null>(null);
  const [scheduleBase, setScheduleBase] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState(task.executionDate);
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState("");
  const [important, setImportant] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [estimate, setEstimate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [composing, setComposing] = useState(false);
  const immediate = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const baseRef = useRef(base);
  const scheduleRef = useRef(scheduleBase);
  const draft = { title, date, notes, criteria, important, deadline, estimate };
  const draftRef = useRef(draft);
  const pendingDraft = useRef<typeof draft | null>(null);
  draftRef.current = draft;
  const composingRef = useRef(composing);
  composingRef.current = composing;
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const pendingReceipt = useRef<EditReceipt | null>(null);
  const metadataSaved = useRef(false);
  const initialTask = useRef(task);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calendarDate(new Date(), scheduleTimeZone ?? zone);
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
  useEffect(() => {
    let active = true;
    void taskDetailsStorage
      .read(initialTask.current.taskId)
      .then((value) => {
        if (!active) return;
        if (value.version !== (initialTask.current.version ?? 0))
          throw new Error("任务已更新，请重新加载后再编辑。");
        setBase(value);
        baseRef.current = value;
        setTitle(value.title);
        setNotes(value.notes);
        setCriteria(value.completionCriteria);
        setImportant(value.important);
        setDeadline(deadlineToLocal(value.deadline));
        setEstimate(value.estimatedMinutes?.toString() ?? "");
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  function hasChanges() {
    const saved = baseRef.current;
    if (!saved) return false;
    const current = draftRef.current;
    let minutes: number | null;
    try {
      minutes = parseMinutes(current.estimate);
    } catch {
      return true;
    }
    return (
      current.title.trim() !== saved.title ||
      current.date !== scheduleRef.current.executionDate ||
      current.notes !== saved.notes ||
      current.criteria !== saved.completionCriteria ||
      current.important !== saved.important ||
      current.deadline !== deadlineToLocal(saved.deadline) ||
      minutes !== saved.estimatedMinutes
    );
  }
  const dirty = hasChanges();
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  function save(): Promise<boolean> {
    if (inFlight.current) return inFlight.current;
    if (!baseRef.current) return Promise.resolve(false);
    if (
      !hasChanges() &&
      !pendingDraft.current &&
      !pendingReceipt.current &&
      !metadataSaved.current
    )
      return Promise.resolve(true);
    immediate.current = false;
    const operation = persist();
    inFlight.current = operation;
    void operation.then(() => {
      inFlight.current = null;
    });
    return operation;
  }
  async function persist(): Promise<boolean> {
    const captured = pendingDraft.current ?? draftRef.current;
    const { title, date, notes, criteria, important, deadline, estimate } =
      captured;
    setBusy(true);
    setError("");
    setNotice("");
    let currentBase = baseRef.current!;
    let currentSchedule = scheduleRef.current;
    try {
      // Keep title/date last so their existing undo event remains the latest task version.
      if (!title.trim()) throw new Error("请填写任务标题");
      if (!validCalendarDate(date)) throw new Error("请选择有效的安排日期");
      if (task.status === "completed" && date !== currentSchedule.executionDate)
        throw new Error("已完成任务不能改期，请先撤销完成");
      if (currentBase.version !== (currentSchedule.version ?? 0))
        throw new Error("任务已更新，请重新加载后再编辑。");
      const minutes = parseMinutes(estimate);
      const deadlineValue =
        deadline === deadlineToLocal(currentBase.deadline)
          ? currentBase.deadline
          : deadlineFromLocal(deadline);
      const fields = {
        title: currentBase.title,
        notes,
        completionCriteria: criteria,
        important,
        deadline: deadlineValue,
        deadlineTimeZone:
          deadlineValue === null
            ? null
            : deadline === deadlineToLocal(currentBase.deadline)
              ? currentBase.deadlineTimeZone
              : zone,
        estimatedMinutes: minutes,
      };
      // Retain the exact submitted draft for an unacknowledged write retry.
      pendingDraft.current = captured;
      if (
        fields.notes !== currentBase.notes ||
        fields.completionCriteria !== currentBase.completionCriteria ||
        fields.important !== currentBase.important ||
        fields.deadline !== currentBase.deadline ||
        fields.estimatedMinutes !== currentBase.estimatedMinutes
      ) {
        const saved = await detailsEditor.save(currentBase, fields);
        metadataSaved.current = true;
        currentBase = saved;
        baseRef.current = saved;
        setBase(saved);
        currentSchedule = {
          ...currentSchedule,
          version: saved.version,
          title: saved.title,
          important: saved.important,
          deadline: saved.deadline,
        };
        setScheduleBase(currentSchedule);
        scheduleRef.current = currentSchedule;
      }
      if (
        title.trim() !== currentBase.title ||
        date !== currentSchedule.executionDate
      ) {
        const receipt = await scheduleEditor.save(
          currentSchedule,
          title,
          date,
          scheduleTimeZone ?? zone,
        );
        pendingReceipt.current = receipt;
        currentSchedule = receipt.after;
        setScheduleBase(currentSchedule);
        currentBase = {
          ...currentBase,
          title: receipt.after.title,
          version: receipt.after.version ?? 0,
        };
        baseRef.current = currentBase;
        scheduleRef.current = currentSchedule;
        setBase(currentBase);
      }
      if (pendingReceipt.current) {
        await onSaved({ ...pendingReceipt.current, after: currentSchedule });
        pendingReceipt.current = null;
      } else {
        await onPersisted();
      }
      metadataSaved.current = false;
      pendingDraft.current = null;
      setNotice("已保存到本机");
      return true;
    } catch (error) {
      setError(
        metadataSaved.current
          ? `部分修改已保存，仍有修改尚未确认：${errorText(error)}。`
          : errorText(error),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = save;
  async function flush() {
    if (composingRef.current) return false;
    // A save acknowledges only its captured draft. New input stays queued.
    do {
      if (!(await saveRef.current())) return false;
    } while (hasChanges());
    return true;
  }
  flushRef.current = flush;
  async function close() {
    if (!baseRef.current || (await flushRef.current())) onClose();
  }
  function changed<T>(setter: (value: T) => void, value: T, discrete = false) {
    immediate.current = discrete;
    setError("");
    setNotice("");
    setter(value);
  }
  useEffect(() => {
    if (
      (!dirty && !pendingDraft.current) ||
      loading ||
      busy ||
      error ||
      composing
    )
      return;
    const timer = setTimeout(
      () => void saveRef.current(),
      immediate.current ? 0 : 500,
    );
    return () => clearTimeout(timer);
  }, [
    dirty,
    loading,
    busy,
    error,
    composing,
    title,
    date,
    notes,
    criteria,
    important,
    deadline,
    estimate,
  ]);
  useEffect(() => {
    let active = true;
    let off: (() => void) | undefined;
    const nativeWindow = getCurrentWindow();
    void nativeWindow
      .onCloseRequested(async (event) => {
        if (
          !hasChanges() &&
          !inFlight.current &&
          !pendingDraft.current &&
          !pendingReceipt.current &&
          !metadataSaved.current
        )
          return;
        // Tauri waits for this handler before destroying the window.
        if (!(await flushRef.current())) event.preventDefault();
      })
      .then((unlisten) => {
        if (active) off = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      active = false;
      off?.();
    };
  }, []);
  return (
    <aside
      className="task-detail reference-task-panel"
      aria-label="任务详情"
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          document.querySelector(
            ".date-picker-popover,.task-action-popover,dialog[open]",
          )
        )
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          void saveRef.current();
        } else if (event.key === "Escape" && !busy) {
          event.preventDefault();
          void close();
        }
      }}
    >
      <header className="task-panel-toolbar">
        <span className="task-status-pill">{taskStates[task.status]}</span>
        <span className="task-status-pill">
          {task.projectId ? "项目任务" : "临时任务"}
        </span>
        <div className="task-panel-toolbar-actions">
          <button
            aria-label={task.status === "completed" ? "撤销完成" : "标为完成"}
            title={task.status === "completed" ? "撤销完成" : "标为完成"}
            aria-pressed={task.status === "completed"}
            disabled={busy || dirty || loading}
            onClick={() => void onComplete()}
          >
            <TaskPanelIcon
              name={task.status === "completed" ? "check" : "box"}
            />
          </button>
          <button
            aria-label="关闭任务详情"
            title="收起详情"
            disabled={busy}
            onClick={() => void close()}
          >
            <TaskPanelIcon name="close" />
          </button>
        </div>
      </header>
      <div className="task-panel-scroll">
        <form
          id="task-panel-editor"
          className="task-panel-form"
          aria-label="编辑任务"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRef.current();
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        >
          <fieldset disabled={loading || !base}>
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
                  disabled={task.status === "completed"}
                  onClick={() => changed(setDate, today, true)}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-pressed={date === tomorrow(today)}
                  disabled={task.status === "completed"}
                  onClick={() => changed(setDate, tomorrow(today), true)}
                >
                  明天
                </button>
                <DatePicker
                  value={date}
                  onChange={(value) => changed(setDate, value, true)}
                  label="安排日期"
                  disabled={loading || !base || task.status === "completed"}
                  className={
                    date !== today && date !== tomorrow(today) ? "selected" : ""
                  }
                  display={
                    date === today || date === tomorrow(today)
                      ? "选择日期"
                      : undefined
                  }
                />
              </div>
              {task.status === "completed" && (
                <p className="field-help">已完成任务保留原安排日期。</p>
              )}
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
                  disabled={loading || !base}
                  onChange={(value) => changed(setDeadline, value, true)}
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
                  onChange={(event) => changed(setCriteria, event.target.value)}
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
          </fieldset>
        </form>
        <fieldset
          className="task-panel-project-field"
          disabled={busy || dirty || loading}
        >
          <TaskPanelIcon name="folder" />
          <div className="task-panel-field-body">
            <span className="task-panel-field-label">所属项目</span>
            <ProjectAssignment task={task} onAssigned={onUpdated} />
          </div>
        </fieldset>
        {task.projectId && (
          <div className="task-panel-field">
            <TaskPanelIcon name="branch" />
            <button
              className="task-panel-project-link"
              disabled={busy || dirty}
              onClick={() => onProject(task.projectId!)}
            >
              在项目中管理子任务
            </button>
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
              <button disabled={busy} onClick={() => void saveRef.current()}>
                重试自动保存
              </button>
            )}
            <button disabled={busy} onClick={() => void onUpdated()}>
              重新加载
            </button>
          </div>
        )}
        <div className="task-panel-secondary">
          <RelatedRecords targetType="task" targetId={task.taskId} />
          <TaskTimeLink
            taskId={task.taskId}
            disabled={busy || dirty}
            showSummary
          />
        </div>
      </div>
      <footer className="task-panel-footer" role="status" aria-live="polite">
        <span>
          <span className="status-dot" />
          {busy
            ? "正在保存…"
            : error
              ? "保存未完成，修改已保留"
              : dirty
                ? "等待自动保存…"
                : notice
                  ? "已自动保存"
                  : "自动保存到本机"}
        </span>
      </footer>
    </aside>
  );
}
