import {
  planChange,
  type DailyTask,
  type PlanChange,
} from "@praxis/application";
export function PlanControls({
  task,
  busy,
  onChange,
}: {
  task: DailyTask;
  busy: boolean;
  onChange: (change: PlanChange) => Promise<void>;
}) {
  return (
    <div className="plan-controls">
      <button
        aria-label={task.isFocus ? "取消重点" : "设为重点"}
        title={task.isFocus ? "取消重点" : "设为重点"}
        aria-pressed={task.isFocus ?? false}
        disabled={busy}
        onClick={() => {
          void onChange({ ...planChange(task), isFocus: !task.isFocus });
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"
            fill={task.isFocus ? "currentColor" : "none"}
          />
        </svg>
      </button>
    </div>
  );
}
