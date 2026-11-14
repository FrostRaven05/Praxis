import { expect, test } from "vitest";
import type { DailyTask, WorkSnapshot, WorkTask } from "@praxis/application";
import { dayTimeline, recommendBacklog, upcomingDayRows } from "./day-timeline";

const zone = "Asia/Hong_Kong";
const date = "2026-10-11";
const now = new Date("2026-10-11T02:00:00Z");
const task = (id: string, fields: Partial<WorkTask> = {}): WorkTask => ({
  id,
  title: id,
  notes: "",
  projectId: null,
  parentId: null,
  sectionId: null,
  status: "todo",
  version: 0,
  plan: null,
  deadline: null,
  followUp: null,
  priority: 4,
  important: 0,
  waitingFor: "",
  waitingNote: "",
  completedAt: null,
  createdAt: now.toISOString(),
  rank: 0,
  labels: [],
  ...fields,
});
const snapshot = (tasks: WorkTask[]): WorkSnapshot => ({
  tasks,
  settings: [{ timeZone: zone, version: 0 }],
  projects: [],
  sections: [],
  labels: [],
  days: [],
  legacyPlans: [],
  events: [],
  migrationReport: "",
});
const instant = (atUtc: string) => ({
  kind: "instant" as const,
  atUtc,
  displayTimezone: zone,
});
const scheduled: DailyTask = {
  taskId: "scheduled",
  planId: "plan",
  title: "scheduled",
  executionDate: date,
  createdAt: now.toISOString(),
  projectId: null,
  status: "todo",
  source: "temporary",
};
test("keeps scheduled tasks once while retaining deadline and follow-up reasons", () => {
  const result = dayTimeline(
    snapshot([
      task("scheduled", {
        plan: { kind: "date", date },
        deadline: { kind: "date", date },
        followUp: { kind: "date", date },
      }),
    ]),
    [scheduled],
    date,
    now,
    zone,
  );
  expect(result.periods).toEqual({ morning: [], afternoon: [], evening: [] });
  expect(result.attention).toEqual([]);
  expect(result.reasons.get("scheduled")).toEqual([
    "当日截止",
    "当日安排",
    "到期跟进",
  ]);
});
test("places independent plans into periods in the workspace timezone, including UTC date boundaries", () => {
  const result = dayTimeline(
    snapshot([
      task("morning", { plan: instant("2026-10-10T23:00:00Z") }),
      task("afternoon", { plan: instant("2026-10-11T04:00:00Z") }),
      task("evening", { plan: instant("2026-10-11T10:00:00Z") }),
      task("date-only", { plan: { kind: "date", date } }),
      task("tomorrow", { plan: instant("2026-10-11T16:00:00Z") }),
    ]),
    [],
    date,
    now,
    zone,
  );
  expect(result.periods.morning.map((r) => r.task.id)).toEqual([
    "morning",
    "date-only",
  ]);
  expect(result.periods.afternoon.map((r) => r.task.id)).toEqual(["afternoon"]);
  expect(result.periods.evening.map((r) => r.task.id)).toEqual(["evening"]);
});
test("retains unscheduled deadlines, overdue follow-ups and focus, while excluding completed tasks", () => {
  const data = snapshot([
    task("deadline", {
      deadline: { kind: "date", date },
      plan: { kind: "date", date: "2026-10-12" },
    }),
    task("follow-up", {
      followUp: { kind: "date", date: "2026-10-10" },
      status: "waiting",
    }),
    task("focus"),
    task("done", { deadline: { kind: "date", date }, status: "completed" }),
  ]);
  data.days = [
    { date, outcome: "", closing: "", focusIds: ["focus"], version: 0 },
  ];
  const result = dayTimeline(data, [], date, now, zone);
  expect(result.attention.map((r) => r.task.id)).toEqual([
    "deadline",
    "focus",
    "follow-up",
  ]);
  expect(result.periods).toEqual({ morning: [], afternoon: [], evening: [] });
});
test("upcoming keeps daily schedules and deduplicates tasks with multiple date reasons", () => {
  const data = snapshot([
    task("scheduled"),
    task("both", {
      plan: { kind: "date", date },
      deadline: { kind: "date", date },
    }),
    task("done", { plan: { kind: "date", date }, status: "completed" }),
  ]);
  data.legacyPlans = [
    { taskId: "scheduled", date, focus: 0, rank: 0 },
    { taskId: "both", date, focus: 0, rank: 1 },
  ];
  expect(
    upcomingDayRows(data, date, zone).map((row) => [row.task.id, row.reasons]),
  ).toEqual([
    ["scheduled", ["安排"]],
    ["both", ["计划", "截止"]],
  ]);
});

test("recommendations come from the whole backlog, skip scheduled/parent/inactive tasks, and rank by urgency", () => {
  const tasks = [
    task("plain"),
    task("overdue", { deadline: { kind: "date", date: "2026-10-01" } }),
    task("p1", { priority: 1 }),
    task("parent"),
    task("child", { parentId: "parent" }),
    task("scheduled"),
    task("done", { status: "completed" }),
    task("waiting", { status: "waiting" }),
    task("paused", { projectId: "paused-project" }),
  ];
  const snap = {
    ...snapshot(tasks),
    projects: [
      {
        id: "paused-project",
        name: "paused",
        status: "paused",
        version: 0,
        planVersion: 0,
        focused: 0,
        archivedAt: null,
      },
    ],
  };
  const result = recommendBacklog(snap, [scheduled], date, zone);
  expect(result.map((r) => r.task.id)).toEqual(["overdue", "p1", "child", "plain"]);
  expect(result[0]!.reasons).toContain("已逾期");
  expect(recommendBacklog(snap, [scheduled], date, zone, 2)).toHaveLength(2);
});