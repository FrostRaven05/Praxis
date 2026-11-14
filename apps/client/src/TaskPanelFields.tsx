import { TaskPanelIcon } from "./TaskPanelIcon";

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const levels = [
  ["", "一般"],
  ["30", "中等难度"],
  ["60", "较高难度"],
] as const;

export function specificDateLabel(date: string) {
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "选择日期";
  const weekday = weekdays[new Date(`${day}T12:00:00`).getDay()];
  return `${Number(day.slice(5, 7))}月${Number(day.slice(-2))}日 ${weekday}`;
}

export function reminderLabel(value: string) {
  if (!value) return "添加提醒";
  return specificDateLabel(value.slice(0, 10));
}

export function workloadValue(estimate: string) {
  const minutes = Number(estimate);
  if (!estimate.trim() || !Number.isFinite(minutes) || minutes < 25) return "";
  if (minutes < 50) return "30";
  return "60";
}

export function TaskWorkload({
  estimate,
  disabled,
  onChange,
}: {
  estimate: string;
  disabled?: boolean;
  onChange: (minutes: string) => void;
}) {
  const selected = workloadValue(estimate);
  return (
    <div className="task-panel-field task-workload">
      <TaskPanelIcon name="work" />
      <span>工作量</span>
      <div className="task-effort-options" role="group" aria-label="工作量">
        {levels.map(([minutes, label]) => (
          <button
            key={label}
            type="button"
            aria-pressed={selected === minutes}
            disabled={disabled}
            onClick={() => onChange(minutes)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
