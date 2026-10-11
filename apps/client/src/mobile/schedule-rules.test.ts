import { describe, it, expect } from "vitest";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  ruleAt,
  matchesRule,
  preserveRuleHistory,
  futureRuleChanges,
  type ScheduleRule,
} from "./schedule-rules";
const rule: ScheduleRule = {
  effectiveDate: "2026-10-01",
  frequency: "daily",
  target: 1,
  interval: 1,
  weekdays: [],
  paused: false,
  active: true,
  timeZone: "Asia/Hong_Kong",
};
const entity: WorkspaceEntity = {
  id: "r",
  kind: "recurrence",
  version: 1,
  deleted: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  data: {
    title: "阅读",
    startDate: "2026-10-01",
    frequency: "daily",
    ruleHistory: [rule],
  },
};
describe("mobile schedule rules", () => {
  it("keeps historical dates under their original rule after a future change", () => {
    const next = {
      ...rule,
      effectiveDate: "2026-10-12",
      frequency: "weekdays",
      weekdays: [1],
    };
    const changed = { ...entity, data: preserveRuleHistory(entity, next) };
    expect(ruleAt(changed, "2026-10-11")).toEqual(rule);
    expect(matchesRule(ruleAt(changed, "2026-10-13"), "2026-10-13")).toBe(
      false,
    );
    expect(matchesRule(ruleAt(changed, "2026-10-12"), "2026-10-12")).toBe(true);
  });
  it("preserves manually moved and in-progress occurrences while cancelling unmodified nonmatches", () => {
    const task = (
      id: string,
      data: Record<string, unknown>,
    ): WorkspaceEntity => ({
      ...entity,
      id,
      kind: "task",
      data: {
        title: "阅读",
        status: "todo",
        recurrenceId: "r",
        originalDate: "2026-10-13",
        executionDate: "2026-10-13",
        ...data,
      },
    });
    const preview = futureRuleChanges(
      entity,
      {
        ...rule,
        effectiveDate: "2026-10-12",
        frequency: "weekdays",
        weekdays: [1],
      },
      [
        task("a", {}),
        task("b", { status: "in_progress" }),
        task("c", { executionDate: "2026-10-14" }),
      ],
    );
    expect(preview.preserved).toBe(2);
    expect(preview.changes.map((c) => c.id)).toEqual(["a"]);
    expect(preview.changes[0]?.data.status).toBe("cancelled");
  });
  it("supports intervals anchored at the effective date and pause without changing prior rule", () => {
    expect(
      matchesRule(
        { ...rule, frequency: "interval", interval: 3 },
        "2026-10-04",
      ),
    ).toBe(true);
    expect(
      matchesRule(
        { ...rule, frequency: "interval", interval: 3 },
        "2026-10-05",
      ),
    ).toBe(false);
    expect(matchesRule({ ...rule, paused: true }, "2026-10-04")).toBe(false);
  });
});
