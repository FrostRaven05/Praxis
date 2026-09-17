import type { DailyTask } from "./capture-today";
import {
  orderedFocus,
  moveFocusChanges,
  preparePlanChange,
  planChange,
} from "./planning";
import { expect, it } from "vitest";
import {
  parseMinutes,
  Planning,
  type InboxCommand,
  type PlanningStorage,
} from "./planning";
it("distinguishes unknown estimates from a zero-minute day", () => {
  expect(parseMinutes("")).toBeNull();
  expect(parseMinutes("0", true)).toBe(0);
  expect(() => parseMinutes("0")).toThrow();
  expect(() => parseMinutes("1.5")).toThrow();
  expect(() => parseMinutes("1441")).toThrow();
});
it("preserves inbox operation identity after ambiguous failure and validates scheduling dates", async () => {
  const sent: InboxCommand[] = [];
  const storage: PlanningStorage = {
    async updatePlan() {},
    async dayLoad() {
      return {
        capacityMinutes: null,
        capacityVersion: 0,
        estimatedMinutes: 0,
        unknownCount: 0,
      };
    },
    async setCapacity() {},
    async captureInbox(c) {
      sent.push(c);
      if (sent.length === 1) throw new Error("lost response");
    },
    async listInbox() {
      return [];
    },
    async scheduleTask() {
      throw new Error("must not write");
    },
  };
  const usecase = new Planning(storage);
  await expect(usecase.capture("任务")).rejects.toThrow();
  await usecase.capture("任务");
  expect(sent[1]).toEqual(sent[0]);
  await expect(
    usecase.schedule(
      { taskId: "id", title: "task", version: 0, createdAt: "" },
      "2026-02-30",
      "UTC",
    ),
  ).rejects.toThrow("安排日期");
});

it("orders focus deterministically, appends new focus and moves across more than 100 items", () => {
  const tasks: DailyTask[] = Array.from({ length: 101 }, (_, i) => ({
    taskId: "task-" + i,
    planId: String(i).padStart(3, "0"),
    title: "task",
    executionDate: "2030-01-15",
    createdAt: "",
    projectId: null,
    status: "todo",
    source: "temporary",
    isFocus: true,
    focusRank: i + 1,
  }));
  expect(orderedFocus([...tasks].reverse()).map((t) => t.planId)).toEqual(
    tasks.map((t) => t.planId),
  );
  const last = tasks[100]!;
  const changes = moveFocusChanges(tasks, last.planId, -1);
  expect(changes).toHaveLength(101);
  expect(changes[99]?.planId).toBe(last.planId);
  expect(changes[100]?.focusRank).toBe(101);
  const fresh = { ...last, planId: "new", isFocus: false };
  expect(
    preparePlanChange([...tasks, fresh], {
      ...planChange(fresh),
      isFocus: true,
    }).focusRank,
  ).toBe(102);
  expect(moveFocusChanges(tasks, tasks[0]!.planId, -1)).toEqual([]);
});
