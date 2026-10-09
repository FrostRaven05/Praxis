import { expect, test } from "vitest";
import {
  dayRows,
  overdue,
  rescheduleTasks,
  planConflict,
  timeDay,
  subtree,
  type WorkSnapshot,
  type WorkTask,
} from "./productivity";
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
  createdAt: "2026-10-01T00:00:00Z",
  rank: 0,
  labels: [],
  ...fields,
});
const snapshot = (tasks: WorkTask[]): WorkSnapshot => ({
  tasks,
  settings: [],
  projects: [],
  sections: [],
  labels: [],
  days: [],
  legacyPlans: [],
  events: [],
  migrationReport: "",
});
const date = (d: string) => ({ kind: "date" as const, date: d });
const zone = "Asia/Hong_Kong",
  now = new Date("2026-10-08T15:59:59Z");
test("date deadline remains valid through local 23:59 and becomes overdue at midnight", () => {
  expect(overdue(date("2026-10-08"), now, zone)).toBe(false);
  expect(
    overdue(date("2026-10-08"), new Date("2026-10-08T16:00:00Z"), zone),
  ).toBe(true);
  expect(
    overdue(
      { kind: "instant", atUtc: now.toISOString(), displayTimezone: zone },
      now,
      zone,
    ),
  ).toBe(false);
});
test("today deduplicates reasons, retains paused deadlines and focus does not change plan", () => {
  const t = task("a", {
    plan: date("2026-10-08"),
    deadline: date("2026-10-08"),
    followUp: date("2026-10-07"),
    projectId: "p",
  });
  const s = snapshot([t]);
  s.projects = [
    {
      id: "p",
      name: "暂停",
      status: "paused",
      version: 0,
      planVersion: 0,
      focused: 0,
      archivedAt: null,
    },
  ];
  s.days = [
    {
      date: "2026-10-08",
      outcome: "",
      closing: "",
      focusIds: ["a"],
      version: 0,
    },
  ];
  expect(dayRows(s, "2026-10-08", now, zone)).toEqual([
    {
      task: t,
      group: 0,
      reasons: ["当日截止", "当日重点", "当日安排", "到期跟进"],
    },
  ]);
  expect(t.plan).toEqual(date("2026-10-08"));
});
test("past plan is reschedule, future navigation does not inherit overdue or expired followups", () => {
  const s = snapshot([
    task("past", { plan: date("2026-10-07") }),
    task("overdue", { deadline: date("2026-10-07") }),
    task("future", {
      deadline: date("2026-10-09"),
      followUp: date("2026-10-09"),
    }),
  ]);
  expect(rescheduleTasks(s, now, zone).map((t) => t.id)).toEqual(["past"]);
  expect(
    dayRows(s, "2026-10-09", now, zone).map((r) => [r.task.id, r.reasons]),
  ).toEqual([["future", ["当日截止", "到期跟进"]]]);
  expect(s.tasks[0]?.plan).toEqual(date("2026-10-07"));
});
test("stable group priority and manual focus order", () => {
  const s = snapshot([
    task("low", { plan: date("2026-10-08") }),
    task("high", { plan: date("2026-10-08"), priority: 1 }),
    task("focus1"),
    task("focus2"),
  ]);
  s.days = [
    {
      date: "2026-10-08",
      outcome: "",
      closing: "",
      focusIds: ["focus2", "focus1"],
      version: 0,
    },
  ];
  expect(dayRows(s, "2026-10-08", now, zone).map((r) => r.task.id)).toEqual([
    "focus2",
    "focus1",
    "high",
    "low",
  ]);
});
test("timezone changes date interpretation only for instants; conflicts remain warnings", () => {
  const v = {
    kind: "instant" as const,
    atUtc: "2026-10-08T23:30:00Z",
    displayTimezone: "UTC",
  };
  expect(timeDay(v, zone)).toBe("2026-10-09");
  expect(timeDay(v, "America/Los_Angeles")).toBe("2026-10-08");
  expect(timeDay(date("2026-10-08"), zone)).toBe("2026-10-08");
  expect(
    planConflict(
      { plan: date("2026-10-09"), deadline: date("2026-10-08") },
      zone,
    ),
  ).toBe(true);
});
test("legacy multilevel subtrees preserve identity", () => {
  const s = [
    task("parent"),
    task("child", { parentId: "parent" }),
    task("grandchild", { parentId: "child" }),
    task("other"),
  ];
  expect(subtree(s, "parent").map((t) => t.id)).toEqual([
    "parent",
    "child",
    "grandchild",
  ]);
});
