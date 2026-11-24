import { dayPeriods, type DayPeriod } from "@praxis/application";
import { feedbackMessage } from "../feedback-message";
import { TaskDescription } from "../TaskDescription";
import { useEffect, type RefObject } from "react";
import "./quick-task-entry.css";

const periodLabels: Record<DayPeriod, string> = {
  morning: "早上",
  afternoon: "中午",
  evening: "晚上",
};

const priorityLevels = [
  { value: 0, label: "一般", tone: "normal" },
  { value: 2, label: "中等", tone: "medium" },
  { value: 1, label: "较高", tone: "high" },
] as const;

function shortDate(date: string) {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

export function QuickTaskEntry({
  dialogRef,
  data,
  today,
  tomorrow,
  busy,
  error,
  onRetry,
  onChange,
  onSave,
  onClose,
  onMore,
  context,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  data: Record<string, unknown>;
  today: string;
  tomorrow: string;
  busy: boolean;
  error: string;
  onRetry: (() => void) | undefined;
  onChange: (key: string, value: unknown) => void;
  onSave: () => void;
  onClose: () => void;
  onMore: () => void;
  context: string;
}) {
  const title = String(data.title ?? ""),
    date = String(data.executionDate ?? "");
  const locked = busy || Boolean(onRetry);
  const customDate = Boolean(date && date !== today && date !== tomorrow);
  const currentPeriod: DayPeriod =
    data.dayPeriod === "afternoon" || data.dayPeriod === "evening"
      ? data.dayPeriod
      : "morning";
  const currentPriority = Number(data.priority ?? 0);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const element = dialogRef.current;
      if (!element || !viewport) return;
      element.style.bottom = `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`;
      element.style.maxHeight = `${Math.max(220, viewport.height - 16)}px`;
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
    };
  }, [dialogRef]);

  return (
    <dialog
      ref={dialogRef}
      className="pm-dialog pm-task-entry"
      aria-label="快速添加任务"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked && title.trim()) onSave();
        }}
      >
        <div className="pm-entry-handle" aria-hidden="true" />
        <header className="pm-entry-header">
          <div className="pm-entry-top-pills" role="group" aria-label="时段">
            {date ? (
              dayPeriods.map((period) => (
                <button
                  key={period}
                  type="button"
                  className="pm-entry-chip"
                  aria-pressed={currentPeriod === period}
                  disabled={locked}
                  onClick={() => onChange("dayPeriod", period)}
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
              disabled={locked || !title.trim()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="pm-entry-close"
              aria-label="关闭编辑"
              disabled={locked}
              onClick={onClose}
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
          <div className="pm-entry-error" role="alert">
            {feedbackMessage(error)}
            {onRetry && (
              <button type="button" disabled={busy} onClick={onRetry}>
                重试原操作
              </button>
            )}
          </div>
        )}

        <fieldset disabled={locked} className="pm-entry-fields">
          <input
            className="pm-entry-title"
            aria-label="名称"
            placeholder="准备做什么？"
            autoFocus
            autoComplete="off"
            enterKeyHint="done"
            required
            value={title}
            onChange={(event) => onChange("title", event.target.value)}
          />
          <TaskDescription
            value={String(data.notes ?? "")}
            disabled={locked}
            onChange={(next) => onChange("notes", next)}
          />

          <div className="pm-entry-date-capsule" role="group" aria-label="安排日期">
            <button
              type="button"
              aria-pressed={date === today}
              onClick={() => onChange("executionDate", today)}
            >
              今天
            </button>
            <button
              type="button"
              aria-pressed={date === tomorrow}
              onClick={() => onChange("executionDate", tomorrow)}
            >
              明天
            </button>
            <label className={customDate ? "is-selected" : ""}>
              <span>{customDate ? `${shortDate(date)} ▾` : "选日期 ▾"}</span>
              <input
                type="date"
                aria-label="选择安排日期"
                value={date}
                onChange={(event) =>
                  onChange("executionDate", event.target.value || null)
                }
              />
            </label>
            {date && (
              <button
                type="button"
                className="pm-entry-date-clear"
                aria-label="清除日期"
                onClick={() => onChange("executionDate", null)}
              >
                ×
              </button>
            )}
          </div>

          <div className="pm-entry-priority-row">
            <span className="pm-entry-row-label">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 20V5m0 0h11l-2.5 4.5L15 14H4" />
              </svg>
              优先级
            </span>
            <div className="pm-entry-priority-seg" role="radiogroup" aria-label="优先级">
              {priorityLevels.map((level) => {
                const selected =
                  level.value === 0
                    ? currentPriority === 0 || currentPriority === 3
                    : currentPriority === level.value;
                return (
                  <button
                    key={level.value}
                    type="button"
                    role="radio"
                    data-tone={level.tone}
                    aria-checked={selected}
                    onClick={() => onChange("priority", level.value)}
                  >
                    {level.label}
                  </button>
                );
              })}
            </div>
          </div>

          <footer className="pm-entry-toolbar">
            <button
              type="button"
              className="pm-entry-tool-pill"
              onClick={onMore}
            >
              更多选项 ›
            </button>
            {context && <span className="pm-entry-context">{context}</span>}
          </footer>
        </fieldset>
      </form>
    </dialog>
  );
}
