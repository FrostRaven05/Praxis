import { useEffect, useState } from "react";
import { timeLabel, type WorkTask } from "@praxis/application";
import { openWorkTask, readWork } from "./ProductivityView";
import { TaskPanelIcon } from "./TaskPanelIcon";
export function TaskTimeLink({
  taskId,
  disabled = false,
  showSummary = false,
}: {
  taskId: string;
  disabled?: boolean;
  showSummary?: boolean;
}) {
  const [task, setTask] = useState<WorkTask>(),
    [zone, setZone] = useState("UTC");
  useEffect(() => {
    if (!showSummary) return;
    let live = true;
    void readWork()
      .then((s) => {
        if (live) {
          setTask(s.tasks.find((t) => t.id === taskId));
          setZone(s.settings[0]?.timeZone ?? "UTC");
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId, showSummary]);
  return (
    <section className="task-time-link">
      {task && (
        <p className="task-time-summary">
          <span>P{task.priority}</span>
          {task.status === "waiting" && <span>等待</span>}
          {task.plan && <span>计划 {timeLabel(task.plan, zone)}</span>}
          {task.deadline && <span>截止 {timeLabel(task.deadline, zone)}</span>}
          {task.followUp && <span>跟进 {timeLabel(task.followUp, zone)}</span>}
        </p>
      )}
      <button
        aria-label="编辑时间、优先级与标签"
        title="编辑时间、优先级与标签"
        disabled={disabled}
        onClick={() => openWorkTask(taskId)}
      >
        <TaskPanelIcon name="clock" />
        <span>时间与标签</span>
      </button>
    </section>
  );
}
