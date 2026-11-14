/** Executable M0 reference rules. No production caller or storage side effects. */
import { calendarDate } from "../calendar-date";
import { validCalendarDate } from "../edit-task";
import { projectTree } from "../subtasks";
import type { Deadline, ResourceScope, XpContribution } from "./contract";

export function resourceKey(
  serviceId: string,
  scope: ResourceScope,
  kind: string,
  id: string,
): string {
  const scopeId = scope.kind === "personal" ? scope.ownerId : scope.projectId;
  if ([serviceId, scopeId, kind, id].some((value) => !value.trim()))
    throw Error("Empty resource identity");
  return JSON.stringify([serviceId, scope.kind, scopeId, kind, id]);
}
const statusLabels = {
  todo: "待办",
  in_progress: "进行中",
  completed: "已完成",
  waiting: "等待",
  blocked: "阻塞",
  cancelled: "已取消",
} as const;
export function legacyStatus(status: string) {
  if (!Object.hasOwn(statusLabels, status))
    throw Error("Unknown legacy status");
  const key = status as keyof typeof statusLabels;
  return {
    rawStatus: status,
    label: statusLabels[key],
    legacyOnly: ["waiting", "blocked", "cancelled"].includes(status),
  };
}
export function deadlineGroup(
  deadline: Deadline | null,
  now: Date,
): "overdue" | "today" | "later" | "undated" {
  if (!Number.isFinite(now.getTime())) throw Error("Invalid clock");
  if (!deadline) return "undated";
  if (deadline.kind === "date") {
    if (!validCalendarDate(deadline.date)) throw Error("Invalid due date");
    const today = calendarDate(now, deadline.timeZone);
    return deadline.date < today
      ? "overdue"
      : deadline.date === today
        ? "today"
        : "later";
  }
  if (
    !validCalendarDate(deadline.atUtc.slice(0, 10)) ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(deadline.atUtc)
  )
    throw Error("Invalid due instant");
  const due = new Date(deadline.atUtc);
  if (!Number.isFinite(due.getTime())) throw Error("Invalid due instant");
  const dueDay = calendarDate(due, deadline.displayTimezone);
  const today = calendarDate(now, deadline.displayTimezone);
  return due <= now ? "overdue" : dueDay === today ? "today" : "later";
}
export interface CompatibilityTask {
  readonly id: string;
  readonly status: string;
  readonly parentId: string | null;
  readonly deleted: boolean;
}
export function taskProgress(
  mode: "flat" | "legacy-tree",
  tasks: readonly CompatibilityTask[],
) {
  const live = tasks.filter((task) => !task.deleted);
  if (new Set(live.map((task) => task.id)).size !== live.length)
    throw Error("Duplicate task identity");
  for (const task of live) legacyStatus(task.status);
  let total: number, done: number;
  if (mode === "flat") {
    if (
      live.some(
        (task) =>
          task.parentId !== null || legacyStatus(task.status).legacyOnly,
      )
    )
      throw Error("Legacy view required");
    total = live.length;
    done = live.filter((task) => task.status === "completed").length;
  } else {
    const tree = projectTree(
      live.map((task) => ({
        taskId: task.id,
        parentTaskId: task.parentId,
        status: task.status,
        title: task.id,
        version: 0,
        createdAt: "2000-01-01T00:00:00Z",
        executionDate: null,
        completionDate: null,
      })),
    );
    const roots = tree.filter((task) => task.depth === 0);
    total = roots.reduce((sum, task) => sum + task.leafTotal, 0);
    done = roots.reduce((sum, task) => sum + task.leafDone, 0);
  }
  return {
    mode,
    total,
    done,
    percentage: total ? Math.round((done * 100) / total) : null,
    allTasksCompleted: total > 0 && total === done,
  };
}
export function taskXp(
  serviceId: string,
  contributions: readonly XpContribution[],
  userId: string,
  now: Date,
  timeZone: string,
) {
  const today = calendarDate(now, timeZone);
  const seen = new Set<string>();
  let count = 0,
    completedToday = 0;
  for (const contribution of contributions) {
    if (!contribution.active) continue;
    const key = resourceKey(
      serviceId,
      contribution.scope,
      "task",
      contribution.taskId,
    );
    if (seen.has(key)) throw Error("More than one active task contribution");
    seen.add(key);
    if (contribution.recipientId !== userId) continue;
    count++;
    if (
      contribution.completedAt !== null &&
      calendarDate(new Date(contribution.completedAt), timeZone) === today
    )
      completedToday++;
  }
  const xp = count * 10;
  return {
    xp,
    level: 1 + Math.floor(xp / 100),
    levelProgress: xp % 100,
    completedToday,
  };
}
