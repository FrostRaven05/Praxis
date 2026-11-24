import {
  autoArrangeDayItems,
  moveDayItems,
  isPlanConflict,
  planChange,
  taskPeriod,
  type DailyTask,
  type DayArrangementItem,
  type DayPeriod,
  type HabitPlanChange,
  type PlanChange,
} from "@praxis/application";
import type { Row as HabitRow } from "./HabitsView";

export type DayPlanIntent =
  | { type: "focus"; taskId: string; planId: string; isFocus: boolean }
  | {
      type: "move";
      key: string;
      period: DayPeriod;
      anchorId?: string;
      position: "before" | "after";
    }
  | {
      type: "auto";
      today: string;
      nowIso: string;
      timeZone: string;
      plannedHours?: Record<string, number>;
    };

export interface DayPlanSnapshot {
  tasks: DailyTask[];
  habits: HabitRow[];
}

export interface DayPlanRequest {
  date: string;
  intent: DayPlanIntent;
  changes: PlanChange[];
  habitChanges: HabitPlanChange[];
}

const active = (task: DailyTask) =>
  ["todo", "in_progress", "blocked"].includes(task.status);

/** Rebuild only the user's action; all other fields come from the fresh snapshot. */
export function createDayPlanRequest(
  date: string,
  intent: DayPlanIntent,
  snapshot: DayPlanSnapshot,
): DayPlanRequest | null {
  const tasks = snapshot.tasks.filter(
    (task) => task.executionDate === date && active(task),
  );
  if (intent.type === "focus") {
    const task = tasks.find(
      (task) => task.taskId === intent.taskId && task.planId === intent.planId,
    );
    if (!task) return null;
    return {
      date,
      intent,
      changes:
        !!task.isFocus === intent.isFocus
          ? []
          : [{ ...planChange(task), isFocus: intent.isFocus }],
      habitChanges: [],
    };
  }
  if (intent.type === "auto") {
    if (!tasks.length) return null;
    const movements = autoArrangeDayItems(
      tasks.map((task) => ({
        key: task.planId,
        title: task.title,
        dayPeriod: taskPeriod(task),
        dayRank: task.dayRank ?? 0,
        createdAt: task.createdAt,
        plannedHour: intent.plannedHours?.[task.taskId] ?? null,
        isFocus: Boolean(task.isFocus),
        inProgress: task.status === "in_progress",
      })),
      {
        date,
        today: intent.today,
        now: new Date(intent.nowIso),
        timeZone: intent.timeZone,
      },
    );
    const byPlan = new Map(tasks.map((task) => [task.planId, task]));
    const changes: PlanChange[] = [];
    for (const movement of movements) {
      const task = byPlan.get(movement.key);
      if (!task) continue;
      changes.push({
        ...planChange(task),
        dayPeriod: movement.dayPeriod,
        dayRank: movement.dayRank,
      });
    }
    return { date, intent, changes, habitChanges: [] };
  }
  const habits = snapshot.habits.filter(
    (row) =>
      row.applicable &&
      !row.collapsed &&
      row.entry?.status !== "done" &&
      row.entry?.status !== "skipped",
  );
  const rows: (DayArrangementItem & { task?: DailyTask; habit?: HabitRow })[] =
    [
      ...tasks.map((task) => ({
        key: task.planId,
        dayPeriod: taskPeriod(task),
        dayRank: task.dayRank ?? 0,
        createdAt: task.createdAt,
        task,
      })),
      ...habits.map((habit) => ({
        key: `habit:${habit.habit.id}`,
        dayPeriod: habit.placement.dayPeriod,
        dayRank: habit.placement.dayRank,
        createdAt: habit.habit.createdAt,
        habit,
      })),
    ];
  if (
    !rows.some((row) => row.key === intent.key) ||
    (intent.anchorId && !rows.some((row) => row.key === intent.anchorId))
  )
    return null;
  const changes: PlanChange[] = [];
  const habitChanges: HabitPlanChange[] = [];
  for (const movement of moveDayItems(
    rows,
    intent.key,
    intent.period,
    intent.anchorId,
    intent.position,
  )) {
    const row = rows.find((row) => row.key === movement.key)!;
    if (row.task)
      changes.push({
        ...planChange(row.task),
        dayPeriod: movement.dayPeriod,
        dayRank: movement.dayRank,
      });
    if (row.habit)
      habitChanges.push({
        habitId: row.habit.habit.id,
        expectedVersion: row.habit.placement.version,
        dayPeriod: movement.dayPeriod,
        dayRank: movement.dayRank,
      });
  }
  return { date, intent, changes, habitChanges };
}

export class DayPlanSaveError extends Error {
  constructor(
    public readonly pending: DayPlanRequest,
    public readonly conflict: boolean,
  ) {
    super(
      conflict
        ? "安排正在更新，本次调整已保留。"
        : "暂未确认保存，本次调整已保留。",
    );
  }
}

export async function saveDayPlan(
  request: DayPlanRequest,
  port: {
    write: (
      date: string,
      changes: PlanChange[],
      habitChanges: HabitPlanChange[],
    ) => Promise<void>;
    read: (date: string) => Promise<DayPlanSnapshot>;
  },
): Promise<"saved" | "changed"> {
  let pending = request;
  let conflicts = 0;
  let acknowledgementRetried = false;
  while (conflicts < 3) {
    if (!pending.changes.length && !pending.habitChanges.length) return "saved";
    try {
      await port.write(pending.date, pending.changes, pending.habitChanges);
      return "saved";
    } catch (error) {
      // An uncertain acknowledgement must replay the exact original command.
      // Only an explicit version rejection permits rebasing onto newer data.
      if (!isPlanConflict(error)) {
        if (!acknowledgementRetried) {
          acknowledgementRetried = true;
          continue;
        }
        throw new DayPlanSaveError(pending, false);
      }
      conflicts += 1;
      let snapshot: DayPlanSnapshot;
      try {
        snapshot = await port.read(pending.date);
      } catch {
        throw new DayPlanSaveError(pending, true);
      }
      const rebased = createDayPlanRequest(
        pending.date,
        pending.intent,
        snapshot,
      );
      if (!rebased) return "changed";
      pending = rebased;
      if (!pending.changes.length && !pending.habitChanges.length)
        return "saved";
    }
  }
  throw new DayPlanSaveError(pending, true);
}
