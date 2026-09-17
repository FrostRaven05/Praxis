import type { DailyTask } from "./capture-today";
import { validCalendarDate } from "./edit-task";
import { RetriableCommands } from "./retriable-commands";
export interface PlanChange {
  taskId: string;
  planId: string;
  expectedVersion: number;
  isFocus: boolean;
  focusRank: number;
  estimatedMinutes: number | null;
}
export interface PlanCommand {
  operationId: string;
  date: string;
  occurredAt: string;
  changes: PlanChange[];
}
export interface DayLoad {
  capacityMinutes: number | null;
  capacityVersion: number;
  estimatedMinutes: number;
  unknownCount: number;
}
export interface CapacityCommand {
  operationId: string;
  date: string;
  occurredAt: string;
  expectedVersion: number;
  minutes: number | null;
}
export interface InboxTask {
  taskId: string;
  title: string;
  version: number;
  createdAt: string;
}
export interface InboxCommand {
  operationId: string;
  taskId: string;
  title: string;
  occurredAt: string;
}
export interface ScheduleCommand {
  operationId: string;
  taskId: string;
  planId: string;
  expectedVersion: number;
  executionDate: string;
  timeZone: string;
  occurredAt: string;
}
export interface PlanningStorage {
  updatePlan(c: PlanCommand): Promise<void>;
  dayLoad(date: string): Promise<DayLoad>;
  setCapacity(c: CapacityCommand): Promise<void>;
  captureInbox(c: InboxCommand): Promise<void>;
  listInbox(): Promise<InboxTask[]>;
  scheduleTask(c: ScheduleCommand): Promise<void>;
}
export function planChange(task: DailyTask): PlanChange {
  if (task.status !== "todo") throw new Error("只能调整待办任务的每日安排");
  return {
    taskId: task.taskId,
    planId: task.planId,
    expectedVersion: task.version ?? 0,
    isFocus: task.isFocus ?? false,
    focusRank: task.focusRank ?? 0,
    estimatedMinutes: task.estimatedMinutes ?? null,
  };
}
export function parseMinutes(value: string, allowZero = false): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 1440)
    throw new Error(
      allowZero
        ? "可用时长需为 0–1440 分钟"
        : "预计投入需为 1–1440 分钟；留空表示待估时",
    );
  return n;
}
export class Planning {
  private plans = new RetriableCommands<PlanCommand>();
  private capacities = new RetriableCommands<CapacityCommand>();
  private captures = new RetriableCommands<InboxCommand>();
  private schedules = new RetriableCommands<ScheduleCommand>();
  constructor(private readonly storage: PlanningStorage) {}
  async update(date: string, changes: PlanChange[]) {
    if (
      !validCalendarDate(date) ||
      !changes.length ||
      new Set(changes.map((c) => c.planId)).size !== changes.length
    )
      throw new Error("安排数据无效");
    for (const c of changes) {
      if (!Number.isSafeInteger(c.focusRank) || c.focusRank < 0)
        throw new Error("排序无效");
      if (c.estimatedMinutes !== null) parseMinutes(String(c.estimatedMinutes));
    }
    await this.plans.execute(
      date,
      (c) => JSON.stringify(c.changes) === JSON.stringify(changes),
      () => ({
        operationId: crypto.randomUUID(),
        date,
        occurredAt: new Date().toISOString(),
        changes,
      }),
      (c) => this.storage.updatePlan(c),
    );
  }
  async capacity(date: string, version: number, minutes: number | null) {
    if (!validCalendarDate(date)) throw new Error("日期无效");
    if (minutes !== null) parseMinutes(String(minutes), true);
    await this.capacities.execute(
      date,
      (c) => c.expectedVersion === version && c.minutes === minutes,
      () => ({
        operationId: crypto.randomUUID(),
        date,
        expectedVersion: version,
        minutes,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.setCapacity(c),
    );
  }
  async capture(title: string) {
    const normalized = title.trim();
    if (!normalized) throw new Error("请填写任务标题");
    await this.captures.execute(
      "inbox",
      (c) => c.title === normalized,
      () => ({
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        title: normalized,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.captureInbox(c),
    );
  }
  async schedule(task: InboxTask, date: string, timeZone: string) {
    if (!validCalendarDate(date)) throw new Error("请选择安排日期");
    await this.schedules.execute(
      task.taskId,
      (c) => c.executionDate === date && c.expectedVersion === task.version,
      () => ({
        operationId: crypto.randomUUID(),
        taskId: task.taskId,
        planId: crypto.randomUUID(),
        expectedVersion: task.version,
        executionDate: date,
        timeZone,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.scheduleTask(c),
    );
  }
}

export function orderedFocus(items: DailyTask[]): DailyTask[] {
  return items
    .filter((t) => t.status === "todo" && t.isFocus)
    .sort(
      (a, b) =>
        (a.focusRank ?? 0) - (b.focusRank ?? 0) ||
        a.planId.localeCompare(b.planId),
    );
}
export function preparePlanChange(
  items: DailyTask[],
  change: PlanChange,
): PlanChange {
  if (!change.isFocus || items.find((t) => t.planId === change.planId)?.isFocus)
    return change;
  const maxRank = orderedFocus(items).reduce(
    (max, t) => Math.max(max, t.focusRank ?? 0),
    0,
  );
  return { ...change, focusRank: maxRank + 1 };
}
export function moveFocusChanges(
  items: DailyTask[],
  planId: string,
  direction: number,
): PlanChange[] {
  if (direction !== -1 && direction !== 1) throw new Error("移动方向无效");
  const ordered = orderedFocus(items);
  const index = ordered.findIndex((t) => t.planId === planId);
  const target = index + direction;
  const task = ordered[index],
    other = ordered[target];
  if (!task || !other) return [];
  ordered[index] = other;
  ordered[target] = task;
  return ordered.map((item, position) => ({
    ...planChange(item),
    focusRank: position + 1,
  }));
}
