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
  onClose,
  onComplete,
  onProject,
  onBusyChange,
  onDirtyChange,
}: {
  task: DailyTask;
  onSaved: (receipt: EditReceipt) => Promise<void>;
  onUpdated: () => Promise<void>;
  onClose: () => void;
  onComplete: () => Promise<void>;
  onProject: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
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
  const pendingReceipt = useRef<EditReceipt | null>(null);
  const metadataSaved = useRef(false);
  const initialTask = useRef(task);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calendarDate(new Date(), zone);
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
  const dirty = Boolean(
    base &&
    (title.trim() !== base.title ||
      date !== scheduleBase.executionDate ||
      notes !== base.notes ||
      criteria !== base.completionCriteria ||
      important !== base.important ||
      deadline !== deadlineToLocal(base.deadline) ||
      estimate.trim() !== (base.estimatedMinutes?.toString() ?? "")),
  );
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  async function save() {
    if (!base || busy || !dirty) return;
    setBusy(true);
    setError("");
    setNotice("");
    let currentBase = base;
    let currentSchedule = scheduleBase;
    try {
      // Keep title/date last so their existing undo event remains the latest task version.
      if (!title.trim()) throw new Error("请填写任务标题");
      if (!validCalendarDate(date)) throw new Error("请选择有效的安排日期");
      if (task.status === "completed" && date !== scheduleBase.executionDate)
        throw new Error("已完成任务不能改期，请先撤销完成");
      if (base.version !== (scheduleBase.version ?? 0))
        throw new Error("任务已更新，请重新加载后再编辑。");
      const minutes = parseMinutes(estimate);
      const deadlineValue =
        deadline === deadlineToLocal(base.deadline)
          ? base.deadline
          : deadlineFromLocal(deadline);
      const fields = {
        title: base.title,
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
        estimatedMinutes: minutes,
      };
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
        setBase(saved);
        currentSchedule = {
          ...currentSchedule,
          version: saved.version,
          title: saved.title,
          important: saved.important,
          deadline: saved.deadline,
        };
        setScheduleBase(currentSchedule);
      }
      if (
        title.trim() !== currentBase.title ||
        date !== currentSchedule.executionDate
      ) {
        const receipt = await scheduleEditor.save(
          currentSchedule,
          title,
          date,
          zone,
        );
        pendingReceipt.current = receipt;
        currentSchedule = receipt.after;
        setScheduleBase(currentSchedule);
        setBase({
          ...currentBase,
          title: receipt.after.title,
          version: receipt.after.version ?? 0,
        });
      }
      if (pendingReceipt.current) {
        await onSaved({ ...pendingReceipt.current, after: currentSchedule });
        pendingReceipt.current = null;
      } else {
        await onUpdated();
      }
      metadataSaved.current = false;
      setNotice("已保存到本机");
    } catch (error) {
      setError(
        metadataSaved.current
          ? `任务详情已保存；标题或日期尚未确认保存：${errorText(error)}。可重试保存。`
          : errorText(error),
      );
    } finally {
      setBusy(false);
    }
  }
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
          void save();
        } else if (event.key === "Escape" && !busy) {
          event.preventDefault();
          if (dirty) setNotice("修改尚未保存，可保存或取消修改。");
          else onClose();
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
            onClick={onClose}
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
            void save();
          }}
        >
          <fieldset disabled={busy || loading || !base}>
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
                  disabled={task.status === "completed"}
                  onClick={() => setDate(today)}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-pressed={date === tomorrow(today)}
                  disabled={task.status === "completed"}
                  onClick={() => setDate(tomorrow(today))}
                >
                  明天
                </button>
                <DatePicker
                  value={date}
                  onChange={setDate}
                  label="安排日期"
                  disabled={
                    busy || loading || !base || task.status === "completed"
                  }
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
                  disabled={busy || loading || !base}
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
            <button disabled={busy} onClick={() => void onUpdated()}>
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
        {dirty && (
          <button
            className="task-panel-cancel"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onUpdated()
                .catch((error) => setError(errorText(error)))
                .finally(() => setBusy(false));
            }}
          >
            取消修改
          </button>
        )}
        <button
          type="submit"
          form="task-panel-editor"
          disabled={busy || loading || !base || !dirty}
          title="保存修改（Ctrl+Enter）"
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {busy ? "保存中…" : "保存修改"}
        </button>
      </footer>
    </aside>
  );
}
