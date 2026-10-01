import { expect, it } from "vitest";
import type { DailyTask } from "./capture-today";
import { moveDayTaskChanges, orderedDayTasks } from "./day-schedule";

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
