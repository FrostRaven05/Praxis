import {
  dayRows,
  timeDay,
  terminal,
  type DailyTask,
  type DayPeriod,
  type WorkSnapshot,
  type WorkRow,
} from "@praxis/application";

/** Combine independent plans with scheduled tasks without creating or changing plans. */
export function dayTimeline(
  snapshot: WorkSnapshot,
  scheduled: DailyTask[],
  date: string,
  now: Date,
  zone: string,
) {
  const rows = dayRows(snapshot, date, now, zone);
  const scheduledIds = new Set(scheduled.map((task) => task.taskId));
  const periods: Record<DayPeriod, WorkRow[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  const attention: WorkRow[] = [];
  for (const row of rows) {
    if (scheduledIds.has(row.task.id)) continue;
    if (timeDay(row.task.plan, zone) !== date) {
      attention.push(row);
      continue;
    }
    const hour =
      row.task.plan?.kind === "instant"
        ? Number(
            new Intl.DateTimeFormat("en-GB", {
              timeZone: zone,
              hour: "2-digit",
              hourCycle: "h23",
            }).format(new Date(row.task.plan.atUtc)),
          )
        : 0;
    const period: DayPeriod =
      hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    periods[period].push(row);
  }
  return {
    periods,
    attention,
    reasons: new Map(rows.map((row) => [row.task.id, row.reasons])),
  };
}

export function upcomingDayRows(
  snapshot: WorkSnapshot,
  date: string,
  zone: string,
) {
  return snapshot.tasks
    .filter((task) => !terminal(task))
    .flatMap((task) => {
      const reasons = (
        [
          ["plan", "计划"],
          ["deadline", "截止"],
          ["followUp", "跟进"],
        ] as const
      )
        .filter(([key]) => timeDay(task[key], zone) === date)
        .map(([, label]) => label as string);
      if (
        !reasons.includes("计划") &&
        snapshot.legacyPlans.some(
          (plan) => plan.taskId === task.id && plan.date === date,
        )
      )
        reasons.push("安排");
      return reasons.length ? [{ task, reasons }] : [];
    });
}
