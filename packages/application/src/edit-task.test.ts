import { expect, it } from "vitest";
import { EditTask, type EditTaskCommand, validCalendarDate } from "./edit-task";
import type { DailyTask } from "./capture-today";
const task: DailyTask = {
  taskId: "task",
  planId: "plan",
  title: "原任务",
  executionDate: "2026-09-16",
  createdAt: "2026-09-16T00:00:00Z",
  projectId: null,
  status: "todo",
  source: "temporary",
  version: 0,
};
it("preserves operation identity across ambiguous edit retries and targets the committed edit on undo", async () => {
  const sent: EditTaskCommand[] = [];
  const edit = new EditTask({
    async editTask(c) {
      sent.push(c);
      if (sent.length === 1) throw new Error("lost response");
      return {
        ...task,
        title: c.title,
        executionDate: c.executionDate,
        version: c.expectedVersion + 1,
      };
    },
  });
  await expect(
    edit.save(task, "新标题", "2026-09-18", "Asia/Hong_Kong"),
  ).rejects.toThrow();
  const receipt = await edit.save(
    task,
    "新标题",
    "2026-09-18",
    "Asia/Hong_Kong",
  );
  expect(sent[1]).toEqual(sent[0]);
  await edit.undo(receipt, "Asia/Hong_Kong");
  expect(sent[2]).toMatchObject({
    undoOf: receipt.operationId,
    title: "原任务",
    executionDate: "2026-09-16",
    expectedVersion: 1,
  });
});
it("rejects blank title, invalid calendar dates and moving a completed task", async () => {
  let calls = 0;
  const edit = new EditTask({
    async editTask() {
      calls++;
      return task;
    },
  });
  await expect(edit.save(task, " ", "2026-09-18", "UTC")).rejects.toThrow();
  await expect(edit.save(task, "任务", "2026-02-30", "UTC")).rejects.toThrow();
  await expect(
    edit.save({ ...task, status: "completed" }, "任务", "2026-09-18", "UTC"),
  ).rejects.toThrow("已完成");
  expect(calls).toBe(0);
  expect(validCalendarDate("2028-02-29")).toBe(true);
});
