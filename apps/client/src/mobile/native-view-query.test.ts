import { expect, it } from "vitest";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { executeNativeView, type NativeViewQuery } from "./native-view-query";
const entity = (
  kind: WorkspaceEntity["kind"],
  data: Record<string, unknown>,
  id = crypto.randomUUID(),
): WorkspaceEntity => ({
  id,
  kind,
  data,
  version: 1,
  deleted: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
});
const query = (patch: Partial<NativeViewQuery> = {}): NativeViewQuery => ({
  text: "",
  entityType: "task",
  projectId: null,
  status: null,
  includeArchived: false,
  groups: [],
  sort: "priority",
  groupBy: "project",
  ...patch,
});
it("executes desktop AND/OR conditions for labels, waiting, numeric fields, dates, project context and dependencies", () => {
  const p = entity("project", { title: "P", status: "active" }),
    t = entity("task", {
      title: "Matching",
      status: "todo",
      waiting: true,
      priority: 1,
      projectId: p.id,
      tags: ["label"],
      estimatedMinutes: 10,
      startDate: "2026-10-10",
      dueDate: "2026-10-11",
      followUpDate: "2026-10-09",
    }),
    u = entity("task", { title: "Excluded", status: "todo", priority: 0 });
  p.data.nextActionId = t.id;
  const label = entity("desktop_row", {
    table: "labels",
    row: { id: "label-id", name: "label" },
  });
  const conditions = [
    ["project", "eq", p.id],
    ["label", "eq", "label-id"],
    ["status", "eq", "waiting"],
    ["priority", "lte", "2"],
    ["estimate", "lte", "15"],
    ["plan", "present", ""],
    ["deadline", "thisWeek", ""],
    ["followUp", "due", ""],
    ["nextAction", "eq", "true"],
    ["independent", "eq", "false"],
    ["projectActive", "eq", "true"],
    ["unblocked", "eq", "true"],
  ].map(([field, op, value]) => ({ field: field!, op: op!, value: value! }));
  const result = executeNativeView(
    [p, t, u, label],
    query({
      groups: [conditions, [{ field: "priority", op: "eq", value: "3" }]],
    }),
    "2026-10-11",
  );
  expect(result.results.map((e) => e.id)).toEqual([t.id]);
  expect(result.warnings).toEqual([]);
  expect(result.group(t)).toBe("P");
  const dependency = entity("desktop_row", {
    table: "task_dependencies",
    row: { task_id: t.id, predecessor_id: u.id },
  });
  expect(
    executeNativeView(
      [p, t, u, label, dependency],
      query({ groups: [conditions] }),
      "2026-10-11",
    ).results,
  ).toEqual([]);
  u.data.status = "completed";
  expect(
    executeNativeView(
      [p, t, u, label, dependency],
      query({ groups: [conditions] }),
      "2026-10-11",
    ).results.map((e) => e.id),
  ).toEqual([t.id]);
});
it("uses workspace timezone for preserved TimeValue instants and matches record project links", () => {
  const settings = entity("settings", { timeZone: "Asia/Hong_Kong" }),
    p = entity("project", { title: "P", status: "active" }),
    t = entity("task", {
      title: "Date instant",
      status: "todo",
      priority: 2,
      projectId: p.id,
      dueDate: null,
      desktop: {
        deadline_value: JSON.stringify({
          kind: "datetime",
          atUtc: "2026-10-10T18:00:00Z",
        }),
      },
    }),
    r = entity("review", {
      title: "Review",
      body: "proof",
      links: [{ targetType: "task", targetId: t.id }],
    }),
    all = [settings, p, t, r];
  expect(
    executeNativeView(
      all,
      query({
        groups: [[{ field: "deadline", op: "eq", value: "2026-10-11" }]],
      }),
      "2026-10-11",
    ).results.map((e) => e.id),
  ).toEqual([t.id]);
  expect(
    executeNativeView(
      all,
      query({ entityType: "record", projectId: p.id, text: "proof" }),
      "2026-10-11",
    ).results.map((e) => e.id),
  ).toEqual([r.id]);
});
it("uses the workspace date for native instants even when their mobile projection uses another display zone", () => {
  const settings = entity("settings", { timeZone: "Asia/Hong_Kong" });
  const t = entity("task", {
    title: "Cross-midnight instant",
    status: "todo",
    dueDate: "2026-10-10",
    desktop: {
      deadline_value: JSON.stringify({
        kind: "instant",
        atUtc: "2026-10-10T23:30:00Z",
        displayTimezone: "UTC",
      }),
    },
  });
  const filter = query({
    groups: [[{ field: "deadline", op: "eq", value: "2026-10-11" }]],
  });
  expect(
    executeNativeView([settings, t], filter, "2026-10-11").results.map((e) => e.id),
  ).toEqual([t.id]);
  t.data.dueDate = "2026-10-12";
  expect(
    executeNativeView([settings, t], filter, "2026-10-11").results,
  ).toEqual([]);
  expect(
    executeNativeView(
      [settings, t],
      query({ groups: [[{ field: "deadline", op: "eq", value: "2026-10-12" }]] }),
      "2026-10-11",
    ).results.map((e) => e.id),
  ).toEqual([t.id]);
});
it("explicitly refuses unsupported predicates instead of returning an unfiltered list, and warns on lost references", () => {
  const t = entity("task", { title: "T", status: "todo" });
  const result = executeNativeView(
    [t],
    query({ groups: [[{ field: "unknown", op: "eq", value: "x" }]] }),
    "2026-10-11",
  );
  expect(result.results).toEqual([]);
  expect(result.warnings[0]).toMatch(/不支持/);
  expect(
    executeNativeView(
      [t],
      query({
        groups: [[{ field: "label", op: "eq", value: "deleted-label" }]],
      }),
      "2026-10-11",
    ).warnings[0],
  ).toMatch(/标签引用/);
});
it("executes the mobileFilter compatibility extension with its original OR and relative-week semantics", () => {
  const a = entity("task", { title: "needle", status: "todo", priority: 0 }),
    b = entity("task", {
      title: "B",
      status: "todo",
      priority: 1,
      dueDate: "2026-10-15",
    }),
    c = entity("task", {
      title: "C",
      status: "todo",
      priority: 0,
      dueDate: "2026-11-01",
    });
  const result = executeNativeView(
    [a, b, c],
    {
      ...query(),
      mobileFilter: {
        query: "needle",
        due: "week",
        mode: "or",
        sort: "title",
        group: "kind",
      },
    },
    "2026-10-11",
  );
  expect(result.results.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  expect(result.group(a)).toBe("任务");
});
