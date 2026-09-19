import { validCalendarDate } from "./edit-task";
import type { ProjectTask } from "./projects";
import { RetriableCommands } from "./retriable-commands";
export const projectStates: Record<string, string> = {
  draft: "草稿",
  active: "进行中",
  paused: "暂停",
  completed: "完成",
  archived: "归档",
};
export const taskStates: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  blocked: "阻塞",
  completed: "已完成",
  cancelled: "取消",
};
export const projectEligible = (state: string) => state === "active";
export interface ScheduleEntry {
  taskId: string;
  start: string | null;
  end: string | null;
  dependencies: string[];
}
export function scheduleEntries(tasks: ProjectTask[]): ScheduleEntry[] {
  const parents = new Set(tasks.map((t) => t.parentTaskId).filter(Boolean));
  return tasks
    .filter((t) => !parents.has(t.taskId))
    .map((t) => ({
      taskId: t.taskId,
      start: t.plannedStart ?? null,
      end: t.plannedEnd ?? null,
      dependencies: t.dependencies ?? [],
    }));
}
export function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000,
  );
export function previewSchedule(
  entries: ScheduleEntry[],
  change: ScheduleEntry,
): ScheduleEntry[] {
  const next = entries.map((e) => ({
    ...e,
    dependencies: [...e.dependencies],
    ...(e.taskId === change.taskId ? change : {}),
  }));
  const byId = new Map(next.map((e) => [e.taskId, e]));
  if (!byId.has(change.taskId)) throw Error("任务已变化，请重新读取");
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(e: ScheduleEntry) {
    if (done.has(e.taskId)) return;
    if (visiting.has(e.taskId)) throw Error("前置依赖不能形成循环");
    visiting.add(e.taskId);
    if (
      !!e.start !== !!e.end ||
      (e.start &&
        (!validCalendarDate(e.start) ||
          !validCalendarDate(e.end!) ||
          e.start > e.end!))
    )
      throw Error("开始和结束日期必须有效且顺序正确");
    const duration = e.start ? daysBetween(e.start, e.end!) : 0;
    for (const id of e.dependencies) {
      const p = byId.get(id);
      if (!p || id === e.taskId)
        throw Error("前置任务必须是同项目的其他叶子任务");
      visit(p);
      if (e.start && p.end && e.start <= p.end) {
        e.start = shiftDate(p.end, 1);
        e.end = shiftDate(e.start, duration);
      }
    }
    visiting.delete(e.taskId);
    done.add(e.taskId);
  }
  for (const e of next) visit(e);
  return next;
}
export type WorkspaceAction =
  | {
      kind: "lifecycle";
      projectId: string;
      expectedVersion: number;
      status: string;
      focused: boolean;
      arrangements: "keep" | "remove";
      date: string;
    }
  | {
      kind: "move";
      projectId: string;
      expectedPlanVersion: number;
      taskId: string;
      parentTaskId: string | null;
      beforeTaskId: string | null;
      confirmSummaryPlan: boolean;
    }
  | {
      kind: "status";
      taskId: string;
      expectedVersion: number;
      status: string;
      reason: string;
      date: string;
      timeZone: string;
    }
  | {
      kind: "schedule";
      projectId: string;
      expectedPlanVersion: number;
      entries: ScheduleEntry[];
    };
export type WorkspaceCommand = WorkspaceAction & {
  operationId: string;
  occurredAt: string;
};
export class ProjectWorkspace {
  private commands = new RetriableCommands<WorkspaceCommand>();
  constructor(private save: (c: WorkspaceCommand) => Promise<void>) {}
  async execute(action: WorkspaceAction) {
    validateWorkspaceAction(action);

    await this.commands.execute(
      "workspace",
      (c) => {
        const { operationId, occurredAt, ...fields } = c;
        return JSON.stringify(fields) === JSON.stringify(action);
      },
      () => ({
        ...action,
        operationId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      }),
      this.save,
    );
  }
}

export function validateWorkspaceAction(action: WorkspaceAction): void {
  if (action.kind === "lifecycle") {
    if (!Object.hasOwn(projectStates, action.status))
      throw Error("项目状态无效");
    if (
      action.arrangements === "remove" &&
      !["paused", "archived"].includes(action.status)
    )
      throw Error("只有暂停或归档时可批量移出安排");
    if (!validCalendarDate(action.date)) throw Error("日期无效");
  } else if (action.kind === "status") {
    if (
      !Object.hasOwn(taskStates, action.status) &&
      action.status !== "restore"
    )
      throw Error("任务状态无效");
    if (
      ["blocked", "cancelled"].includes(action.status) &&
      !action.reason.trim()
    )
      throw Error("请填写阻塞或取消原因");
  } else if (action.kind === "move") {
    if (
      action.taskId === action.parentTaskId ||
      action.taskId === action.beforeTaskId
    )
      throw Error("不能移入自己或相对自己排序");
  } else if (action.kind === "schedule") {
    if (
      new Set(action.entries.map((e) => e.taskId)).size !==
      action.entries.length
    )
      throw Error("排期任务不能重复");
    if (action.entries.length) {
      const validated = previewSchedule(action.entries, action.entries[0]!);
      if (JSON.stringify(validated) !== JSON.stringify(action.entries))
        throw Error("请重新预览排期顺延方案");
    }
  }
}
