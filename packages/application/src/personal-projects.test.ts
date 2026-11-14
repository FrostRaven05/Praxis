import { expect, it } from "vitest";
import {
  createPersonalProjectSave,
  personalProjectList,
  PersonalProjectRejectedError,
} from "./personal-projects";
import type { SaveProjectCommand } from "./projects";
import type { WorkProject, WorkSnapshot, WorkTask } from "./productivity";
const fields = { name: "  新项目  ", outcome: "", targetDate: null };
const project = (
  id: string,
  patch: Partial<WorkProject> = {},
): WorkProject => ({
  id,
  name: id,
  status: "active",
  version: 0,
  planVersion: 0,
  focused: 0,
  archivedAt: null,
  ...patch,
});
const task = (id: string, patch: Partial<WorkTask> = {}): WorkTask => ({
  id,
  title: id,
  notes: "",
  projectId: "tree",
  parentId: null,
  sectionId: null,
  status: "todo",
  version: 0,
  plan: null,
  deadline: null,
  followUp: null,
  priority: 4,
  important: 0,
  waitingFor: "",
  waitingNote: "",
  completedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  rank: 0,
  labels: [],
  ...patch,
});
const work = (): WorkSnapshot => ({
  settings: [{ timeZone: "Asia/Hong_Kong", version: 0 }],
  tasks: [],
  projects: [],
  sections: [],
  labels: [],
  days: [],
  legacyPlans: [],
  events: [],
  migrationReport: "",
});

it("creates with only a trimmed name; validates before sending and returns the committed identity again", async () => {
  const calls: SaveProjectCommand[] = [];
  const save = createPersonalProjectSave(null, {
    scope: async () => "a",
    save: async (c) => {
      calls.push(structuredClone(c));
    },
    rejected: () => false,
  });
  await expect(save({ ...fields, name: " " })).rejects.toBeInstanceOf(
    PersonalProjectRejectedError,
  );
  await expect(
    save({ ...fields, targetDate: "2026-02-30" }),
  ).rejects.toBeInstanceOf(PersonalProjectRejectedError);
  const id = await save(fields);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    projectId: id,
    name: "新项目",
    outcome: "",
    targetDate: null,
    priority: 1,
    expectedVersion: null,
  });
  expect(await save(fields)).toBe(id);
  expect(calls).toHaveLength(1);
});
it("retries exactly the same project/operation/time after a lost response and refuses a different intent", async () => {
  const calls: SaveProjectCommand[] = [];
  const save = createPersonalProjectSave(null, {
    scope: async () => "a",
    save: async (c) => {
      calls.push(structuredClone(c));
      if (calls.length === 1) throw Error("lost");
    },
    rejected: () => false,
  });
  await expect(save(fields)).rejects.toThrow("lost");
  await expect(save({ ...fields, name: "different" })).rejects.toThrow(
    "未确认",
  );
  const id = await save(fields);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(id).toBe(calls[0]!.projectId);
});
it("preserves old edit priority and version, releases definite rejection, and checks the editor's account", async () => {
  let scope = "a";
  const calls: SaveProjectCommand[] = [];
  const base = {
    id: "p",
    name: "旧",
    outcome: "旧目标",
    targetDate: null,
    priority: 2,
    version: 8,
  };
  const save = createPersonalProjectSave(base, {
    scope: async () => scope,
    save: async (c) => {
      calls.push(c);
      if (calls.length === 1) throw "STATE_CONFLICT";
    },
    rejected: (e) => e === "STATE_CONFLICT",
  });
  await expect(save(fields)).rejects.toBeInstanceOf(
    PersonalProjectRejectedError,
  );
  await save({ ...fields, targetDate: "2026-12-01" });
  expect(calls[1]).toMatchObject({
    projectId: "p",
    expectedVersion: 8,
    priority: 2,
    targetDate: "2026-12-01",
  });
  expect(calls[0]!.operationId).not.toBe(calls[1]!.operationId);
  const other = createPersonalProjectSave(null, {
    scope: async () => scope,
    save: async () => {
      throw Error("must not send");
    },
    rejected: () => false,
  });
  scope = "b";
  await expect(other(fields)).rejects.toThrow("账号或工作空间");
});
it("keeps an unknown attempt locked if its account changes and resolves it on the original account", async () => {
  let scope = "a",
    calls = 0;
  const save = createPersonalProjectSave(null, {
    scope: async () => scope,
    save: async () => {
      if (++calls === 1) throw Error("lost");
    },
    rejected: () => false,
  });
  await expect(save(fields)).rejects.toThrow("lost");
  scope = "b";
  try {
    await save(fields);
    throw Error("expected error");
  } catch (error) {
    expect(error).not.toBeInstanceOf(PersonalProjectRejectedError);
    expect(String(error)).toContain("原账号");
  }
  expect(calls).toBe(1);
  scope = "a";
  await save(fields);
  expect(calls).toBe(2);
});
it("uses effective leaves, excludes cancelled, separates project targets from deadlines, sorts known project update instants", () => {
  const w = work();
  w.projects = [
    project("empty", {
      createdAt: "2026-11-01T00:00:00Z",
      targetDate: "2000-01-01",
    }),
    project("tree", { updatedAt: "2026-11-11T08:00:00+08:00" }),
    project("done", { updatedAt: "2026-11-11T01:00:00Z" }),
  ];
  w.tasks = [
    task("parent"),
    task("done-leaf", { parentId: "parent", status: "completed" }),
    task("late", {
      parentId: "parent",
      deadline: {
        kind: "instant",
        atUtc: "2026-11-11T02:00:00Z",
        displayTimezone: "America/Los_Angeles",
      },
    }),
    task("cancelled", { parentId: "parent", status: "cancelled" }),
    task("finished", { projectId: "done", status: "completed" }),
  ];
  const before = structuredClone(w),
    rows = personalProjectList(w, new Date("2026-11-11T04:00:00Z"));
  expect(rows.map((r) => r.project.id)).toEqual(["done", "tree", "empty"]);
  expect(rows[0]!.progress).toMatchObject({
    total: 1,
    done: 1,
    percentage: 100,
    overdue: 0,
  });
  expect(rows[1]!.progress).toMatchObject({
    mode: "legacy-tree",
    total: 2,
    done: 1,
    percentage: 50,
    overdue: 1,
  });
  expect(rows[2]!.progress).toMatchObject({
    total: 0,
    percentage: null,
    overdue: 0,
  });
  expect(w).toEqual(before);
  w.tasks[1]!.status = "todo";
  expect(personalProjectList(w)[1]!.progress?.done).toBe(0);
});
it("keeps a malformed legacy project visible alongside valid projects", () => {
  const w = work();
  w.projects = [project("tree"), project("empty")];
  w.tasks = [task("cycle", { parentId: "cycle" })];
  const rows = personalProjectList(w);
  expect(rows.find((r) => r.project.id === "tree")?.progress).toBeNull();
  expect(rows.find((r) => r.project.id === "empty")?.progress?.total).toBe(0);
});
it("shows a query warning without crashing cards or changing malformed historical dates", () => {
  const w = work();
  w.projects = [
    project("tree", {
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "unknown",
    }),
  ];
  w.tasks = [
    task("bad-date", { deadline: { kind: "date", date: "2026-02-30" } }),
  ];
  const before = structuredClone(w),
    row = personalProjectList(w)[0]!;
  expect(row.project.id).toBe("tree");
  expect(row.progress).toBeNull();
  expect(row.error).toContain("截止");
  expect(w).toEqual(before);
});
