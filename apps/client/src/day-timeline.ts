import {
  dayRows,
  dateAfter,
  timeDay,
  terminal,
  type DailyTask,
  type DayPeriod,
  type WorkSnapshot,
  type WorkTask,
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

export interface Recommendation {
  task: WorkTask;
  score: number;
  reasons: string[];
}

/**
 * Suggested tasks for the day. The outside unit is the parent task:
 * subtasks stay inside it and are not listed here.
 */
export function recommendBacklog(
  snapshot: WorkSnapshot,
  scheduled: DailyTask[],
  date: string,
  zone: string,
  limit = 5,
): Recommendation[] {
  const onDay = new Set(scheduled.map((task) => task.taskId));
  const inactive = new Set(
    snapshot.projects
      .filter((p) => p.status !== "active" || p.archivedAt)
      .map((p) => p.id),
  );
  const childrenOf = new Map<string, WorkTask[]>();
  for (const task of snapshot.tasks) {
    if (!task.parentId) continue;
    const list = childrenOf.get(task.parentId) ?? [];
    list.push(task);
    childrenOf.set(task.parentId, list);
  }
  const underway = (task: WorkTask) => {
    const seen = new Set<string>();
    const stack = [task];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current.id)) continue;
      seen.add(current.id);
      if (current.status === "in_progress") return true;
      for (const child of childrenOf.get(current.id) ?? []) stack.push(child);
    }
    return false;
  };
  const today = date;
  const soon = dateAfter(today, 3);
  const focus = new Set(
    snapshot.days.find((d) => d.date === date)?.focusIds ??
      snapshot.legacyPlans
        .filter((p) => p.date === date && p.focus)
        .map((p) => p.taskId),
  );
  const result: Recommendation[] = [];
  for (const task of snapshot.tasks) {
    if (
      task.parentId ||
      terminal(task) ||
      onDay.has(task.id) ||
      ["waiting", "blocked"].includes(task.status) ||
      (task.projectId && inactive.has(task.projectId))
    )
      continue;
    const reasons: string[] = [];
    let score = 0;
    const deadline = timeDay(task.deadline, zone);
    if (deadline && deadline < today) {
      reasons.push("已逾期");
      score += 100;
    } else if (deadline === today) {
      reasons.push("今日截止");
      score += 90;
    } else if (deadline && deadline <= soon) {
      reasons.push("即将截止");
      score += 60;
    }
    const plan = timeDay(task.plan, zone);
    if (plan && plan <= today) {
      reasons.push("计划今日");
      score += 50;
    }
    const followUp = timeDay(task.followUp, zone);
    if (followUp && followUp <= today) {
      reasons.push("到期跟进");
      score += 40;
    }
    if (focus.has(task.id)) {
      reasons.push("当日重点");
      score += 30;
    }
    if (underway(task)) {
      reasons.push("进行中");
      score += 70;
    }
    if (task.priority > 0 && task.priority < 4) {
      reasons.push(`P${task.priority}`);
      score += (4 - task.priority) * 8;
    }
    if (task.important) {
      reasons.push("重要");
      score += 8;
    }
    if (!reasons.length) reasons.push("积压任务");
    result.push({ task, score, reasons });
  }
  return result
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.task.createdAt.localeCompare(b.task.createdAt) ||
        a.task.id.localeCompare(b.task.id),
    )
    .slice(0, limit);
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
