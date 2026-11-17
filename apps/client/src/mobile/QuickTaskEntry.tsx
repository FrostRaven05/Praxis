import { feedbackMessage } from "../feedback-message";
import { useEffect, type RefObject } from "react";
import "./quick-task-entry.css";

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
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const element = dialogRef.current;
      if (!element || !viewport) return;
      element.style.bottom = `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`;
      element.style.maxHeight = `${Math.max(180, viewport.height - 16)}px`;
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
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          <h2>新任务</h2>
          <button
            type="submit"
            className="pm-entry-submit"
            disabled={locked || !title.trim()}
          >
            {busy ? "添加中…" : "添加"}
          </button>
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
          <textarea
            className="pm-entry-notes"
            aria-label="任务描述"
            placeholder="添加描述"
            rows={2}
            value={String(data.notes ?? "")}
            onChange={(event) => onChange("notes", event.target.value)}
          />
          <div className="pm-entry-dates" role="group" aria-label="安排日期">
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
              <span>
                {customDate
                  ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
                  : "选择日期"}
              </span>
              <input
                type="date"
                aria-label="选择安排日期"
                value={date}
                onChange={(event) =>
                  onChange("executionDate", event.target.value || null)
                }
              />
            </label>
            <button
              type="button"
              aria-pressed={!date}
              onClick={() => onChange("executionDate", null)}
            >
              没有日期
            </button>
          </div>
          <footer className="pm-entry-footer">
            <button type="button" onClick={onMore}>
              更多选项 <span aria-hidden="true">›</span>
            </button>
            {context && <span className="pm-entry-context">{context}</span>}
          </footer>
        </fieldset>
      </form>
    </dialog>
  );
}
