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
  taskStates,
  type ProjectTask,
  type TaskDetails,
} from "@praxis/application";
import { taskDetailsStorage } from "./storage";
import { useAutosave } from "./useAutosave";
import { DatePicker } from "./DatePicker";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { RelatedRecords } from "./RelatedRecords";
import { WorkTaskProperties } from "./WorkTaskProperties";

const editor = new TaskDetailEditor(taskDetailsStorage);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectTaskPanel({
  task,
  projectName,
  flush,
  onSaved,
  onClose,
  onLockedChange,
  onReload,
}: {
  task: ProjectTask;
  projectName: string;
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
  const [propertiesBusy, setPropertiesBusy] = useState(false);
  const [readError, setReadError] = useState("");
  const acknowledged = useRef<TaskDetails | null>(null);
  const generation = useRef(0);
  const observedVersion = useRef(task.version);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const notesInput = useRef<HTMLTextAreaElement>(null);
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
      loading ||
        propertiesBusy ||
        autosave.busy ||
        autosave.dirty ||
        autosave.pending,
    );
    return () => onLockedChange(false);
  }, [
    loading,
    propertiesBusy,
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
    for (const input of [titleInput.current, notesInput.current]) {
      if (!input) continue;
      input.style.height = "auto";
      const height = input.scrollHeight + 2;
      input.style.height = Math.min(height, 160) + "px";
      input.style.overflowY = height > 160 ? "auto" : "hidden";
    }
  }, [draft.title, draft.notes, loading]);
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
    if (propertiesBusy) return;
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
        <span className="task-status-pill">
          {taskStates[base?.status ?? task.status]}
        </span>
        <span className="task-status-pill">项目任务</span>
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
          <fieldset disabled={loading || !base || propertiesBusy}>
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
              <label className="sr-only" htmlFor="project-panel-notes">
                任务描述
              </label>
              <textarea
                ref={notesInput}
                id="project-panel-notes"
                aria-label="任务描述"
                className="task-panel-notes"
                rows={1}
                placeholder="添加描述"
                value={draft.notes}
                onChange={(e) => changed("notes", e.target.value)}
              />
            </div>
            <div className="task-panel-field">
              <TaskPanelIcon name="clock" />
              <div className="task-panel-field-body">
                <label htmlFor="project-panel-deadline">截止时间</label>
                <DatePicker
                  id="project-panel-deadline"
                  label="截止时间（本地时间）"
                  mode="datetime"
                  clearable
                  className="date-picker-field"
                  value={draft.deadline}
                  disabled={loading || !base}
                  onChange={(value) => changed("deadline", value, true)}
                />
              </div>
            </div>
            <details className="task-panel-extra">
              <summary>工作量、完成标准与重要标记</summary>
              <div className="task-panel-field">
                <TaskPanelIcon name="work" />
                <div className="task-panel-field-body">
                  <label htmlFor="project-panel-estimate">预估工作量</label>
                  <div className="task-effort-editor">
                    <div className="task-effort-options">
                      {[15, 30, 60].map((minutes) => (
                        <button
                          key={minutes}
                          type="button"
                          aria-pressed={draft.estimate === String(minutes)}
                          onClick={() =>
                            changed("estimate", String(minutes), true)
                          }
                        >
                          {minutes} 分钟
                        </button>
                      ))}
                    </div>
                    <input
                      id="project-panel-estimate"
                      aria-label="预估工作量（分钟）"
                      type="number"
                      min={1}
                      max={1440}
                      placeholder="分钟"
                      value={draft.estimate}
                      onChange={(e) => changed("estimate", e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div className="task-panel-field">
                <TaskPanelIcon name="criteria" />
                <div className="task-panel-field-body">
                  <label htmlFor="project-panel-criteria">完成标准</label>
                  <textarea
                    id="project-panel-criteria"
                    rows={2}
                    placeholder="怎样算完成这项任务？"
                    value={draft.criteria}
                    onChange={(e) => changed("criteria", e.target.value)}
                  />
                </div>
              </div>
              <div className="task-panel-field">
                <TaskPanelIcon name="check" />
                <label className="task-panel-importance">
                  <input
                    type="checkbox"
                    checked={draft.important}
                    onChange={(e) =>
                      changed("important", e.target.checked, true)
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
          disabled={
            loading || autosave.busy || autosave.dirty || autosave.pending
          }
          onSaved={async () => {
            await onSaved();
            await read();
          }}
          onBusyChange={setPropertiesBusy}
        />
        <div className="task-panel-field">
          <TaskPanelIcon name="folder" />
          <div className="task-panel-field-body">
            <span className="task-panel-field-label">所属项目</span>
            <span>{projectName}</span>
          </div>
        </div>
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
        <div className="task-panel-secondary">
          <RelatedRecords targetType="task" targetId={task.taskId} />
        </div>
      </div>
      <footer className="task-panel-footer" role="status" aria-live="polite">
        <span>
          <span className="status-dot" />
          {autosave.status}
        </span>
      </footer>
    </aside>
  );
}
