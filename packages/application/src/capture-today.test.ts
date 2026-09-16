import { expect, test } from "vitest";
import { CaptureToday, type TaskStorage } from "./capture-today";

const unavailable: TaskStorage = {
  async capture() {
    throw new Error("Disk unavailable");
  },
  async listDay() {
    throw new Error("Disk unavailable");
  },
};
test("an empty title is rejected with a useful message before attempting storage", async () => {
  const today = new CaptureToday(unavailable);
  await expect(today.add("   \n ", "Asia/Hong_Kong")).rejects.toThrow(
    "请填写任务标题",
  );
});

test("a title alone becomes a temporary task on the user's today, readable after capture", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T16:05:00Z"));
  try {
    const tasks = new Map<string, import("./capture-today").DailyTask>();
    const storage: TaskStorage = {
      async capture(command) {
        const item: import("./capture-today").DailyTask = {
          taskId: command.taskId,
          planId: command.planId,
          title: command.title,
          executionDate: command.executionDate,
          createdAt: command.occurredAt,
          projectId: null,
          status: "todo",
          source: "temporary",
        };
        tasks.set(command.operationId, item);
        return item;
      },
      async listDay(date) {
        return [...tasks.values()].filter(
          (task) => task.executionDate === date,
        );
      },
    };
    const today = new CaptureToday(storage);
    await today.add("  整理文章提纲  ", "Asia/Hong_Kong");
    expect(await today.list("2026-09-16")).toEqual([
      expect.objectContaining({
        title: "整理文章提纲",
        executionDate: "2026-09-16",
        projectId: null,
        status: "todo",
        source: "temporary",
        taskId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        planId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ]);
    expect(await today.list("2026-09-15")).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("retry after an ambiguous storage error reuses the operation instead of duplicating a task", async () => {
  const tasks = new Map<string, import("./capture-today").DailyTask>();
  let loseReply = true;
  const storage: TaskStorage = {
    async capture(command) {
      const existing = tasks.get(command.operationId);
      if (existing) return existing;
      const task: import("./capture-today").DailyTask = {
        taskId: command.taskId,
        planId: command.planId,
        title: command.title,
        executionDate: command.executionDate,
        createdAt: command.occurredAt,
        projectId: null,
        status: "todo",
        source: "temporary",
      };
      tasks.set(command.operationId, task);
      if (loseReply) {
        loseReply = false;
        throw new Error("保存结果未收到");
      }
      return task;
    },
    async listDay(date) {
      return [...tasks.values()].filter((task) => task.executionDate === date);
    },
  };
  const today = new CaptureToday(storage);
  await expect(today.add("整理提纲", "Asia/Hong_Kong")).rejects.toThrow(
    "保存结果未收到",
  );
  const saved = await today.add("整理提纲", "Asia/Hong_Kong");
  expect(await today.list(saved.executionDate)).toHaveLength(1);
});
