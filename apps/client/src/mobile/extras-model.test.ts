import { describe, it, expect } from "vitest";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  emptyFilter,
  searchEntities,
  projectEvidence,
  historySummary,
} from "./extras-model";
const item = (
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
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
});
describe("mobile extras projections", () => {
  it("combines priority and deadline with AND/OR without including trash or archived projects", () => {
    const entities = [
      item("p", "project", {
        title: "存档",
        status: "completed",
        archivedAt: "2026-10-10T00:00:00Z",
      }),
      item("a", "task", {
        title: "A",
        priority: 3,
        dueDate: "2026-10-11",
        status: "todo",
      }),
      item("b", "task", {
        title: "B",
        priority: 1,
        dueDate: "2026-10-12",
        status: "todo",
      }),
      item("c", "task", {
        title: "C",
        priority: 3,
        projectId: "p",
        status: "todo",
      }),
      item("d", "task", { title: "D", priority: 3, status: "todo" }, true),
    ];
    expect(
      searchEntities(
        entities,
        { ...emptyFilter, priority: "3", due: "today" },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["a"]);
    expect(
      searchEntities(
        entities,
        {
          ...emptyFilter,
          priority: "1",
          due: "today",
          mode: "or",
          sort: "title",
        },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["a", "b"]);
  });
  it("presets filter real waiting evidence and unplanned independent tasks", () => {
    const entities = [
      item("a", "task", {
        title: "A",
        status: "todo",
        waiting: true,
        waitingFor: "客户",
      }),
      item("b", "task", {
        title: "B",
        status: "completed",
        waiting: true,
        waitingFor: "客户",
      }),
      item("c", "task", {
        title: "C",
        status: "todo",
        executionDate: "2026-10-11",
      }),
    ];
    expect(
      searchEntities(
        entities,
        { ...emptyFilter, preset: "waiting" },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["a"]);
    expect(
      searchEntities(
        entities,
        { ...emptyFilter, preset: "unplanned" },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["a"]);
  });
  it("checks project progress using completed task or record evidence, not project maintenance timestamps", () => {
    const p = item("p", "project", {
        title: "项目",
        status: "active",
        reviewDate: "2026-10-10",
      }),
      t = item("t", "task", {
        title: "等待",
        status: "todo",
        projectId: "p",
        dueDate: "2026-10-01",
        waiting: true,
        waitingReason: "外部确认",
      });
    expect(projectEvidence(p, [p, t], "2026-10-11")).toMatchObject({
      stagnant: true,
      missingNext: true,
      waiting: 1,
      overdue: 1,
      reviewDue: true,
    });
    expect(
      projectEvidence(
        p,
        [p, t, item("r", "record", { title: "推进", projectId: "p" })],
        "2026-10-11",
      ).stagnant,
    ).toBe(false);
  });
  it("sorts P1 first and uses only P1/P2 for focused work", () => {
    const entities = [0, 3, 1, 2].map((n) =>
      item(String(n), "task", {
        title: String(n),
        status: "todo",
        priority: n,
      }),
    );
    expect(
      searchEntities(
        entities,
        { ...emptyFilter, sort: "priority" },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["1", "2", "3", "0"]);
    expect(
      searchEntities(
        entities,
        { ...emptyFilter, preset: "focus", sort: "priority" },
        "2026-10-11",
      ).map((e) => e.id),
    ).toEqual(["1", "2"]);
  });
  it("excludes cleared waiting flags despite preserved explanatory fields", () => {
    const p = item("p", "project", { title: "项目", status: "active" });
    const t = item("t", "task", {
      title: "已解除等待",
      status: "todo",
      projectId: "p",
      waiting: false,
      waitingFor: "客户",
      waitingReason: "保留说明",
    });
    expect(
      searchEntities(
        [p, t],
        { ...emptyFilter, preset: "waiting" },
        "2026-10-11",
      ),
    ).toEqual([]);
    expect(projectEvidence(p, [p, t], "2026-10-11").waiting).toBe(0);
  });
  it("renders friendly history labels without serializing bodies or keys", () => {
    expect(
      historySummary(
        JSON.stringify({
          changes: [
            {
              kind: "record",
              expectedVersion: null,
              data: { title: "周记", body: "private content" },
            },
          ],
        }),
      ),
    ).toEqual(["创建 记录：周记"]);
    expect(historySummary("invalid")).toEqual(["本机历史记录"]);
  });
});
