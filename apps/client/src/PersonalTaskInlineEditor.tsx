import { useEffect, useRef, useState } from "react";
import {
  personalDeadlineDay,
  timeLabel,
  type PersonalTaskChange,
  type WorkTask,
} from "@praxis/application";
import { personalInlineEdit } from "./personal-task-editor";
import { useImeSubmit } from "./useImeSubmit";
import { quickDates } from "./PersonalTaskComposer";
import "./personal-task-inline.css";
export function PersonalTaskInlineEditor({
  task,
  locked,
  stale,
  failure,
  onRetry,
  onSave,
  onCancel,
}: {
  task: WorkTask;
  locked: boolean;
  stale: boolean;
  failure: string;
  onRetry?: (() => void) | undefined;
  onSave: (change: PersonalTaskChange) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(task.title),
    [notes, setNotes] = useState(task.notes),
    [date, setDate] = useState(personalDeadlineDay(task.deadline) ?? ""),
    [editDeadline, setEditDeadline] = useState(false),
    [error, setError] = useState("");
  const ime = useImeSubmit();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 700px)").matches)
      form.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <form
      ref={form}
      className="personal-task-inline-editor"
      aria-label={`行内编辑：${task.title}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !locked && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (locked || stale || ime.blocked()) return;
        try {
          const change = personalInlineEdit(task, {
            title,
            notes,
            date,
            editDeadline,
          });
          if (Object.keys(change).length === 1) onCancel();
          else onSave(change);
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      <input
        className="pie-title"
        aria-label="任务标题"
        placeholder="任务标题"
        autoFocus
        required
        value={title}
        disabled={locked}
        onChange={(e) => setTitle(e.target.value)}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={ime.onKeyDown}
      />
      <textarea
        className="pie-notes"
        aria-label="任务说明"
        placeholder="备注（可选）"
        rows={2}
        value={notes}
        disabled={locked}
        onChange={(e) => setNotes(e.target.value)}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
      />
      {task.deadline?.kind === "instant" && !editDeadline ? (
        <div className="personal-task-old-deadline">
          <span>
            截止 {timeLabel(task.deadline, task.deadline.displayTimezone)}
          </span>
          <button
            type="button"
            disabled={locked}
            onClick={() => setEditDeadline(true)}
          >
            修改截止日期
          </button>
        </div>
      ) : (
        <div className="pie-dates" role="group" aria-label="截止日期">
          {quickDates().map((q) => (
            <button
              key={q.label}
              type="button"
              data-on={date === q.date || undefined}
              disabled={locked}
              onClick={() => {
                setDate(date === q.date ? "" : q.date);
                setEditDeadline(true);
              }}
            >
              {q.label}
            </button>
          ))}
          <input
            type="date"
            aria-label="指定截止日期"
            value={date}
            disabled={locked}
            onChange={(e) => {
              setDate(e.target.value);
              setEditDeadline(true);
            }}
          />
          {date && (
            <button
              type="button"
              className="pie-clear"
              disabled={locked}
              onClick={() => {
                setDate("");
                setEditDeadline(true);
              }}
            >
              清除
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {failure && (
        <p role="alert">
          {failure}
          {onRetry ? "。保存结果未确认，请重试原操作。" : ""}
        </p>
      )}
      {onRetry && (
        <button type="button" autoFocus onClick={onRetry}>
          重试原操作
        </button>
      )}
      {stale && (
        <p role="alert">
          任务版本已变化，草稿仍保留。取消行内编辑后重新读取，避免覆盖新编辑。
        </p>
      )}
      <div className="personal-task-inline-actions">
        <button type="submit" className="primary" disabled={locked || stale}>
          保存修改
        </button>
        <button type="button" disabled={locked} onClick={onCancel}>
          取消编辑
        </button>
      </div>
    </form>
  );
}
