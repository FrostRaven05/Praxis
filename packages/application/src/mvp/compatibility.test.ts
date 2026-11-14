import { describe, expect, expectTypeOf, it } from "vitest";
import fixture from "../../../../docs/m0/fixtures.json";
import {
  deadlineGroup,
  legacyStatus,
  resourceKey,
  taskProgress,
  taskXp,
} from "./compatibility";
import type {
  CommandPayloads,
  Deadline,
  ProjectCommand,
  ResourceScope,
  XpContribution,
} from "./contract";

const now = new Date(fixture.clock.now);
const scope: ResourceScope = {
  kind: "project",
  projectId: fixture.shared.projectId,
};
const creator = fixture.accounts.creator.userId;
const member = fixture.accounts.member.userId;
function credit(overrides: Partial<XpContribution> = {}): XpContribution {
  return {
    scope,
    taskId: fixture.shared.tasks[0]!.id,
    completionId: "completion-1",
    recipientId: creator,
    completedAt: fixture.clock.now,
    active: true,
    ...overrides,
  };
}
describe("M0 resource and wire identity", () => {
  it("keeps same entity IDs distinct by server, personal owner and project scope", () => {
    const id = fixture.collision.entityId;
    const keys = [
      resourceKey(
        fixture.serviceId,
        { kind: "personal", ownerId: creator },
        "task",
        id,
      ),
      resourceKey(
        fixture.serviceId,
        { kind: "personal", ownerId: member },
        "task",
        id,
      ),
      resourceKey(fixture.serviceId, scope, "task", id),
      resourceKey("other-service", scope, "task", id),
      resourceKey(fixture.serviceId, scope, "project", id),
    ];
    expect(new Set(keys).size).toBe(5);
  });
  it("does not collide when identifiers contain delimiters", () => {
    expect(resourceKey("a:b", scope, "task", "c")).not.toBe(
      resourceKey("a", scope, "task", "b:c"),
    );
    expect(() => resourceKey("", scope, "task", "x")).toThrow();
  });
  it("keeps trusted identity and completion facts outside the declared caller contract", () => {
    expectTypeOf<
      Extract<keyof ProjectCommand, "actorId" | "permissions" | "approved">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<
        keyof CommandPayloads["task.status"],
        "recipientId" | "completedAt"
      >
    >().toEqualTypeOf<never>();
    expectTypeOf<CommandPayloads["task.status"]["status"]>().toEqualTypeOf<
      "todo" | "in_progress" | "completed"
    >();
  });
});
describe("M0 legacy projections do not rewrite source", () => {
  it.each(["waiting", "blocked", "cancelled"])(
    "retains %s and its compatibility label",
    (status) => {
      expect(legacyStatus(status)).toMatchObject({
        rawStatus: status,
        legacyOnly: true,
      });
    },
  );
  it("rejects an unknown status instead of silently making it todo", () => {
    expect(() => legacyStatus("invented")).toThrow("Unknown legacy status");
  });
  it("preserves the hierarchy and old leaf progress, including cancelled exclusions", () => {
    const before = JSON.stringify(fixture.legacy);
    expect(taskProgress("legacy-tree", fixture.legacy.tasks)).toEqual({
      mode: "legacy-tree",
      total: 3,
      done: 1,
      percentage: 33,
      allTasksCompleted: false,
    });
    expect(JSON.stringify(fixture.legacy)).toBe(before);
    expect(() => taskProgress("flat", fixture.legacy.tasks)).toThrow(
      "Legacy view required",
    );
  });
  it("counts a new flat project once per undeleted task", () => {
    expect(taskProgress("flat", fixture.shared.tasks)).toMatchObject({
      total: 4,
      done: 1,
      percentage: 25,
    });
    expect(taskProgress("flat", [])).toMatchObject({
      total: 0,
      percentage: null,
      allTasksCompleted: false,
    });
    const done = [
      { id: "a", status: "completed", parentId: null, deleted: false },
    ];
    expect(taskProgress("flat", done)).toMatchObject({
      percentage: 100,
      allTasksCompleted: true,
    });
    expect(
      taskProgress("flat", [
        ...done,
        { id: "b", status: "todo", parentId: null, deleted: true },
      ]),
    ).toEqual(taskProgress("flat", done));
    expect(() => taskProgress("flat", [...done, ...done])).toThrow("Duplicate");
  });
});
describe("M0 deadline precision and local day boundaries", () => {
  const day: Deadline = {
    kind: "date",
    date: "2026-11-10",
    timeZone: "Asia/Hong_Kong",
  };
  it("keeps date-only tasks valid through their project day", () => {
    expect(deadlineGroup(day, now)).toBe("today");
    expect(deadlineGroup(day, new Date("2026-11-10T15:59:59Z"))).toBe("today");
    expect(deadlineGroup(day, new Date("2026-11-10T16:00:00Z"))).toBe(
      "overdue",
    );
  });
  it("handles the 25-hour daylight saving day without adding a fixed 24 hours", () => {
    const dst: Deadline = {
      kind: "date",
      date: "2026-11-01",
      timeZone: "America/New_York",
    };
    expect(deadlineGroup(dst, new Date("2026-11-01T03:59:59Z"))).toBe("later");
    expect(deadlineGroup(dst, new Date("2026-11-01T04:00:00Z"))).toBe("today");
    expect(deadlineGroup(dst, new Date("2026-11-02T04:59:59Z"))).toBe("today");
    expect(deadlineGroup(dst, new Date("2026-11-02T05:00:00Z"))).toBe(
      "overdue",
    );
  });
  it("retains the old instant and zone and never uses the plan date as deadline", () => {
    const old = fixture.legacy.independent;
    const deadline: Deadline = {
      kind: "instant",
      atUtc: old.deadline,
      displayTimezone: old.deadlineTimeZone,
    };
    expect(deadlineGroup(deadline, now)).toBe("overdue");
    expect(deadlineGroup(deadline, new Date(old.deadline))).toBe("overdue");
    expect(old.planDate).toBe("2026-11-09");
    expect(old.deadline).toBe("2026-11-10T02:00:00Z");
    expect(deadlineGroup(null, now)).toBe("undated");
  });
  it("rejects invalid dates, times and zones without dropping the deadline", () => {
    expect(() => deadlineGroup({ ...day, date: "2026-02-30" }, now)).toThrow();
    expect(() =>
      deadlineGroup({ ...day, timeZone: "Invalid/Zone" }, now),
    ).toThrow();
    expect(() =>
      deadlineGroup(
        { kind: "instant", atUtc: "2026-11-10", displayTimezone: "UTC" },
        now,
      ),
    ).toThrow();
  });
});
describe("M0 task XP reference scenarios, separate from legacy cultivation", () => {
  const calculate = (records: readonly XpContribution[], userId = creator) =>
    taskXp(fixture.serviceId, records, userId, now, fixture.clock.timeZone);
  it("credits the original recipient until reopening, even if assignment later changes", () => {
    const original = credit();
    expect(calculate([original])).toMatchObject({
      xp: 10,
      level: 1,
      levelProgress: 10,
      completedToday: 1,
    });
    expect(calculate([original], member).xp).toBe(0);
    expect(calculate([{ ...original, active: false }]).xp).toBe(0);
    const reopened = credit({
      recipientId: member,
      completionId: "completion-2",
    });
    expect(
      calculate([{ ...original, active: false }, reopened], member).xp,
    ).toBe(10);
    expect(calculate([{ ...original, active: false }, reopened]).xp).toBe(0);
  });
  it("deletion and restoration withdraw and restore just one contribution", () => {
    const original = credit();
    expect(calculate([{ ...original, active: false }]).xp).toBe(0);
    expect(calculate([original]).xp).toBe(10);
    expect(() =>
      calculate([original, credit({ completionId: "duplicate-event" })]),
    ).toThrow("More than one");
  });
  it("levels automatically at 100 XP without a breakthrough or reward claim", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      credit({ taskId: `task-${i}` }),
    );
    expect(calculate(records)).toMatchObject({
      xp: 100,
      level: 2,
      levelProgress: 0,
    });
    expect(calculate(records.slice(1))).toMatchObject({
      xp: 90,
      level: 1,
      levelProgress: 90,
    });
  });
  it("retains XP for a valid historical completion without inventing today's timestamp", () => {
    expect(calculate([credit({ completedAt: null })])).toMatchObject({
      xp: 10,
      completedToday: 0,
    });
    expect(fixture.legacy.reward.claimedAt).toBe("2026-11-01T04:00:00Z");
  });
});
