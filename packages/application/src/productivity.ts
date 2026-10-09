import { calendarDate } from "./calendar-date";
export type TimeValue =
  | { kind: "date"; date: string }
  | { kind: "instant"; atUtc: string; displayTimezone: string };
export interface WorkTask {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  parentId: string | null;
  sectionId: string | null;
  status: string;
  version: number;
  plan: TimeValue | null;
  deadline: TimeValue | null;
  followUp: TimeValue | null;
  priority: number;
  important: number;
  waitingFor: string;
  waitingNote: string;
  completedAt: string | null;
  createdAt: string;
  rank: number;
  labels: string[];
}
export interface WorkProject {
  id: string;
  name: string;
  status: string;
  version: number;
  planVersion: number;
  focused: number;
  archivedAt: string | null;
}
export interface DayNote {
  date: string;
  outcome: string;
  closing: string;
  focusIds: string[];
  version: number;
}
export interface WorkSnapshot {
  settings: { timeZone: string; version: number }[];
  tasks: WorkTask[];
  projects: WorkProject[];
  sections: {
    id: string;
    projectId: string;
    name: string;
    rank: number;
    version: number;
  }[];
  labels: { id: string; name: string; version: number }[];
  days: DayNote[];
  legacyPlans: { taskId: string; date: string; focus: number; rank: number }[];
  events: {
    id: string;
    entityId: string;
    occurredAt: string;
    payload: { action: { type: string } };
  }[];
  migrationReport: string;
}
export const terminal = (t: WorkTask) =>
  ["completed", "cancelled"].includes(t.status);
export function timeDay(v: TimeValue | null, zone: string) {
  if (v?.kind === "instant" && !Number.isFinite(Date.parse(v.atUtc)))
    return null;
  return !v
    ? null
    : v.kind === "date"
      ? v.date
      : calendarDate(new Date(v.atUtc), zone);
}
export function overdue(v: TimeValue | null, now: Date, zone: string) {
  return !v
    ? false
    : v.kind === "date"
      ? v.date < calendarDate(now, zone)
      : Date.parse(v.atUtc) < now.getTime();
}
export function due(v: TimeValue | null, now: Date, zone: string) {
  return !v
    ? false
    : v.kind === "date"
      ? v.date <= calendarDate(now, zone)
      : Date.parse(v.atUtc) <= now.getTime();
}
export function timeLabel(v: TimeValue | null, zone: string) {
  if (v?.kind === "instant" && !Number.isFinite(Date.parse(v.atUtc)))
    return "请填写有效时刻";
  return !v
    ? "未设置"
    : v.kind === "date"
      ? v.date
      : new Intl.DateTimeFormat("zh-CN", {
          timeZone: zone,
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(v.atUtc)) +
        " (" +
        zone +
        ")";
}
export function dateAfter(date: string, n: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function planConflict(
  t: Pick<WorkTask, "plan" | "deadline">,
  zone: string,
) {
  if (!t.plan || !t.deadline) return false;
  if (t.plan.kind === "instant" && t.deadline.kind === "instant")
    return Date.parse(t.plan.atUtc) > Date.parse(t.deadline.atUtc);
  return timeDay(t.plan, zone)! > timeDay(t.deadline, zone)!;
}
export interface WorkRow {
  task: WorkTask;
  reasons: string[];
  group: number;
}
export function dayRows(
  s: WorkSnapshot,
  date: string,
  now: Date,
  zone: string,
): WorkRow[] {
  const actual = date === calendarDate(now, zone),
    note = s.days.find((d) => d.date === date);
  const focus =
    note?.focusIds ??
    s.legacyPlans
      .filter((p) => p.date === date && p.focus)
      .sort((a, b) => a.rank - b.rank)
      .map((p) => p.taskId);
  const rows = s.tasks
    .filter((t) => !terminal(t))
    .map((task) => {
      const reasons: string[] = [];
      if (actual && overdue(task.deadline, now, zone)) reasons.push("真实逾期");
      if (timeDay(task.deadline, zone) === date) reasons.push("当日截止");
      if (focus.includes(task.id)) reasons.push("当日重点");
      if (timeDay(task.plan, zone) === date) reasons.push("当日安排");
      if (
        actual
          ? due(task.followUp, now, zone)
          : timeDay(task.followUp, zone) === date
      )
        reasons.push("到期跟进");
      return {
        task,
        reasons,
        group: reasons.some((r) => r === "真实逾期" || r === "当日截止")
          ? 0
          : reasons.includes("当日重点")
            ? 1
            : reasons.includes("当日安排")
              ? 2
              : 3,
      };
    })
    .filter((r) => r.reasons.length);
  const key = (v: TimeValue | null) =>
    !v
      ? ""
      : v.kind === "date"
        ? v.date + "T23:59:59"
        : (() => {
            const parts = new Intl.DateTimeFormat("en-CA", {
              timeZone: zone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
            }).formatToParts(new Date(v.atUtc));
            const get = (k: string) =>
              parts.find((p) => p.type === k)?.value ?? "";
            return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
          })();
  return rows.sort((a, b) => {
    let n = a.group - b.group;
    if (n) return n;
    if (a.group === 0)
      n = key(a.task.deadline).localeCompare(key(b.task.deadline));
    else if (a.group === 1)
      n = focus.indexOf(a.task.id) - focus.indexOf(b.task.id);
    else if (a.group === 2)
      n =
        Number(b.task.plan?.kind === "instant") -
          Number(a.task.plan?.kind === "instant") ||
        (a.task.plan?.kind === "instant" && b.task.plan?.kind === "instant"
          ? Date.parse(a.task.plan.atUtc) - Date.parse(b.task.plan.atUtc)
          : 0);
    else n = key(a.task.followUp).localeCompare(key(b.task.followUp));
    return (
      n ||
      a.task.priority - b.task.priority ||
      (a.group === 2 ? a.task.rank - b.task.rank : 0) ||
      a.task.createdAt.localeCompare(b.task.createdAt) ||
      a.task.id.localeCompare(b.task.id)
    );
  });
}
export function rescheduleTasks(s: WorkSnapshot, now: Date, zone: string) {
  const date = calendarDate(now, zone);
  return s.tasks.filter(
    (t) =>
      !terminal(t) &&
      t.plan &&
      timeDay(t.plan, zone)! < date &&
      !overdue(t.deadline, now, zone),
  );
}
export function subtree(tasks: WorkTask[], id: string): WorkTask[] {
  const result = tasks.filter((t) => t.id === id);
  for (let i = 0; i < result.length; i++)
    for (const t of tasks)
      if (t.parentId === result[i]!.id && !result.some((r) => r.id === t.id))
        result.push(t);
  return result;
}
