import { expect, it } from "vitest";
import {
  TaskDetailEditor,
  deadlineFromLocal,
  deadlineToLocal,
  type TaskDetails,
  type TaskDetailsCommand,
  type TaskDetailsStorage,
} from "./task-details";
it("preserves command identity on ambiguous failure and keeps a versioned details draft", async () => {
  const base: TaskDetails = {
    taskId: "task",
    title: "原始",
    notes: "",
    completionCriteria: "",
    important: false,
    deadline: null,
    deadlineTimeZone: null,
    estimatedMinutes: null,
    version: 0,
    status: "todo",
    projectId: null,
  };
  const sent: TaskDetailsCommand[] = [];
  const storage: TaskDetailsStorage = {
    async read() {
      return base;
    },
    async save(c) {
      sent.push(c);
      if (sent.length === 1) throw Error("lost reply");
      return { ...base, ...c, version: 1 };
    },
  };
  const editor = new TaskDetailEditor(storage);
  const fields = {
    title: " 修改 ",
    notes: "备注",
    completionCriteria: "标准",
    important: true,
    deadline: null,
    deadlineTimeZone: null,
    estimatedMinutes: 30,
  };
  await expect(editor.save(base, fields)).rejects.toThrow();
  const saved = await editor.save(base, fields);
  expect(sent[1]).toEqual(sent[0]);
  expect(saved.version).toBe(1);
  expect(sent[0]?.title).toBe("修改");
  await expect(editor.save(saved, { ...fields, title: " " })).rejects.toThrow(
    "标题",
  );
});
it("validates calendar time without accepting normalized impossible dates", () => {
  expect(deadlineFromLocal("")).toBeNull();
  expect(() => deadlineFromLocal("2026-02-30T12:00")).toThrow();
  expect(() => deadlineFromLocal("2026-09-19T25:00")).toThrow();
  expect(deadlineToLocal(deadlineFromLocal("2026-09-19T12:45"))).toBe(
    "2026-09-19T12:45",
  );
});
