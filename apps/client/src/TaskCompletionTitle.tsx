import type { ReactNode } from "react";
import "./task-completion.css";

export function TaskCompletionTitle({ taskId, children }: { taskId: string; children: ReactNode }) {
  return <span className="task-completion-title" data-completion-title={taskId}>{children}</span>;
}
