import { expect, it } from "vitest";
import { ChangeCompletion, type CompletionCommand } from "./completion";
import type { DailyTask } from "./capture-today";
it("retries an ambiguous completion with the same operation identity", async () => {
  const sent: CompletionCommand[] = [];
  const task: DailyTask = {
    taskId: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    title: "任务",
    status: "todo",
    source: "temporary",
    projectId: null,
    createdAt: "2026-09-16T00:00:00Z",
    executionDate: "2026-09-16",
    version: 0,
  };
  const usecase = new ChangeCompletion({
    async changeCompletion(command) {
      sent.push(command);
      if (sent.length === 1) throw new Error("response lost");
      return {
        ...task,
        status: "completed",
        version: 1,
        activeCompletionId: command.operationId,
      };
    },
  });
  await expect(
    usecase.change(task, "complete", "Asia/Hong_Kong"),
  ).rejects.toThrow();
  expect(
    (await usecase.change(task, "complete", "Asia/Hong_Kong")).status,
  ).toBe("completed");
  expect(sent[1]).toEqual(sent[0]);
});

it("rejects completion or undo when the shared task state does not permit it", async () => {
  let writes = 0;
  const usecase = new ChangeCompletion({
    async changeCompletion() {
      writes++;
      throw new Error("unexpected persistence");
    },
  });
  const task: DailyTask = {
    taskId: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    title: "任务",
    status: "todo",
    source: "temporary",
    projectId: null,
    createdAt: "2026-09-16T00:00:00Z",
    executionDate: "2026-09-16",
  };
  await expect(usecase.change(task, "undo", "Asia/Hong_Kong")).rejects.toThrow(
    "没有可撤销",
  );
  await expect(
    usecase.change(
      { ...task, status: "completed", activeCompletionId: crypto.randomUUID() },
      "complete",
      "Asia/Hong_Kong",
    ),
  ).rejects.toThrow("只有待办");
  expect(writes).toBe(0);
});
