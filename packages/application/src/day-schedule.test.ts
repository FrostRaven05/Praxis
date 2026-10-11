import { expect, it } from "vitest";
import type { DailyTask } from "./capture-today";
import {
  moveDayTaskChanges,
  orderedDayTasks,
  moveDayItems,
  orderedDayItems,
  type DayArrangementItem,
} from "./day-schedule";

const task = (planId: string, fields: Partial<DailyTask> = {}): DailyTask => ({
  taskId: `task-${planId}`,
  planId,
  title: planId,
  executionDate: "2026-10-01",
  createdAt: "2026-10-01T01:00:00Z",
  projectId: null,
  status: "todo",
  source: "temporary",
  ...fields,
});
it("shares one order for habit occurrences and ordinary tasks across all periods", () => {
  const rows: DayArrangementItem[] = [
    {
      key: "task-a",
      dayPeriod: "morning",
      dayRank: 1,
      createdAt: "2026-10-11",
    },
    {
      key: "habit:h",
      dayPeriod: "morning",
      dayRank: 2,
      createdAt: "2026-10-11",
    },
    {
      key: "task-b",
      dayPeriod: "morning",
      dayRank: 3,
      createdAt: "2026-10-11",
    },
  ];
  const move = (
    key: string,
    period: "morning" | "afternoon" | "evening",
    anchor?: string,
  ) => {
    const changes = moveDayItems(rows, key, period, anchor);
    for (const change of changes)
      Object.assign(
        rows.find((r) => r.key === change.key)!,
        change,
      );
    return changes;
  };
  move("habit:h", "afternoon");
  expect(
    orderedDayItems(rows, "morning").map((r) => [r.key, r.dayRank]),
  ).toEqual([
    ["task-a", 1],
    ["task-b", 2],
  ]);
  move("habit:h", "evening");
  move("habit:h", "morning", "task-b");
  expect(orderedDayItems(rows, "morning").map((r) => r.key)).toEqual([
    "task-a",
    "habit:h",
    "task-b",
  ]);
  move("task-b", "morning", "habit:h");
  expect(orderedDayItems(rows, "morning").map((r) => r.key)).toEqual([
    "task-a",
    "task-b",
    "habit:h",
  ]);
  expect(moveDayItems(rows, "habit:h", "morning", "missing")).toEqual([]);
  expect(moveDayItems(rows, "habit:h", "morning")).toEqual([]);
});
it("keeps starred and ordinary tasks together, and appends new tasks after manually ordered ones", () => {
  const items = [
    task("new"),
    task("b", { dayRank: 2, isFocus: true }),
    task("a", { dayRank: 1 }),
  ];
  expect(orderedDayTasks(items, "morning").map((item) => item.planId)).toEqual([
    "a",
    "b",
    "new",
  ]);
  expect(moveDayTaskChanges(items, "new", "morning")).toEqual([]);
});
it("reorders either kind of task without changing its star or estimate", () => {
  const items = [
    task("a", { dayRank: 1 }),
    task("b", { dayRank: 2, isFocus: true, estimatedMinutes: 45 }),
  ];
  const changes = moveDayTaskChanges(items, "b", "morning", "a");
  expect(changes.map((item) => [item.planId, item.dayRank])).toEqual([
    ["b", 1],
    ["a", 2],
  ]);
  expect(changes[0]).toMatchObject({ isFocus: true, estimatedMinutes: 45 });
  expect(moveDayTaskChanges(items, "a", "morning", "a")).toEqual([]);
});
it("moves into an empty period, closes the source gap, and excludes completed or cancelled tasks", () => {
  const items = [
    task("a", { dayRank: 1 }),
    task("b", { dayRank: 2 }),
    task("done", { status: "completed" }),
    task("cancelled", { status: "cancelled" }),
  ];
  expect(moveDayTaskChanges(items, "a", "evening")).toMatchObject([
    { planId: "a", dayPeriod: "evening", dayRank: 1 },
    { planId: "b", dayPeriod: "morning", dayRank: 1 },
  ]);
  expect(moveDayTaskChanges(items, "done", "afternoon")).toEqual([]);
  expect(orderedDayTasks(items, "morning")).toHaveLength(2);
});
it("ignores stale drop anchors and makes an unchanged order a no-op", () => {
  const items = [task("a", { dayRank: 1 }), task("b", { dayRank: 2 })];
  expect(moveDayTaskChanges(items, "a", "morning", "missing")).toEqual([]);
  expect(moveDayTaskChanges(items, "a", "morning", "b", "before")).toEqual([]);
});
