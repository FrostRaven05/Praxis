import { describe, expect, it } from "vitest";
import { currentSubtask, todayTarget, type CurrentSubtaskRef } from "./current-subtask";

function step(
  id: string,
  patch: Partial<CurrentSubtaskRef> = {},
): CurrentSubtaskRef {
  return {
    id,
    title: id,
    parentId: "parent",
    status: "todo",
    rank: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("current subtask", () => {
  it("uses the first unfinished step when nothing is in progress", () => {
    const current = currentSubtask(
      [
        step("done", { status: "completed", rank: 0 }),
        step("next", { title: "去缴费", rank: 1 }),
        step("later", { rank: 2 }),
      ],
      "parent",
    );
    expect(current?.id).toBe("next");
  });

  it("prefers the step already in progress", () => {
    const current = currentSubtask(
      [
        step("first", { rank: 0 }),
        step("active", { status: "in_progress", rank: 1 }),
      ],
      "parent",
    );
    expect(current?.id).toBe("active");
  });

  it("ignores other tasks, cancelled steps, and a finished list", () => {
    expect(
      currentSubtask(
        [
          step("other", { parentId: "elsewhere" }),
          step("gone", { status: "cancelled", rank: 0 }),
          step("done", { status: "completed", rank: 1 }),
        ],
        "parent",
      ),
    ).toBeNull();
    expect(currentSubtask([], "parent")).toBeNull();
  });
});

describe("today target", () => {
  const root = step("root", { parentId: null, title: "第一条任务" });

  it("keeps a task that has no children", () => {
    expect(todayTarget([root], root)?.id).toBe("root");
  });

  it("follows the current step down to a leaf", () => {
    const child = step("child", { parentId: "root", title: "多少啊", status: "in_progress" });
    const nested = step("nested", { parentId: "child", title: "细节", rank: 0 });
    expect(todayTarget([root, child, nested], root)?.id).toBe("nested");
  });

  it("does not place a finished task", () => {
    expect(todayTarget([step("done", { status: "completed" })], step("done", { status: "completed" }))).toBeNull();
  });
});
