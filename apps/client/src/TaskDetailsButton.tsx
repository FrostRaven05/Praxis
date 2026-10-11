import { useContext } from "react";
import { TaskTimeLink } from "./TaskTimeLink";
import { ProjectTaskPanelContext } from "./project-task-panel-context";

export function TaskDetailsButton({
  taskId,
  disabled = false,
  label = "编辑详情",
  className = "details-button",
}: {
  taskId: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const panel = useContext(ProjectTaskPanelContext);
  const selected = panel?.selectedTaskId === taskId;
  const locked = disabled || !panel || panel.disabled;
  return (
    <>
      <button
        className={className}
        disabled={locked}
        aria-expanded={selected}
        aria-controls={selected ? "project-task-panel" : undefined}
        onClick={(event) => {
          if (panel) void panel.open(taskId, event.currentTarget);
        }}
      >
        {label}
      </button>
      <TaskTimeLink taskId={taskId} disabled={locked || selected} />
    </>
  );
}
