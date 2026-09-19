import { useState } from "react";
import {
  parseMinutes,
  planChange,
  type DailyTask,
  type PlanChange,
} from "@praxis/application";
export function PlanControls({
  task,
  busy,
  onChange,
  onMove,
  canUp,
  canDown,
}: {
  task: DailyTask;
  busy: boolean;
  onChange: (change: PlanChange) => Promise<void>;
  onMove: (direction: number) => void;
  canUp: boolean;
  canDown: boolean;
}) {
  const [estimate, setEstimate] = useState(
    task.estimatedMinutes?.toString() ?? "",
  );
  const [error, setError] = useState("");
  return (
    <div className="plan-controls">
      <button
        aria-label={task.isFocus ? "取消重点" : "设为重点"}
        aria-pressed={task.isFocus ?? false}
        disabled={busy}
        onClick={() => {
          void onChange({ ...planChange(task), isFocus: !task.isFocus });
        }}
      >
        {task.isFocus ? "★" : "☆"}
      </button>
      <details className="task-more">
        <summary aria-label="更多任务操作">
          {task.estimatedMinutes ? task.estimatedMinutes + " 分钟 · " : ""}更多
        </summary>
        {task.isFocus && (
          <>
            <button
              aria-label="重点上移"
              disabled={busy || !canUp}
              onClick={() => onMove(-1)}
            >
              ↑
            </button>
            <button
              aria-label="重点下移"
              disabled={busy || !canDown}
              onClick={() => onMove(1)}
            >
              ↓
            </button>
          </>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            void Promise.resolve()
              .then(() =>
                onChange({
                  ...planChange(task),
                  estimatedMinutes: parseMinutes(estimate),
                }),
              )
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
          }}
        >
          <input
            aria-label="预计投入分钟"
            type="number"
            min="1"
            max="1440"
            placeholder="待估时"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            disabled={busy}
          />
          <button aria-label="保存估时" disabled={busy}>
            保存
          </button>
        </form>
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
      </details>
    </div>
  );
}
