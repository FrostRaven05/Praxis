import { useCallback, useEffect, useState } from "react";
import {
  calendarDate,
  type DailyTask,
  type PersonalTaskRead,
  type WorkTask,
} from "@praxis/application";
import { taskStorage } from "./storage";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { InboxTaskPanel } from "./InboxTaskPanel";

export function PersonalTaskDetails({
  task,
  base,
  onRefresh,
  onClose,
  onComplete,
  onDelete,
  onOpenProject,
  onLockedChange,
}: {
  task: WorkTask;
  base: PersonalTaskRead;
  onRefresh: () => Promise<PersonalTaskRead>;
  onClose: () => void;
  onComplete: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onOpenProject: (id: string) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const zone = base.work.settings[0]?.timeZone ?? base.fallbackZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = calendarDate(new Date(), zone);
  const project = base.work.projects.find((project) => project.id === task.projectId);
  const dates = base.work.legacyPlans
    .filter((plan) => plan.taskId === task.id)
    .map((plan) => plan.date)
    .sort();
  const date = dates.length && task.status === "completed" && task.completedAt
    ? calendarDate(new Date(task.completedAt), zone)
    : dates.includes(today) ? today : (dates.at(-1) ?? null);
  const [dailyTask, setDailyTask] = useState<DailyTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [contentLocked, setContentLocked] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    if (!date) return null;
    const rows = await taskStorage.listDay(date);
    const row = rows.find((row) => row.taskId === task.id);
    if (!row) throw Error("任务安排已变化，请重新读取后再编辑。");
    return row;
  }, [date, task.id]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void load()
      .then((row) => { if (active) setDailyTask(row); })
      .catch((error) => { if (active) setError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, revision]);
  useEffect(() => {
    onLockedChange(loading || contentLocked || contentBusy || contentDirty);
    return () => onLockedChange(false);
  }, [loading, contentLocked, contentBusy, contentDirty, onLockedChange]);
  if (loading || error) return (
    <aside className="task-detail reference-task-panel" aria-label="任务详情">
      <p role={error ? "alert" : "status"}>{error || "正在读取任务详情…"}</p>
      {error && <button onClick={() => setRevision((value) => value + 1)}>重新读取</button>}
      <button onClick={onClose}>关闭任务详情</button>
    </aside>
  );
  return dailyTask ? (
    <TaskDetailPanel
      key={`${task.id}:${revision}`}
      task={dailyTask}
      scheduleTimeZone={zone}
      onSaved={async (receipt) => {
        setDailyTask(receipt.after);
        await onRefresh();
      }}
      onPersisted={async () => {
        await onRefresh();
        const updated = await load();
        if (updated) setDailyTask(updated);
      }}
      onUpdated={async () => {
        await onRefresh();
        setRevision((value) => value + 1);
      }}
      onClose={onClose}
      onComplete={onComplete}
      {...(onDelete ? { onDelete } : {})}
      onProject={onOpenProject}
      onBusyChange={setContentBusy}
      onDirtyChange={setContentDirty}
    />
  ) : (
    <InboxTaskPanel
      key={`${task.id}:${revision}`}
      contextLabel={task.projectId ? "项目" : "杂事"}
      projectId={task.projectId}
      projectName={project?.name ?? null}
      task={{taskId: task.id, title: task.title, version: task.version, createdAt: task.createdAt, status: task.status}}
      onSaved={async () => { await onRefresh(); }}
      onReload={async () => {
        await onRefresh();
        setRevision((value) => value + 1);
      }}
      onClose={onClose}
      onLockedChange={setContentLocked}
      onComplete={onComplete}
      {...(onDelete ? { onDelete } : {})}
    />
  );
}
