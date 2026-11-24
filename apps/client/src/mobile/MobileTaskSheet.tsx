import { useEffect, useRef, useState } from "react";
import { dayPeriods, type DayPeriod } from "@praxis/application";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { feedbackMessage } from "../feedback-message";
import { TaskCompletionButton } from "../TaskCompletionButton";
import { TaskDescription, TaskSubtitle } from "../TaskDescription";
import { useImeSubmit } from "../useImeSubmit";
import "./quick-task-entry.css";

const text = (entity: WorkspaceEntity, key: string) =>
  String(entity.data[key] ?? "");

function shifted(date: string, n: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const periodLabels: Record<DayPeriod, string> = {
  morning: "早上",
  afternoon: "中午",
  evening: "晚上",
};

function shortDate(date: string) {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

const taskStatusOptions = [
  ["todo", "待办"],
  ["in_progress", "进行中"],
  ["blocked", "受阻"],
  ["completed", "已完成"],
  ["cancelled", "已取消"],
] as const;

export function MobileTaskSheet({
  entity,
  today,
  tasks,
  projects,
  sections,
  busy,
  error,
  onRetry,
  onSave,
  onClose,
  onToggleSubtask,
  onAddSubtask,
  onStartPomodoro,
  onOpenInspiration,
}: {
  entity: WorkspaceEntity;
  today: string;
  tasks: WorkspaceEntity[];
  projects: WorkspaceEntity[];
  sections: WorkspaceEntity[];
  busy: boolean;
  error: string;
  onRetry: (() => void) | undefined;
  onSave: (data: Record<string, unknown>, deleted?: boolean) => void;
  onClose: () => void;
  onToggleSubtask?: (subtask: WorkspaceEntity) => Promise<void> | void;
  onAddSubtask?: (parent: WorkspaceEntity, title: string) => Promise<void> | void;
  onStartPomodoro?: (task: { id: string; title: string }) => void;
  onOpenInspiration?: (taskId: string) => void;
}) {
  const [data, setData] = useState(entity.data);
  const [dirty, setDirty] = useState(false);
  const [tagInput, setTagInput] = useState(
    Array.isArray(entity.data.tags) ? entity.data.tags.join(", ") : "",
  );
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [subtaskBusy, setSubtaskBusy] = useState(false);
  const [subtaskError, setSubtaskError] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const ime = useImeSubmit();
  const isExistingTask = entity.kind === "task" && entity.version > 0;

  useEffect(() => {
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (dialog && !dialog.open) dialog.showModal();
    if (entity.kind === "task" && !entity.version) {
      dialog
        ?.querySelector<HTMLInputElement>(".pm-sheet-title-input")
        ?.focus({ preventScroll: true });
    }
    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = overflow;
    };
  }, [entity.id, entity.kind, entity.version]);

  function update(key: string, value: unknown) {
    setData((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function close() {
    if (
      !busy &&
      !subtaskBusy &&
      (!dirty || window.confirm("放弃尚未保存的修改？"))
    )
      onClose();
  }

  const field = (key: string) => String(data[key] ?? "");
  const tomorrow = shifted(today, 1);
  const isCompleted = field("status") === "completed";
  const currentPeriod: DayPeriod =
    data.dayPeriod === "afternoon" || data.dayPeriod === "evening"
      ? data.dayPeriod
      : "morning";
  const executionDate = field("executionDate");
  const customExecutionDate = Boolean(
    executionDate && executionDate !== today && executionDate !== tomorrow,
  );
  const subtasks =
    isExistingTask && !data.parentId
      ? tasks
          .filter(
            (t) =>
              !t.deleted &&
              t.data.parentId === entity.id &&
              t.data.status !== "cancelled",
          )
          .sort((a, b) => {
            const rankA = Number(
              (a.data.desktop as Record<string, unknown> | undefined)?.task_rank ??
                Number.MAX_SAFE_INTEGER,
            );
            const rankB = Number(
              (b.data.desktop as Record<string, unknown> | undefined)?.task_rank ??
                Number.MAX_SAFE_INTEGER,
            );
            return (
              rankA - rankB ||
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id)
            );
          })
      : [];

  async function submitSubtask() {
    const trimmed = subtaskTitle.trim();
    if (!trimmed || !onAddSubtask || subtaskBusy || busy) return;
    setSubtaskBusy(true);
    setSubtaskError("");
    try {
      await onAddSubtask(entity, trimmed);
      setSubtaskTitle("");
    } catch (caught) {
      setSubtaskError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubtaskBusy(false);
    }
  }

  function confirmDelete() {
    const descendants = new Set<string>();
    function collect(id: string) {
      for (const child of tasks.filter((t) => t.data.parentId === id)) {
        if (!descendants.has(child.id)) {
          descendants.add(child.id);
          collect(child.id);
        }
      }
    }
    collect(entity.id);
    const impact =
      entity.kind === "project"
        ? `将同时处理 ${tasks.filter((t) => t.data.projectId === entity.id).length} 个关联任务和 ${sections.filter((s) => s.data.projectId === entity.id).length} 个分区。`
        : `将同时处理 ${descendants.size} 个子任务。`;
    if (
      window.confirm(
        `移入回收站？${descendants.size || entity.kind === "project" ? impact : ""}`,
      )
    ) {
      onSave(data, true);
    }
  }

  return (
    <dialog
      ref={ref}
      className={`pm-dialog pm-task-sheet${entity.kind === "task" ? " is-task-detail" : ""}`}
      aria-label={
        entity.kind === "task"
          ? isExistingTask
            ? "任务详情"
            : "新建任务"
          : entity.version
            ? "编辑项目"
            : "新建项目"
      }
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < bounds.left ||
          e.clientX > bounds.right ||
          e.clientY < bounds.top ||
          e.clientY > bounds.bottom
        ) {
          close();
        }
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            entity.kind === "task"
              ? {
                  ...data,
                  title: field("title").trim(),
                  tags: tagInput
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : data,
          );
        }}
      >
        {entity.kind === "task" ? (
          <>
            <div className="pm-entry-handle" aria-hidden="true" />
            <header className="pm-entry-header">
              <div className="pm-entry-top-pills" role="group" aria-label="时段">
                {executionDate ? (
                  dayPeriods.map((period) => (
                    <button
                      key={period}
                      type="button"
                      className="pm-entry-chip"
                      aria-pressed={currentPeriod === period}
                      disabled={busy || subtaskBusy}
                      onClick={() => update("dayPeriod", period)}
                    >
                      {periodLabels[period]}
                    </button>
                  ))
                ) : (
                  <span className="pm-entry-chip is-static">待办</span>
                )}
              </div>
              <div className="pm-entry-header-right">
                <button
                  type="submit"
                  className="pm-entry-save-text"
                  disabled={busy || subtaskBusy || !field("title").trim()}
                >
                  {busy ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  className="pm-entry-close"
                  onClick={close}
                  disabled={busy || subtaskBusy}
                  aria-label="关闭编辑"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="m7 7 10 10M17 7 7 17" />
                  </svg>
                </button>
              </div>
            </header>

            {error && (
              <p role="alert" className="pm-error">
                {feedbackMessage(error)}
                {onRetry && (
                  <button type="button" disabled={busy} onClick={onRetry}>
                    重试原操作
                  </button>
                )}
              </p>
            )}

            <input
              className="pm-sheet-title-input"
              aria-label="名称"
              placeholder="准备做什么？"
              autoFocus={!isExistingTask}
              required
              value={field("title")}
              onChange={(e) => update("title", e.target.value)}
            />
            <TaskSubtitle
              value={field("notes")}
              disabled={busy || subtaskBusy}
              onChange={(next) => update("notes", next)}
            />

            <div className="pm-entry-date-capsule" role="group" aria-label="安排日期">
              <button
                type="button"
                aria-pressed={executionDate === today}
                onClick={() => {
                  update("executionDate", today);
                  if (!data.dayPeriod) update("dayPeriod", "morning");
                }}
              >
                今天
              </button>
              <button
                type="button"
                aria-pressed={executionDate === tomorrow}
                onClick={() => {
                  update("executionDate", tomorrow);
                  if (!data.dayPeriod) update("dayPeriod", "morning");
                }}
              >
                明天
              </button>
              <label className={customExecutionDate ? "is-selected" : ""}>
                <span>
                  {customExecutionDate ? `${shortDate(executionDate)} ▾` : "选日期 ▾"}
                </span>
                <input
                  type="date"
                  aria-label="选择安排日期"
                  value={executionDate}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    update("executionDate", next);
                    if (next && !data.dayPeriod) update("dayPeriod", "morning");
                  }}
                />
              </label>
              {executionDate && (
                <button
                  type="button"
                  className="pm-entry-date-clear"
                  aria-label="清除日期"
                  onClick={() => update("executionDate", null)}
                >
                  ×
                </button>
              )}
            </div>

            {isExistingTask && !data.parentId && (
              <section className="pm-sheet-subtasks-inline" aria-label="子任务">
                {subtaskError && (
                  <p role="alert" className="pm-error">
                    {feedbackMessage(subtaskError)}
                  </p>
                )}
                {subtasks.length > 0 && (
                  <ul className="pm-sheet-subtask-list">
                    {subtasks.map((sub) => {
                      const done = text(sub, "status") === "completed";
                      return (
                        <li
                          key={sub.id}
                          className={done ? "completed" : undefined}
                        >
                          <TaskCompletionButton
                            title={text(sub, "title")}
                            completed={done}
                            busy={subtaskBusy}
                            disabled={busy || subtaskBusy || !onToggleSubtask}
                            onToggle={() => {
                              if (!onToggleSubtask || subtaskBusy) return;
                              setSubtaskBusy(true);
                              setSubtaskError("");
                              void Promise.resolve(onToggleSubtask(sub))
                                .catch((caught) =>
                                  setSubtaskError(
                                    caught instanceof Error
                                      ? caught.message
                                      : String(caught),
                                  ),
                                )
                                .finally(() => setSubtaskBusy(false));
                            }}
                          />
                          <span>{text(sub, "title")}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {onAddSubtask && (
                  <div className="pm-sheet-subtask-row">
                    <svg
                      className="pm-sheet-subtask-icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M6 4v9a4 4 0 0 0 4 4h8" />
                      <path d="m14 13 4 4-4 4" />
                    </svg>
                    <input
                      aria-label="添加子任务"
                      placeholder={`添加子任务 (${subtasks.length}/20)`}
                      value={subtaskTitle}
                      disabled={busy || subtaskBusy}
                      onChange={(e) => setSubtaskTitle(e.target.value)}
                      onCompositionStart={ime.onCompositionStart}
                      onCompositionEnd={ime.onCompositionEnd}
                      onKeyDown={(e) => {
                        ime.onKeyDown(e);
                        if (
                          !e.defaultPrevented &&
                          e.key === "Enter" &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void submitSubtask();
                        }
                      }}
                    />
                    {subtaskTitle.trim() && (
                      <button
                        type="button"
                        className="pm-sheet-subtask-add-btn"
                        disabled={busy || subtaskBusy}
                        onClick={() => void submitSubtask()}
                      >
                        {subtaskBusy ? "…" : "添加"}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            <TaskDescription
              value={field("notes")}
              disabled={busy || subtaskBusy}
              onChange={(next) => update("notes", next)}
            />

            <details className="pm-sheet-extra">
              <summary>任务属性</summary>
              <div className="pm-sheet-extra-body">
                <div className="pm-sheet-field">
                  <span className="pm-sheet-label">状态</span>
                  <div
                    className="pm-status-pills"
                    role="radiogroup"
                    aria-label="状态"
                  >
                    {taskStatusOptions.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={field("status") === value}
                        onClick={() => update("status", value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <label>
                  项目
                  <select
                    value={field("projectId")}
                    onChange={(e) => {
                      setData((prev) => ({
                        ...prev,
                        projectId: e.target.value || null,
                        parentId: null,
                        sectionId: null,
                      }));
                      setDirty(true);
                    }}
                  >
                    <option value="">独立任务</option>
                    {projects
                      .filter(
                        (p) =>
                          p.data.status === "active" || p.id === data.projectId,
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {text(p, "title")}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  父任务
                  <select
                    value={field("parentId")}
                    onChange={(e) => {
                      const parent = tasks.find((t) => t.id === e.target.value);
                      setData((prev) => ({
                        ...prev,
                        parentId: parent?.id ?? null,
                        sectionId:
                          parent?.data.sectionId ?? prev.sectionId ?? null,
                      }));
                      setDirty(true);
                    }}
                  >
                    <option value="">顶层任务</option>
                    {tasks
                      .filter(
                        (t) =>
                          t.id !== entity.id &&
                          (t.data.projectId || null) === (data.projectId || null),
                      )
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {text(t, "title")}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  分区
                  <select
                    value={field("sectionId")}
                    disabled={Boolean(data.parentId)}
                    onChange={(e) => update("sectionId", e.target.value || null)}
                  >
                    <option value="">未分区</option>
                    {sections
                      .filter((s) => s.data.projectId === data.projectId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {text(s, "title")}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="pm-form-grid">
                  {[
                    ["startDate", "开始日期"],
                    ["dueDate", "真实期限"],
                    ["followUpDate", "跟进日期"],
                  ].map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="date"
                        value={field(key!)}
                        onChange={(e) => update(key!, e.target.value || null)}
                      />
                    </label>
                  ))}
                </div>
                {field("executionDate") &&
                  field("dueDate") &&
                  field("executionDate") > field("dueDate") && (
                    <p role="status">安排日期晚于真实期限，请确认是否需要调整。</p>
                  )}
                <label>
                  标签（逗号分隔）
                  <input
                    value={tagInput}
                    onChange={(e) => {
                      setTagInput(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <label className="pm-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(data.waiting)}
                    onChange={(e) => update("waiting", e.target.checked)}
                  />
                  等待他人 / 等待跟进
                </label>
                {Boolean(data.waiting) && (
                  <>
                    <label>
                      等待对象
                      <input
                        value={field("waitingFor")}
                        onChange={(e) => update("waitingFor", e.target.value)}
                      />
                    </label>
                    <label>
                      等待原因
                      <input
                        value={field("waitingReason")}
                        onChange={(e) => update("waitingReason", e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
            </details>

            <div className="pm-sheet-action-bar">
              <div className="pm-sheet-action-left">
                {isExistingTask && !isCompleted && onStartPomodoro && (
                  <button
                    type="button"
                    className="pm-sheet-circle-btn"
                    aria-label="开始专注"
                    title="开始专注"
                    disabled={busy}
                    onClick={() =>
                      onStartPomodoro({
                        id: entity.id,
                        title: field("title") || "未命名任务",
                      })
                    }
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="13" r="7" />
                      <path d="M12 9v4l2.5 1.5M9.5 3h5" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="pm-sheet-action-right">
                {isExistingTask && !isCompleted && !data.parentId && onOpenInspiration && (
                  <button
                    type="button"
                    className="pm-sheet-circle-btn is-ai"
                    aria-label="AI 灵感拆解"
                    title="AI 灵感拆解"
                    disabled={busy}
                    onClick={() => onOpenInspiration(entity.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 18h6M10 21h4" />
                      <path d="M8.2 14.2A6 6 0 1 1 15.8 14c-.6.7-1.1 1.5-1.3 2.4H9.5c-.2-.9-.7-1.7-1.3-2.2Z" />
                    </svg>
                  </button>
                )}
                {entity.version > 0 && (
                  <button
                    type="button"
                    className="pm-sheet-circle-btn is-danger"
                    aria-label="移入回收站"
                    title="移入回收站"
                    disabled={busy || subtaskBusy}
                    onClick={confirmDelete}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="pm-dialog-top">
              <h2>{entity.version ? "编辑项目" : "新建项目"}</h2>
              <button
                type="button"
                className="pm-sheet-close"
                onClick={close}
                disabled={busy || subtaskBusy}
                aria-label="关闭编辑"
              >
                ×
              </button>
            </div>
            {error && (
              <p role="alert" className="pm-error">
                {feedbackMessage(error)}
                {onRetry && (
                  <button type="button" disabled={busy} onClick={onRetry}>
                    重试原操作
                  </button>
                )}
              </p>
            )}
            <label>
              名称
              <input
                autoFocus={!entity.version}
                required
                value={field("title")}
                onChange={(e) => update("title", e.target.value)}
              />
            </label>
            <label>
              状态
              <select
                value={field("status")}
                onChange={(e) => update("status", e.target.value)}
              >
                {[
                  ["active", "进行中"],
                  ["completed", "完成"],
                  ["cancelled", "取消"],
                ].map(([v, l]) => (
                  <option value={v} key={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-checkbox">
              <input
                type="checkbox"
                checked={Boolean(data.archivedAt)}
                disabled={
                  !["completed", "cancelled"].includes(String(data.status))
                }
                onChange={(e) =>
                  update(
                    "archivedAt",
                    e.target.checked ? new Date().toISOString() : null,
                  )
                }
              />
              归档已结束项目
            </label>
            <label>
              完成标准
              <textarea
                rows={2}
                value={field("completionCriteria")}
                onChange={(e) => update("completionCriteria", e.target.value)}
              />
            </label>
            <label>
              主要阻塞
              <textarea
                rows={2}
                value={field("blocker")}
                onChange={(e) => update("blocker", e.target.value)}
              />
            </label>
            <label>
              复查日期
              <input
                type="date"
                value={field("reviewDate")}
                onChange={(e) => update("reviewDate", e.target.value || null)}
              />
            </label>
            <label>
              恢复卡 · 下次从哪里继续
              <textarea
                rows={4}
                value={field("recoveryNote")}
                onChange={(e) => update("recoveryNote", e.target.value)}
              />
            </label>
            <label>
              下一步
              <select
                value={field("nextActionId")}
                onChange={(e) => update("nextActionId", e.target.value || null)}
              >
                <option value="">暂不指定</option>
                {tasks
                  .filter(
                    (t) =>
                      t.data.projectId === entity.id &&
                      !["completed", "cancelled"].includes(
                        String(t.data.status),
                      ),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {text(t, "title")}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        {entity.kind !== "task" && (
          <>
            <div className="pm-dialog-actions">
              <button type="button" disabled={busy || subtaskBusy} onClick={close}>
                取消
              </button>
              <button
                className="pm-primary"
                disabled={busy || subtaskBusy || !field("title").trim()}
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
            {entity.version > 0 && (
              <button
                className="pm-delete"
                type="button"
                disabled={busy || subtaskBusy}
                onClick={confirmDelete}
              >
                移到回收站
              </button>
            )}
          </>
        )}
      </form>
    </dialog>
  );
}

export function MobileTaskActionSheet({
  task,
  currentPeriod,
  scheduledOnDate,
  busy,
  onClose,
  onChangePeriod,
  onStartPomodoro,
  onOpenInspiration,
  onAddSubtask,
  onUnschedule,
  onEdit,
  onDelete,
}: {
  task: WorkspaceEntity;
  currentPeriod: DayPeriod;
  scheduledOnDate: boolean;
  busy: boolean;
  onClose: () => void;
  onChangePeriod: (period: DayPeriod) => void;
  onStartPomodoro: () => void;
  onOpenInspiration: () => void;
  onAddSubtask: () => void;
  onUnschedule: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = text(task, "title") || "未命名任务";
  const completed = text(task, "status") === "completed";

  useEffect(() => {
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="pm-dialog pm-action-sheet"
      aria-label={`任务操作：${title}`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="pm-action-sheet-body">
        <div className="pm-entry-handle" aria-hidden="true" />
        <header className="pm-action-sheet-head">
          <h2>{title}</h2>
          <button
            type="button"
            aria-label="关闭操作菜单"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {scheduledOnDate && !completed && (
          <div className="pm-action-period-block">
            <span>安排时段</span>
            <div className="pm-period-segment" role="group" aria-label="切换时段">
              {dayPeriods.map((period) => (
                <button
                  key={period}
                  type="button"
                  disabled={busy}
                  aria-pressed={currentPeriod === period}
                  onClick={() => onChangePeriod(period)}
                >
                  {periodLabels[period]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="pm-action-sheet-list">
          {!completed && (
            <>
              <button type="button" disabled={busy} onClick={onStartPomodoro}>
                ▶ 用番茄钟执行
              </button>
              {!task.data.parentId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onOpenInspiration}
                >
                  ✦ 帮我起个头 / 拆子任务
                </button>
              )}
              <button type="button" disabled={busy} onClick={onAddSubtask}>
                ＋ 添加子任务
              </button>
            </>
          )}
          {scheduledOnDate && (
            <button type="button" disabled={busy} onClick={onUnschedule}>
              移出今日
            </button>
          )}
          <button type="button" disabled={busy} onClick={onEdit}>
            编辑详情
          </button>
          <button
            type="button"
            className="pm-delete"
            disabled={busy}
            onClick={onDelete}
          >
            移到回收站
          </button>
        </div>
      </div>
    </dialog>
  );
}
