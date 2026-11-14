import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  TaskDetailEditor,
  deadlineFromLocal,
  deadlineToLocal,
  parseMinutes,
  type ProjectTask,
  type TaskDetails,
} from "@praxis/application";
import { taskDetailsStorage } from "./storage";
import { useAutosave } from "./useAutosave";
import { DatePicker } from "./DatePicker";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { TaskWorkload, reminderLabel } from "./TaskPanelFields";
import { TaskDescription, TaskSubtitle } from "./TaskDescription";
import { TaskProjectControl } from "./TaskProjectControl";
import { TaskSubtasks } from "./TaskSubtasks";

const editor = new TaskDetailEditor(taskDetailsStorage);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectTaskPanel({
  task,
  projectId,
  projectName,
  flush,
  onSaved,
  onClose,
  onLockedChange,
  onReload,
}: {
  task: ProjectTask;
  projectName: string;
  projectId: string;
  flush: { current: () => Promise<boolean> };
  onSaved: () => Promise<unknown>;
  onClose: () => void;
  onLockedChange: (locked: boolean) => void;
  onReload: () => void;
}) {
  const [base, setBase] = useState<TaskDetails | null>(null);
  const baseRef = useRef<TaskDetails | null>(null);
  const [draft, setDraft] = useState({
    title: task.title,
    notes: "",
    criteria: "",
    important: false,
    deadline: "",
    estimate: "",
  });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const acknowledged = useRef<TaskDetails | null>(null);
  const generation = useRef(0);
  const observedVersion = useRef(task.version);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const read = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setReadError("");
    try {
      const value = await taskDetailsStorage.read(task.taskId);
      if (request !== generation.current) return;
      baseRef.current = value;
      setBase(value);
      setDraft({
        title: value.title,
        notes: value.notes,
        criteria: value.completionCriteria,
        important: value.important,
        deadline: deadlineToLocal(value.deadline),
        estimate: value.estimatedMinutes?.toString() ?? "",
      });
    } catch (e) {
      if (request === generation.current) setReadError(message(e));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [task.taskId]);
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, [read]);
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
          parseMinutes(value.estimate) !== current.estimatedMinutes
        );
      } catch {
        return true;
      }
    },
    validate: (value) => {
      if (!value.title.trim()) throw new Error("请填写任务标题");
      parseMinutes(value.estimate);
      if (value.deadline !== deadlineToLocal(baseRef.current!.deadline))
        deadlineFromLocal(value.deadline);
    },
    persist: async (value) => {
      const current = baseRef.current!;
      const saved =
        acknowledged.current ??
        (await editor.save(current, {
          title: value.title,
          notes: value.notes,
          completionCriteria: value.criteria,
          important: value.important,
          deadline:
            value.deadline === deadlineToLocal(current.deadline)
              ? current.deadline
              : deadlineFromLocal(value.deadline),
          deadlineTimeZone: !value.deadline
            ? null
            : value.deadline === deadlineToLocal(current.deadline)
              ? current.deadlineTimeZone
              : Intl.DateTimeFormat().resolvedOptions().timeZone,
          estimatedMinutes: parseMinutes(value.estimate),
        }));
      acknowledged.current = saved;
      baseRef.current = saved;
      setBase(saved);
      await onSaved();
      acknowledged.current = null;
    },
  });
  flush.current = () =>
    baseRef.current ? autosave.flush() : Promise.resolve(true);
  useEffect(() => {
    onLockedChange(
      loading || autosave.busy || autosave.dirty || autosave.pending,
    );
    return () => onLockedChange(false);
  }, [
    loading,
    autosave.busy,
    autosave.dirty,
    autosave.pending,
    onLockedChange,
  ]);
  useEffect(() => {
    if (
      observedVersion.current === task.version ||
      autosave.busy ||
      autosave.dirty ||
      autosave.pending
    )
      return;
    observedVersion.current = task.version;
    // Our own commits keep focus; clean external status changes refresh the base.
    if (baseRef.current && baseRef.current.version !== task.version)
      void read();
  }, [task.version, autosave.busy, autosave.dirty, autosave.pending, read]);
  useLayoutEffect(() => {
    const input = titleInput.current;
    if (!input) return;
    input.style.height = "auto";
    const height = input.scrollHeight + 2;
    input.style.height = Math.min(height, 160) + "px";
    input.style.overflowY = height > 160 ? "auto" : "hidden";
  }, [draft.title, loading]);
  useEffect(() => {
    if (!loading && base && !focused.current) {
      focused.current = true;
      titleInput.current?.focus();
    }
  }, [loading, base]);
  function changed<K extends keyof typeof draft>(
    field: K,
    value: (typeof draft)[K],
    discrete = false,
  ) {
    autosave.changed(discrete);
    setDraft((old) => ({ ...old, [field]: value }));
  }
  async function close() {
    if (await flush.current()) onClose();
  }
  const error = readError || autosave.error;
  return (
    <aside
      id="project-task-panel"
      className="task-detail reference-task-panel project-task-panel"
      aria-label="项目任务详情"
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          document.querySelector(".date-picker-popover,dialog[open]")
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
          projectName={projectName}
          disabled={loading || !base || autosave.busy}
          onChanging={() => flush.current()}
          onChanged={() => onReload()}
        />
        <div className="task-panel-toolbar-actions">
          <button
            type="button"
            aria-label="关闭任务详情"
            title="收起详情"
            disabled={autosave.busy}
            onClick={() => void close()}
          >
            <TaskPanelIcon name="close" />
          </button>
        </div>
      </header>
      <div className="task-panel-scroll" aria-busy={loading}>
        <form
          className="task-panel-form"
          aria-label="编辑项目任务"
          onSubmit={(e) => {
            e.preventDefault();
            void autosave.save();
          }}
          onCompositionStart={autosave.onCompositionStart}
          onCompositionEnd={autosave.onCompositionEnd}
        >
          <fieldset disabled={loading || !base}>
            <div className="task-panel-intro">
              <label className="sr-only" htmlFor="project-panel-title">
                任务标题
              </label>
              <textarea
                ref={titleInput}
                id="project-panel-title"
                aria-label="编辑任务标题"
                className="task-panel-title"
                rows={1}
                value={draft.title}
                onChange={(e) => changed("title", e.target.value)}
              />
              <TaskSubtitle
                value={draft.notes}
                disabled={loading || !base}
                onChange={(value) => changed("notes", value)}
              />
            </div>
            <div className="task-panel-field task-reminder">
              <TaskPanelIcon name="clock" />
              <DatePicker
                id="project-panel-deadline"
                label="提醒"
                mode="datetime"
                clearable
                className="date-picker-field"
                value={draft.deadline}
                disabled={loading || !base}
                display={reminderLabel(draft.deadline)}
                onChange={(value) => changed("deadline", value, true)}
              />
            </div>
            <TaskSubtasks
              taskId={task.taskId}
              disabled={loading || !base}
              onChanged={() => void onSaved()}
            />
            <TaskWorkload
              estimate={draft.estimate}
              disabled={loading || !base}
              onChange={(minutes) => changed("estimate", minutes, true)}
            />
            <TaskDescription
              value={draft.notes}
              disabled={loading || !base}
              onChange={(value) => changed("notes", value)}
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
              <button
                disabled={autosave.busy}
                onClick={() => void autosave.save()}
              >
                重试自动保存
              </button>
            )}
            <button disabled={autosave.busy} onClick={onReload}>
              重新加载（放弃本次编辑）
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
    </aside>
  );
}
