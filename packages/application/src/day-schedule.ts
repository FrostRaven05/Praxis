import type { DailyTask } from "./capture-today";
import { planChange, type PlanChange } from "./planning";

export const dayPeriods = ["morning", "afternoon", "evening"] as const;
export type DayPeriod = (typeof dayPeriods)[number];

export function periodForHour(hour: number): DayPeriod {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export function localHour(now: Date, timeZone: string): number {
  const raw = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed % 24 : now.getHours();
}

export function periodForTime(now: Date, timeZone: string): DayPeriod {
  return periodForHour(localHour(now, timeZone));
}

export function inferPeriodFromText(text: string): DayPeriod | null {
  const content = text.trim();
  if (!content) return null;

  const clockMatch = content.match(
    /(早上|早晨|上午|清晨|中午|午后|下午|傍晚|晚上|晚间|夜间|夜里|睡前)?\s*(\d{1,2})\s*(?:[:：](\d{2})|点(?:半|(\d{1,2})分?)?)/,
  );
  if (clockMatch) {
    const prefix = clockMatch[1] ?? "";
    const rawHour = Number(clockMatch[2]);
    if (Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 24) {
      let hour = rawHour === 24 ? 0 : rawHour;
      if (["下午", "午后"].includes(prefix) && hour >= 1 && hour <= 11) {
        hour += 12;
      } else if (
        ["傍晚", "晚上", "晚间", "夜间", "夜里", "睡前"].includes(prefix) &&
        hour >= 1 &&
        hour <= 11
      ) {
        hour += 12;
        if (hour < 18) return "evening";
      } else if (prefix === "中午" && hour >= 1 && hour <= 5) {
        hour += 12;
      }
      return periodForHour(hour);
    }
  }

  if (/(早上|早晨|上午|清晨|早起|早餐|早饭|晨跑|晨读)/.test(content)) {
    return "morning";
  }
  if (/(中午|午休|午饭|午餐|下午|午后)/.test(content)) {
    return "afternoon";
  }
  if (/(晚上|晚间|傍晚|晚饭|晚餐|睡前|夜晚|夜间|夜里)/.test(content)) {
    return "evening";
  }
  return null;
}

export interface AutoArrangeItem extends DayArrangementItem {
  title: string;
  plannedHour?: number | null;
  priority?: number;
  isFocus?: boolean;
  inProgress?: boolean;
}

export function defaultPeriodForDate(
  date: string,
  today: string,
  now: Date,
  timeZone: string,
  title = "",
): DayPeriod {
  const inferred = inferPeriodFromText(title);
  if (inferred) return inferred;
  if (date === today) return periodForTime(now, timeZone);
  return "morning";
}

export function autoArrangeDayItems(
  items: AutoArrangeItem[],
  options: {
    date: string;
    today: string;
    now: Date;
    timeZone: string;
  },
): { key: string; dayPeriod: DayPeriod; dayRank: number }[] {
  if (!items.length) return [];

  const buckets: Record<DayPeriod, AutoArrangeItem[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  const flexible: AutoArrangeItem[] = [];

  for (const item of items) {
    if (
      typeof item.plannedHour === "number" &&
      Number.isFinite(item.plannedHour)
    ) {
      buckets[periodForHour(item.plannedHour)].push(item);
      continue;
    }
    const inferred = inferPeriodFromText(item.title);
    if (inferred) {
      buckets[inferred].push(item);
      continue;
    }
    flexible.push(item);
  }

  const available: DayPeriod[] =
    options.date === options.today
      ? [...dayPeriods.slice(dayPeriods.indexOf(periodForTime(options.now, options.timeZone)))]
      : [...dayPeriods];

  const urgencyWeight = (item: AutoArrangeItem) =>
    (item.isFocus ? 100 : 0) +
    (item.inProgress ? 50 : 0) +
    (item.priority && item.priority > 0 && item.priority < 4
      ? (4 - item.priority) * 10
      : 0);

  flexible.sort(
    (a, b) =>
      urgencyWeight(b) - urgencyWeight(a) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.key.localeCompare(b.key),
  );

  const totalInAvailable =
    flexible.length +
    available.reduce((sum, period) => sum + buckets[period].length, 0);
  const targetPerPeriod = Math.max(
    1,
    Math.ceil(totalInAvailable / available.length),
  );

  for (const item of flexible) {
    const target =
      available.find((period) => buckets[period].length < targetPerPeriod) ??
      available.reduce((lightest, period) =>
        buckets[period].length < buckets[lightest].length ? period : lightest,
      );
    buckets[target].push(item);
  }

  const changes: { key: string; dayPeriod: DayPeriod; dayRank: number }[] = [];
  for (const period of dayPeriods) {
    const ordered = buckets[period].sort(
      (a, b) =>
        (a.plannedHour ?? 99) - (b.plannedHour ?? 99) ||
        urgencyWeight(b) - urgencyWeight(a) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.key.localeCompare(b.key),
    );
    ordered.forEach((item, index) => {
      const rank = index + 1;
      if (item.dayPeriod !== period || item.dayRank !== rank) {
        changes.push({ key: item.key, dayPeriod: period, dayRank: rank });
      }
    });
  }
  return changes;
}
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
