import type { DailyTask } from "./capture-today";
import { planChange, type PlanChange } from "./planning";

export const dayPeriods = ["morning", "afternoon", "evening"] as const;
export type DayPeriod = (typeof dayPeriods)[number];
export interface DayArrangementItem {
  key: string;
  dayPeriod: DayPeriod;
  dayRank: number;
  createdAt: string;
}
export function orderedDayItems<T extends DayArrangementItem>(
  items: T[],
  period: DayPeriod,
): T[] {
  return items
    .filter((item) => item.dayPeriod === period)
    .sort(
      (a, b) =>
        (a.dayRank || Number.MAX_SAFE_INTEGER) -
          (b.dayRank || Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.key.localeCompare(b.key),
    );
}
export function moveDayItems(
  items: DayArrangementItem[],
  key: string,
  period: DayPeriod,
  anchorId?: string,
  position: "before" | "after" = "before",
) {
  if (!dayPeriods.includes(period)) throw new Error("时段无效");
  const item = items.find((item) => item.key === key);
  if (!item || key === anchorId) return [];
  const target = orderedDayItems(items, period).filter(
    (item) => item.key !== key,
  );
  let index = target.length;
  if (anchorId) {
    const anchor = target.findIndex((item) => item.key === anchorId);
    if (anchor < 0) return [];
    index = anchor + (position === "after" ? 1 : 0);
  }
  target.splice(index, 0, item);
  if (
    item.dayPeriod === period &&
    orderedDayItems(items, period).every((row, i) => row.key === target[i]?.key)
  )
    return [];
  const groups: [DayPeriod, DayArrangementItem[]][] = [[period, target]];
  if (item.dayPeriod !== period)
    groups.push([
      item.dayPeriod,
      orderedDayItems(items, item.dayPeriod).filter((row) => row.key !== key),
    ]);
  return groups.flatMap(([dayPeriod, rows]) =>
    rows.flatMap((row, i) =>
      row.dayPeriod === dayPeriod && row.dayRank === i + 1
        ? []
        : [{ key: row.key, dayPeriod, dayRank: i + 1 }],
    ),
  );
}
export const dayPeriodLabels: Record<DayPeriod, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};
export function taskPeriod(task: DailyTask): DayPeriod {
  return task.dayPeriod ?? "morning";
}
export function orderedDayTasks(
  items: DailyTask[],
  period: DayPeriod,
): DailyTask[] {
  return items
    .filter(
      (task) =>
        ["todo", "in_progress", "blocked"].includes(task.status) &&
        taskPeriod(task) === period,
    )
    .sort(
      (a, b) =>
        (a.dayRank || Number.MAX_SAFE_INTEGER) -
          (b.dayRank || Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.planId.localeCompare(b.planId),
    );
}

/** Move within or between periods in a single version-checked plan transaction. */
export function moveDayTaskChanges(
  items: DailyTask[],
  planId: string,
  period: DayPeriod,
  anchorId?: string,
  position: "before" | "after" = "before",
): PlanChange[] {
  const task = items.find((item) => item.planId === planId);
  if (
    !task ||
    !["todo", "in_progress", "blocked"].includes(task.status) ||
    anchorId === planId
  )
    return [];
  if (!dayPeriods.includes(period)) throw new Error("时段无效");
  const origin = taskPeriod(task);
  const target = orderedDayTasks(items, period).filter(
    (item) => item.planId !== planId,
  );
  let index = target.length;
  if (anchorId) {
    const anchorIndex = target.findIndex((item) => item.planId === anchorId);
    if (anchorIndex < 0) return [];
    index = anchorIndex + (position === "after" ? 1 : 0);
  }
  target.splice(index, 0, task);
  const original = orderedDayTasks(items, period);
  if (
    origin === period &&
    original.every((item, i) => item.planId === target[i]?.planId)
  )
    return [];
  const groups = [[period, target]] as [DayPeriod, DailyTask[]][];
  if (origin !== period)
    groups.push([
      origin,
      orderedDayTasks(items, origin).filter((item) => item.planId !== planId),
    ]);
  return groups.flatMap(([dayPeriod, tasks]) =>
    tasks.flatMap((item, i) =>
      taskPeriod(item) === dayPeriod && item.dayRank === i + 1
        ? []
        : [
            {
              ...planChange(item),
              dayPeriod,
              dayRank: i + 1,
            },
          ],
    ),
  );
}
