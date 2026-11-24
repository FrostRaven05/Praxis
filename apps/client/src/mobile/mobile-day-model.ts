import {
  calendarDate,
  dayPeriods,
  type DailyTask,
  type DayPeriod,
} from "@praxis/application";
import type { WorkspaceEntity } from "@praxis/storage-mobile";

const ACTIVE_STATUSES = new Set(["todo", "in_progress", "blocked"]);

function isDayPeriod(value: unknown): value is DayPeriod {
  return (
    typeof value === "string" &&
    (dayPeriods as readonly string[]).includes(value)
  );
}

function findDailyPlanRow(
  taskId: string,
  date: string,
  entities: readonly WorkspaceEntity[],
): Record<string, unknown> | null {
  for (const entity of entities) {
    if (
      entity.deleted ||
      entity.kind !== "desktop_row" ||
      entity.data.table !== "daily_plan_items"
    )
      continue;
    const row = entity.data.row as Record<string, unknown> | undefined;
    if (!row) continue;
    if (
      row.task_id === taskId &&
      row.execution_date === date &&
      !row.removed &&
      !row.is_summary
    ) {
      return row;
    }
  }
  return null;
}

export function mobileTaskDayPeriod(
  task: WorkspaceEntity,
  date: string,
  entities: readonly WorkspaceEntity[],
): DayPeriod {
  if (isDayPeriod(task.data.dayPeriod)) return task.data.dayPeriod;
  const row = findDailyPlanRow(task.id, date, entities);
  if (row && isDayPeriod(row.day_period)) return row.day_period;
  return "morning";
}

export function mobileTaskDayRank(
  task: WorkspaceEntity,
  date: string,
  entities: readonly WorkspaceEntity[],
): number {
  if (typeof task.data.dayRank === "number" && Number.isFinite(task.data.dayRank))
    return task.data.dayRank;
  const row = findDailyPlanRow(task.id, date, entities);
  if (row && typeof row.day_rank === "number" && Number.isFinite(row.day_rank))
    return row.day_rank;
  return 0;
}

function completedOnDate(
  task: WorkspaceEntity,
  date: string,
  timeZone: string,
): boolean {
  if (task.data.status !== "completed") return false;
  if (typeof task.data.completedAt === "string" && task.data.completedAt) {
    const parsed = new Date(task.data.completedAt);
    if (Number.isFinite(parsed.getTime())) {
      return calendarDate(parsed, timeZone) === date;
    }
  }
  return task.data.executionDate === date;
}

export function mobileScheduledForDate(
  entities: readonly WorkspaceEntity[],
  date: string,
  timeZone: string,
): {
  periods: Record<DayPeriod, WorkspaceEntity[]>;
  completed: WorkspaceEntity[];
  dailyTasks: DailyTask[];
} {
  const periods: Record<DayPeriod, WorkspaceEntity[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  const completed: WorkspaceEntity[] = [];
  const dailyTasks: DailyTask[] = [];

  const liveTasks = entities.filter(
    (e) => !e.deleted && e.kind === "task" && e.data.status !== "cancelled",
  );
  const projectMap = new Map(
    entities
      .filter((e) => !e.deleted && e.kind === "project")
      .map((p) => [p.id, String(p.data.status ?? "active")]),
  );

  for (const task of liveTasks) {
    const status = String(task.data.status ?? "todo") as DailyTask["status"];
    const executionDate =
      typeof task.data.executionDate === "string" ? task.data.executionDate : "";
    const isScheduledToday = executionDate === date && ACTIVE_STATUSES.has(status);
    const isCompletedToday = completedOnDate(task, date, timeZone);

    if (!isScheduledToday && !isCompletedToday) continue;

    const period = mobileTaskDayPeriod(task, date, entities);
    const rank = mobileTaskDayRank(task, date, entities);
    if (isScheduledToday) periods[period].push(task);
    if (isCompletedToday) completed.push(task);

    const desktop =
      task.data.desktop && typeof task.data.desktop === "object"
        ? (task.data.desktop as Record<string, unknown>)
        : {};
    const projectId =
      typeof task.data.projectId === "string" ? task.data.projectId : null;

    dailyTasks.push({
      taskId: task.id,
      planId: task.id,
      title: String(task.data.title ?? ""),
      notes: String(task.data.notes ?? ""),
      executionDate: executionDate || date,
      createdAt: task.createdAt,
      projectId,
      projectStatus: projectId ? (projectMap.get(projectId) ?? null) : null,
      status,
      statusReason: String(task.data.statusReason ?? desktop.status_reason ?? ""),
      important: Boolean(desktop.important),
      deadline: typeof task.data.dueDate === "string" ? task.data.dueDate : null,
      version: task.version,
      dayPeriod: period,
      dayRank: rank,
      completionDate: isCompletedToday ? date : null,
      source: "temporary",
    });
  }

  for (const period of dayPeriods) {
    periods[period].sort((a, b) => {
      const rankA = mobileTaskDayRank(a, date, entities) || Number.MAX_SAFE_INTEGER;
      const rankB = mobileTaskDayRank(b, date, entities) || Number.MAX_SAFE_INTEGER;
      return (
        rankA - rankB ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
      );
    });
  }

  completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { periods, completed, dailyTasks };
}

export function mobileScheduleTaskPatch(
  entity: WorkspaceEntity,
  date: string,
  period?: DayPeriod,
): Record<string, unknown> {
  const nextPeriod: DayPeriod =
    period ?? (isDayPeriod(entity.data.dayPeriod) ? entity.data.dayPeriod : "morning");
  return {
    ...entity.data,
    executionDate: date,
    dayPeriod: nextPeriod,
  };
}

export function mobileUnscheduleTaskPatch(
  entity: WorkspaceEntity,
): Record<string, unknown> {
  return {
    ...entity.data,
    executionDate: null,
  };
}
