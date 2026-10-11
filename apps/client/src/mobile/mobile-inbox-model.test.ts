import { expect, it } from "vitest";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { unplannedTasks, sortedInboxTasks } from "./mobile-inbox-model";
const item = (
  id: string,
  data: Record<string, unknown>,
  kind: WorkspaceEntity["kind"] = "task",
): WorkspaceEntity => ({
  id,
  data,
  kind,
  version: 1,
  deleted: false,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
});
it("treats a deadline separately from a plan and excludes finished, scheduled, nested and archived content", () => {
  const due = item("due", {
    title: "Due",
    status: "todo",
    dueDate: "2026-10-15",
  });
  const input = [
    due,
    item("planned", { executionDate: "2026-10-12" }),
    item("done", { status: "completed" }),
    item("cancelled", { status: "cancelled" }),
    item("child", { parentId: "due" }),
    item("closed", { projectId: "p" }),
    item("p", { status: "active", archivedAt: "2026-10-10" }, "project"),
    { ...item("deleted", {}), deleted: true },
  ];
  expect(unplannedTasks(input).map((e) => e.id)).toEqual(["due"]);
  expect(due.data.dueDate).toBe("2026-10-15");
});
it("orders priority correctly with P1 above P2, P3 and ordinary tasks and filters without altering input", () => {
  const input = [
    item("p3", { priority: 3, projectId: "project" }),
    item("ordinary", { priority: 0 }),
    item("p1", { priority: 1 }),
    item("p2", { priority: 2 }),
  ];
  expect(
    sortedInboxTasks(input, "", "priority", true).map((e) => e.id),
  ).toEqual(["p1", "p2", "p3", "ordinary"]);
  expect(
    sortedInboxTasks(input, "unassigned", "priority", false).map((e) => e.id),
  ).toEqual(["ordinary", "p2", "p1"]);
  expect(
    sortedInboxTasks(input, "project", "created", true).map((e) => e.id),
  ).toEqual(["p3"]);
  expect(input.map((e) => e.id)).toEqual(["p3", "ordinary", "p1", "p2"]);
});
