import { expect, it } from "vitest";
import { projectTree } from "./subtasks";
import type { ProjectTask } from "./projects";
const task = (
  taskId: string,
  parentTaskId: string | null,
  status = "todo",
): ProjectTask => ({
  taskId,
  parentTaskId,
  title: taskId,
  status,
  version: 0,
  createdAt: "",
  executionDate: null,
  completionDate: null,
});
it("counts only leaves across multiple levels and refreshes progress when children are added", () => {
  const rows = [
    task("root", null),
    task("middle", "root"),
    task("leaf", "middle", "completed"),
    task("other", "root"),
  ];
  let result = projectTree(rows);
  expect(result.map((t) => t.taskId)).toEqual([
    "root",
    "middle",
    "leaf",
    "other",
  ]);
  expect(result[0]).toMatchObject({
    leafTotal: 2,
    leafDone: 1,
    depth: 0,
    hasChildren: true,
  });
  expect(result[1]).toMatchObject({ leafTotal: 1, leafDone: 1, depth: 1 });
  result = projectTree([...rows, task("new", "middle")]);
  expect(result[0]).toMatchObject({ leafTotal: 3, leafDone: 1 });
});
it("rejects cycles rather than hiding tasks or counting indefinitely", () => {
  expect(() => projectTree([task("a", "b"), task("b", "a")])).toThrow();
});
