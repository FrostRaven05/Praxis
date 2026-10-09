import { useEffect, useState } from "react";
import { timeLabel, type WorkTask } from "@praxis/application";
import { openWorkTask, readWork } from "./ProductivityView";
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
    <section>
      {task && (
        <p>
          P{task.priority} · {task.status === "waiting" ? "等待 · " : ""}计划{" "}
          {timeLabel(task.plan, zone)} · 真实截止{" "}
          {timeLabel(task.deadline, zone)} · 跟进{" "}
          {timeLabel(task.followUp, zone)}
        </p>
      )}
      <button disabled={disabled} onClick={() => openWorkTask(taskId)}>
        编辑时间、优先级与标签
      </button>
    </section>
  );
}
