import { useContext } from "react";
import { ProjectTaskPanelContext } from "./project-task-panel-context";
import { TaskCompletionTitle } from "./TaskCompletionTitle";

export function TaskDetailsButton({
  taskId,
  disabled = false,
  label = "编辑详情",
  className = "details-button",
  completionTitle = false,
}: {
  taskId: string;
  disabled?: boolean;
  label?: string;
  className?: string;
  completionTitle?: boolean;
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
        {completionTitle ? <TaskCompletionTitle taskId={taskId}>{label}</TaskCompletionTitle> : label}
      </button>
    </>
  );
}
