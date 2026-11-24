import { useState } from "react";
import type { WorkTask } from "@praxis/application";
import type { NextStepHandoff } from "./next-step-handoff";
import "./next-step.css";

export function NextStepBanner({
  handoff,
  disabled = false,
  onStartPomodoro,
  onScheduleToday,
  onCompleteParent,
  onOpenTask,
  onDismiss,
}: {
  handoff: NextStepHandoff;
  disabled?: boolean;
  onStartPomodoro?: (task: WorkTask) => void | Promise<void>;
  onScheduleToday?: (task: WorkTask) => void | Promise<void>;
  onCompleteParent?: (task: WorkTask) => void | Promise<void>;
  onOpenTask?: (task: WorkTask) => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [doneNotice, setDoneNotice] = useState("");

  async function run(action: () => void | Promise<void>, successText?: string) {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await action();
      if (successText) setDoneNotice(successText);
    } catch {
      /* Caller surfaces persistence errors. */
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="next-step-banner"
      data-kind={handoff.kind}
      role="status"
      aria-label="下一步接力建议"
    >
      <div className="next-step-body">
        <span className="next-step-kicker">下一步</span>
        <div className="next-step-text">
          <p className="next-step-headline">{handoff.headline}</p>
          <strong className="next-step-target">
            {handoff.target.title}
            {handoff.projectName && (
              <small> · {handoff.projectName}</small>
            )}
          </strong>
          {doneNotice && <small className="next-step-done">{doneNotice}</small>}
        </div>
      </div>
      <div className="next-step-actions">
        {handoff.kind === "complete_parent" && onCompleteParent ? (
          <button
            type="button"
            className="primary"
            disabled={busy || disabled}
            onClick={() => void run(() => onCompleteParent(handoff.target))}
          >
            ✓ 完成父任务
          </button>
        ) : (
          <>
            {onStartPomodoro && (
              <button
                type="button"
                className="primary"
                disabled={busy || disabled}
                onClick={() =>
                  void run(
                    () => onStartPomodoro(handoff.target),
                    "已启动番茄钟",
                  )
                }
              >
                ▶ 番茄钟开干
              </button>
            )}
            {!handoff.alreadyOnToday && onScheduleToday && (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() =>
                  void run(
                    () => onScheduleToday(handoff.target),
                    "已加入今日",
                  )
                }
              >
                + 加入今日
              </button>
            )}
            {onOpenTask && (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => onOpenTask(handoff.target)}
              >
                查看
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="next-step-close"
          aria-label="关闭下一步提示"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </aside>
  );
}
