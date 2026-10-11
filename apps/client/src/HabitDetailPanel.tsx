import { useEffect } from "react";
import { dayPeriodLabels } from "@praxis/application";
import type { Row } from "./HabitsView";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { useProjectList } from "./useProjectList";

function frequency(row: Row) {
  const rule = row.schedule;
  if ((rule?.intervalDays ?? 1) > 1) return `每 ${rule!.intervalDays} 天`;
  if (rule?.frequency === "weekly") return `每周 ${rule.weeklyTarget} 次`;
  if (rule?.frequency === "weekdays") {
    const days: unknown = JSON.parse(rule.weekdays);
    const names = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    return Array.isArray(days)
      ? days
          .map((day) => names[Number(day)])
          .filter(Boolean)
          .join("、")
      : "指定星期";
  }
  return "每天";
}

export function HabitDetailPanel({
  row,
  date,
  onClose,
}: {
  row: Row;
  date: string;
  onClose: () => void;
}) {
  const { items: projects, loading } = useProjectList(0);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !document.querySelector(
          ".date-picker-popover,.task-action-popover,dialog[open]",
        )
      ) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const fields = [
    ["日期与时段", `${date} · ${dayPeriodLabels[row.placement.dayPeriod]}`],
    ["重复频率", frequency(row)],
    ["触发情境", row.habit.triggerContext],
    ["正常版本", row.habit.normalVersion],
    ["最低版本", row.habit.minimumVersion],
    ["本次备注", row.entry?.note],
    [
      "关联项目",
      row.habit.projectId
        ? (projects.find((p) => p.id === row.habit.projectId)?.name ??
          (loading ? "读取中…" : "项目已不可用"))
        : "",
    ],
  ].filter(([, value]) => value);
  return (
    <aside
      className="task-detail reference-task-panel habit-detail-panel"
      aria-label="习惯详情"
    >
      <header className="task-panel-toolbar">
        <span className="task-status-pill">习惯</span>
        <span className="task-status-pill">只读</span>
        <div className="task-panel-toolbar-actions">
          <button aria-label="关闭习惯详情" title="收起详情" onClick={onClose}>
            <TaskPanelIcon name="close" />
          </button>
        </div>
      </header>
      <div className="task-panel-scroll">
        <div className="task-panel-intro">
          <h2 className="habit-detail-title">{row.habit.name}</h2>
          <p className="habit-detail-status">
            {row.entry?.status === "done" ? "已完成" : "待完成"}
          </p>
          {row.habit.notes && (
            <p className="habit-detail-notes">{row.habit.notes}</p>
          )}
        </div>
        <dl className="habit-detail-fields">
          {fields.map(([label, value]) => (
            <div className="task-panel-field" key={label}>
              <div className="task-panel-field-body">
                <dt className="task-panel-field-label">{label}</dt>
                <dd>{value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
