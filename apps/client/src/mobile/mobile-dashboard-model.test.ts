import { describe, expect, it } from "vitest";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  calendarTasks,
  dayMetrics,
  focusElapsed,
  monthDays,
  shiftMonth,
} from "./mobile-dashboard-model";

const entity = (
  id: string,
  kind: WorkspaceEntity["kind"],
  data: Record<string, unknown>,
  deleted = false,
): WorkspaceEntity => ({
  id,
  kind,
  data,
  deleted,
  version: 1,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
});
describe("mobile dashboard projections", () => {
  it("uses whole Monday-first calendar weeks and clamps month navigation", () => {
    expect(monthDays("2026-10-11")).toHaveLength(35);
    expect(monthDays("2026-10-11")[0]).toBe("2026-09-28");
    expect(monthDays("2026-10-11").at(-1)).toBe("2026-11-01");
    expect(monthDays("2026-03-11")).toHaveLength(42);
    expect(monthDays("2027-02-01")).toHaveLength(28);
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftMonth("2024-03-31", -1)).toBe("2024-02-29");
  });
  it("includes execution dates and independent deadlines without duplicate entries", () => {
    const tasks = [
      entity("both", "task", {
        executionDate: "2026-10-11",
        dueDate: "2026-10-11",
      }),
      entity("deadline", "task", { dueDate: "2026-10-11" }),
      entity("cancelled", "task", {
        status: "cancelled",
        executionDate: "2026-10-11",
      }),
      entity("deleted", "task", { executionDate: "2026-10-11" }, true),
    ];
    expect(calendarTasks(tasks, "2026-10-11").map((e) => e.id)).toEqual([
      "both",
      "deadline",
    ]);
  });
  it("uses workspace timezone, actual completion timestamps and finished sessions", () => {
    const items = [
      entity("done", "task", {
        status: "completed",
        completedAt: "2026-10-10T18:00:00Z",
        estimatedMinutes: 30,
      }),
      entity("unknown", "task", { status: "completed" }),
      entity("undone", "task", {
        status: "todo",
        completedAt: "2026-10-10T18:00:00Z",
      }),
      entity("focus", "focus", {
        startedAt: "2026-10-10T18:00:00Z",
        endedAt: "2026-10-10T19:00:00Z",
        durationSeconds: 600,
      }),
      entity("active", "focus", {
        startedAt: "2026-10-10T18:00:00Z",
        durationSeconds: 900,
      }),
      entity("invalid", "focus", {
        startedAt: "invalid",
        endedAt: "invalid",
        durationSeconds: Infinity,
      }),
    ];
    const result = dayMetrics(items, "2026-10-11", "Asia/Hong_Kong");
    expect(result.completed).toBe(1);
    expect(result.estimatedMinutes).toBe(30);
    expect(result.sessions).toBe(1);
    expect(result.focusSeconds).toBe(600);
    expect(dayMetrics(items, "2026-10-10", "Asia/Hong_Kong").completed).toBe(0);
    expect(focusElapsed("invalid", Date.now())).toBe(0);
    expect(
      focusElapsed("2026-10-11T00:00:00Z", Date.parse("2026-10-11T00:00:03Z")),
    ).toBe(3);
  });
});
