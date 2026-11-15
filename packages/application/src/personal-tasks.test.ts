import { describe, expect, it } from "vitest";
import {
  personalDeadlineGroup,
  personalTaskProgress,
  listedPersonalTasks,
  personalTaskQuery,
  personalTaskStatus,
} from "./personal-tasks";
import type { WorkSnapshot, WorkTask } from "./productivity";
export const task = (id: string, patch: Partial<WorkTask> = {}): WorkTask => ({
  id,
  title: id,
  notes: "",
  projectId: null,
  parentId: null,
  sectionId: null,
  status: "todo",
  version: 7,
  plan: null,
  deadline: null,
  followUp: null,
  priority: 4,
  important: 0,
  waitingFor: "",
  waitingNote: "",
  completedAt: null,
  createdAt: "2026-11-01T04:00:00Z",
  rank: 0,
  labels: [],
  ...patch,
});
export const work = (tasks: WorkTask[] = []): WorkSnapshot => ({
  settings: [{ timeZone: "Asia/Hong_Kong", version: 0 }],
  tasks,
  projects: [],
  sections: [],
  labels: [],
  days: [],
  legacyPlans: [],
  events: [],
  migrationReport: "",
});
const now = new Date("2026-11-11T04:00:00Z");
describe("personal queries from a single account snapshot", () => {
  it("uses the same tasks in list/detail/todo without a Today or project requirement and does not mutate the source", () => {
    const input = work([
      task("independent"),
      task("project", {
        projectId: "p",
        plan: { kind: "date", date: "2026-12-01" },
        deadline: { kind: "date", date: "2026-11-11" },
      }),
      task("done", { status: "completed" }),
      task("cancelled", { status: "cancelled" }),
    ]);
    const before = structuredClone(input),
      q = personalTaskQuery(input, now);
    expect(q.list()).toHaveLength(4);
    expect(q.list(null).map((t) => t.id)).toEqual([
      "independent",
      "done",
      "cancelled",
    ]);
    expect(q.task("project")).toBe(q.list("p")[0]);
    expect(q.groups.undated.map((t) => t.id)).toEqual(["independent"]);
    expect(q.groups.today[0]).toBe(q.task("project"));
    expect(q.completed.map((t) => t.id)).toEqual(["done"]);
    expect(input).toEqual(before);
  });
  it("keeps a miscellaneous task off the miscellaneous list after it is placed on today", () => {
    const input = work([
      task("stay"),
      task("placed"),
      task("later"),
      task("project", { projectId: "p" }),
    ]);
    input.legacyPlans = [
      { taskId: "placed", date: "2026-11-11", focus: 0, rank: 0 },
      { taskId: "later", date: "2026-11-12", focus: 0, rank: 1 },
      { taskId: "project", date: "2026-11-11", focus: 0, rank: 2 },
    ];
    const miscellaneous = personalTaskQuery(
      { ...input, tasks: listedPersonalTasks(input, null, now) },
      now,
    );
    expect(miscellaneous.list(null).map((item) => item.id)).toEqual([
      "stay",
      "later",
    ]);
    const project = personalTaskQuery(
      { ...input, tasks: listedPersonalTasks(input, "p", now) },
      now,
    );
    expect(project.list("p").map((item) => item.id)).toEqual(["project"]);
  });
  it("retains waiting/blocked/cancelled semantics and lets terminal facts win over stale waiting flags", () => {
    expect(personalTaskStatus("todo", true)).toMatchObject({
      rawStatus: "todo",
      status: "waiting",
      label: "等待",
      legacy: true,
    });
    expect(personalTaskStatus("completed", true).status).toBe("completed");
    expect(personalTaskStatus("cancelled", true).status).toBe("cancelled");
    const q = personalTaskQuery(
      work([
        task("waiting", { waiting: true }),
        task("blocked", { status: "blocked", statusReason: "保留原因" }),
        task("done", { status: "completed", waiting: true, completedAt: null }),
      ]),
      now,
    );
    expect(q.groups.undated.map((t) => t.id)).toEqual(["blocked", "waiting"]);
    expect(q.task("done")?.completedAt).toBeNull();
    expect(q.task("blocked")?.statusReason).toBe("保留原因");
  });
  it("groups date deadlines at workspace midnight and preserves instant display zones including DST", () => {
    const date = { kind: "date" as const, date: "2026-11-11" };
    expect(
      personalDeadlineGroup(
        date,
        new Date("2026-11-11T15:59:59Z"),
        "Asia/Hong_Kong",
      ),
    ).toBe("today");
    expect(
      personalDeadlineGroup(
        date,
        new Date("2026-11-11T16:00:00Z"),
        "Asia/Hong_Kong",
      ),
    ).toBe("overdue");
    const instant = {
      kind: "instant" as const,
      atUtc: "2026-11-11T07:00:00Z",
      displayTimezone: "America/Los_Angeles",
    };
    expect(personalDeadlineGroup(instant, now, "Asia/Hong_Kong")).toBe("today");
    expect(
      personalDeadlineGroup(instant, new Date(instant.atUtc), "Asia/Hong_Kong"),
    ).toBe("overdue");
    expect(
      personalDeadlineGroup(
        {
          kind: "instant",
          atUtc: "2026-11-01T09:30:00Z",
          displayTimezone: "America/Los_Angeles",
        },
        new Date("2026-11-01T08:30:00Z"),
        "Asia/Hong_Kong",
      ),
    ).toBe("today");
    expect(() =>
      personalDeadlineGroup({ kind: "date", date: "2026-02-30" }, now, "UTC"),
    ).toThrow();
  });
  it("keeps project progress distinct from lifecycle and uses valid leaf counts for old trees", () => {
    expect(personalTaskProgress([])).toMatchObject({
      total: 0,
      percentage: null,
      allTasksCompleted: false,
    });
    expect(
      personalTaskProgress([task("done", { status: "completed" })]),
    ).toMatchObject({
      mode: "flat",
      done: 1,
      total: 1,
      percentage: 100,
      allTasksCompleted: true,
    });
    const input = work([
      task("root", { projectId: "p" }),
      task("done", { projectId: "p", parentId: "root", status: "completed" }),
      task("wait", { projectId: "p", parentId: "root", status: "waiting" }),
      task("cancel", { projectId: "p", status: "cancelled" }),
    ]);
    input.projects = [
      {
        id: "p",
        name: "个人项目",
        version: 0,
        planVersion: 0,
        status: "active",
        focused: 0,
        archivedAt: null,
      },
    ];
    expect(personalTaskQuery(input, now).progress("p")).toMatchObject({
      mode: "legacy-tree",
      done: 1,
      total: 2,
      percentage: 50,
    });
    expect(input.projects[0]?.status).toBe("active");
    expect(() =>
      personalTaskProgress([task("orphan", { parentId: "missing" })]),
    ).toThrow("父节点缺失");
    expect(() =>
      personalTaskQuery(work([task("same"), task("same")]), now),
    ).toThrow("身份重复");
  });
});
