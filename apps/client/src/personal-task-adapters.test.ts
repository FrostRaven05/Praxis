import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  personalTaskQuery,
  PersonalTaskRejectedError,
  type WorkSnapshot,
} from "@praxis/application";
import {
  MobileStorage,
  mobilePersonalTaskFields,
  mobilePersonalWork,
  type Connection,
} from "@praxis/storage-mobile";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "../../../packages/storage-mobile/src/migration";
import {
  createDesktopPersonalTasks,
  createMobilePersonalTasks,
} from "./personal-task-adapters";
import fixture from "../../../docs/p0/personal-compatibility-fixtures.json";
const clock = () => new Date(fixture.clock.now);
const id = () => crypto.randomUUID();
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of [
    ...initialStatements,
    ...captureStatements,
    ...workspaceStatements,
    ...lanStatements,
    ...entitySyncStatements,
  ])
    db.exec(sql);
  let lose = false,
    scope = "account-a";
  const connection: Connection = {
    async query(sql, values = []) {
      return {
        values: db.prepare(sql).all(...(values as (string | number | null)[])),
      };
    },
    async run(sql, values = []) {
      db.prepare(sql).run(...(values as (string | number | null)[]));
    },
    async beginTransaction() {
      db.exec("BEGIN");
    },
    async commitTransaction() {
      db.exec("COMMIT");
      if (lose) {
        lose = false;
        throw Error("lost commit response");
      }
    },
    async rollbackTransaction() {
      db.exec("ROLLBACK");
    },
  };
  const storage = new MobileStorage(async () => connection);
  const manager = createMobilePersonalTasks(
    {
      workspaceSnapshot: () => storage.workspaceSnapshot(),
      workspaceList: () => storage.workspaceList(),
      workspaceCommand: (c) => storage.workspaceCommand(c),
      scope: async () => scope,
      fallbackZone: () => fixture.clock.timeZone,
    },
    clock,
  );
  return {
    db,
    storage,
    manager,
    lose: () => (lose = true),
    scope: (value: string) => (scope = value),
  };
}
const change = (
  id: string,
  kind: "project" | "task",
  data: Record<string, unknown>,
) => ({ id, kind, data, expectedVersion: null });
async function seed(f: ReturnType<typeof setup>) {
  await f.storage.workspaceCommand({
    operationId: id(),
    occurredAt: fixture.clock.now,
    changes: [
      change(fixture.project.id, "project", {
        title: fixture.project.name,
        status: "active",
        dueDate: fixture.project.targetDate,
      }),
      change(fixture.secondProjectId, "project", {
        title: "第二个项目",
        status: "active",
      }),
      change(fixture.independent.id, "task", {
        title: fixture.independent.title,
        status: "todo",
        waiting: true,
        waitingReason: "旧等待",
        projectId: null,
        notes: fixture.independent.notes,
        completionCriteria: fixture.independent.criteria,
        executionDate: "2026-11-08",
        dueDate: "2026-11-10",
        desktop: {
          deadline_value: JSON.stringify(fixture.independent.deadline),
          deadline: fixture.independent.deadline.atUtc,
          deadline_time_zone: fixture.independent.deadline.displayTimezone,
          unknown: "保留扩展",
        },
        unknown: { keep: true },
      }),
      change(fixture.unknownCompletion.id, "task", {
        title: fixture.unknownCompletion.title,
        status: "completed",
      }),
    ],
  });
  f.db
    .prepare(
      "UPDATE mobile_entities SET data=json_set(data,'$.completedAt',NULL) WHERE id=?",
    )
    .run(fixture.unknownCompletion.id);
}
describe("personal task adapters", () => {
  it("explicitly exits an old Todo+waiting state and restores that exact old flag on undo", async () => {
    const f = setup();
    try {
      await seed(f);
      const taskId = fixture.independent.id;
      const receipt = await f.manager.change(await f.manager.read(), taskId, {
        type: "status",
        status: "todo",
      });
      expect((await f.manager.read()).query.task(taskId)).toMatchObject({
        status: "todo",
        waiting: false,
      });
      await f.manager.change(await f.manager.read(), taskId, {
        type: "undoStatus",
        operationId: receipt.operationId,
      });
      expect((await f.manager.read()).query.task(taskId)).toMatchObject({
        status: "waiting",
        rawStatus: "todo",
        waiting: true,
      });
    } finally {
      f.db.close();
    }
  });
  it("soft-deletes and restores a leaf through the original workspace receipt without changing its content or dates", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read(),
        taskId = fixture.independent.id;
      const original = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === taskId,
      )!;
      f.lose();
      await expect(
        f.manager.change(base, taskId, { type: "delete" }),
      ).rejects.toThrow();
      await f.manager.change(base, taskId, { type: "delete" });
      const deleted = await f.manager.read();
      expect(deleted.query.task(taskId)).toBeNull();
      expect(deleted.trash?.find((t) => t.id === taskId)).toMatchObject({
        version: original.version + 1,
      });
      await f.manager.change(deleted, taskId, { type: "restore" });
      const restored = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === taskId,
      )!;
      expect(restored.deleted).toBe(false);
      expect(restored.version).toBe(original.version + 2);
      expect(restored.data).toMatchObject(original.data);
    } finally {
      f.db.close();
    }
  });
  it("undoes reopening an unknown historical completion without inventing today's completion fact", async () => {
    const f = setup();
    try {
      await seed(f);
      const taskId = fixture.unknownCompletion.id;
      const receipt = await f.manager.change(await f.manager.read(), taskId, {
        type: "status",
        status: "todo",
      });
      await f.manager.change(await f.manager.read(), taskId, {
        type: "undoStatus",
        operationId: receipt.operationId,
      });
      const task = (await f.manager.read()).query.task(taskId)!;
      expect(task.status).toBe("completed");
      expect(task.completedAt).toBeNull();
    } finally {
      f.db.close();
    }
  });
  it("rejects a stale undo even after rereading and preserves the newer note", async () => {
    const f = setup();
    try {
      await seed(f);
      const taskId = fixture.independent.id;
      const receipt = await f.manager.change(await f.manager.read(), taskId, {
        type: "status",
        status: "in_progress",
      });
      const after = await f.manager.read();
      await f.manager.change(after, taskId, {
        type: "edit",
        notes: "后续新编辑",
      });
      await expect(
        f.manager.change(after, taskId, {
          type: "undoStatus",
          operationId: receipt.operationId,
        }),
      ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
      await expect(
        f.manager.change(await f.manager.read(), taskId, {
          type: "undoStatus",
          operationId: receipt.operationId,
        }),
      ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
      expect((await f.manager.read()).query.task(taskId)).toMatchObject({
        notes: "后续新编辑",
        status: "in_progress",
      });
    } finally {
      f.db.close();
    }
  });
  it("does not silently delete a legacy parent or restore changed deleted contents", async () => {
    const f = setup();
    try {
      await seed(f);
      const parent = id(),
        child = id();
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          change(parent, "task", { title: "旧父任务", status: "todo" }),
          change(child, "task", {
            title: "旧子任务",
            status: "todo",
            parentId: parent,
          }),
        ],
      });
      await expect(
        f.manager.change(await f.manager.read(), parent, { type: "delete" }),
      ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
      await f.manager.change(await f.manager.read(), fixture.independent.id, {
        type: "delete",
      });
      const deleted = await f.manager.read();
      const entity = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === fixture.independent.id,
      )!;
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          {
            id: entity.id,
            kind: "task",
            expectedVersion: entity.version,
            data: { ...entity.data, notes: "删除后同步的新内容" },
            deleted: true,
          },
        ],
      });
      await expect(
        f.manager.change(deleted, entity.id, { type: "restore" }),
      ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
      expect(
        (await f.storage.workspaceSnapshot()).entities.find(
          (e) => e.id === entity.id,
        )?.data.notes,
      ).toBe("删除后同步的新内容");
    } finally {
      f.db.close();
    }
  });
  it("freezes native creation fields and retains an unknown receipt across account switches before safely retrying", async () => {
    let scope = "a",
      lose = true;
    const sent: unknown[] = [];
    const work: WorkSnapshot = {
      settings: [{ timeZone: "Asia/Hong_Kong", version: 0 }],
      tasks: [],
      projects: [],
      sections: [],
      labels: [],
      days: [],
      legacyPlans: [],
      events: [],
      migrationReport: "",
    };
    const manager = createDesktopPersonalTasks(
      {
        scope: async () => scope,
        read: async () => work,
        send: async (c) => {
          sent.push(structuredClone(c));
          if (lose) {
            lose = false;
            throw Error("lost response");
          }
        },
      },
      clock,
    );
    const base = await manager.read(),
      deadline = { kind: "date" as const, date: "2026-11-12" };
    const draft = {
      taskId: id(),
      title: "原输入",
      notes: "说明",
      projectId: null,
      deadline,
    };
    await expect(manager.create(base, draft)).rejects.toThrow("lost response");
    scope = "b";
    try {
      await manager.create(base, draft);
      throw Error("expected account guard");
    } catch (error) {
      expect(error).not.toBeInstanceOf(PersonalTaskRejectedError);
      expect(String(error)).toContain("账号");
    }
    scope = "a";
    deadline.date = "2099-01-01";
    await manager.create(base, {
      ...draft,
      deadline: { kind: "date", date: "2026-11-12" },
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]).toMatchObject({
      action: {
        expectedVersion: null,
        projectId: null,
        plan: null,
        deadline: { kind: "date", date: "2026-11-12" },
        arrangeOnCreate: false,
      },
    });
    scope = "b";
    await expect(
      manager.create(base, { ...draft, taskId: id() }),
    ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
    expect(sent).toHaveLength(2);
  });
  it("creates unplanned independent/project tasks with stable receipts, optional notes/deadline and no duplicate on a lost commit response", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read();
      const draft = {
        taskId: id(),
        title: "  连续录入的项目任务  ",
        notes: "可选说明",
        deadline: { kind: "date" as const, date: "2026-11-12" },
        projectId: fixture.project.id,
      };
      f.lose();
      await expect(f.manager.create(base, draft)).rejects.toThrow();
      await expect(
        f.manager.create(base, { ...draft, title: "改变重试内容" }),
      ).rejects.toThrow("未确认");
      await f.manager.create(await f.manager.read(), draft);
      let snapshot = await f.storage.workspaceSnapshot();
      const created = snapshot.entities.find((e) => e.id === draft.taskId)!;
      expect(
        snapshot.entities.filter((e) => e.id === draft.taskId),
      ).toHaveLength(1);
      expect(created).toMatchObject({
        version: 1,
        data: {
          title: "连续录入的项目任务",
          notes: "可选说明",
          projectId: fixture.project.id,
          status: "todo",
          executionDate: null,
          dueDate: "2026-11-12",
        },
      });
      const independent = {
        ...draft,
        taskId: id(),
        title: "独立任务",
        projectId: null,
        notes: "",
        deadline: null,
      };
      await f.manager.create(await f.manager.read(), independent);
      snapshot = await f.storage.workspaceSnapshot();
      expect(
        snapshot.entities.find((e) => e.id === independent.taskId)?.data,
      ).toMatchObject({
        projectId: null,
        executionDate: null,
        dueDate: null,
        status: "todo",
      });
    } finally {
      f.db.close();
    }
  });
  it("rejects stale project creation inside the mobile transaction and guards account changes without dropping the draft", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read(),
        draft = {
          taskId: id(),
          title: "版本检查",
          notes: "输入保留",
          deadline: null,
          projectId: fixture.project.id,
        };
      const project = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === fixture.project.id,
      )!;
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          {
            id: project.id,
            kind: "project",
            expectedVersion: project.version,
            data: { ...project.data, status: "completed" },
          },
        ],
      });
      const before = await f.storage.workspaceSnapshot();
      await expect(f.manager.create(base, draft)).rejects.toBeInstanceOf(
        PersonalTaskRejectedError,
      );
      expect(await f.storage.workspaceSnapshot()).toEqual(before);
      f.scope("account-b");
      await expect(
        f.manager.create(base, { ...draft, projectId: null }),
      ).rejects.toBeInstanceOf(PersonalTaskRejectedError);
      expect(await f.storage.workspaceSnapshot()).toEqual(before);
    } finally {
      f.db.close();
    }
  });
  it("moves through all three states on the same task identity while keeping notes, extensions and typed deadlines", async () => {
    const f = setup();
    try {
      await seed(f);
      const taskId = fixture.independent.id;
      const before = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === taskId,
      )!;
      for (const status of ["in_progress", "completed", "todo"] as const)
        await f.manager.change(await f.manager.read(), taskId, {
          type: "status",
          status,
        });
      const after = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === taskId,
      )!;
      expect(after.version).toBe(before.version + 3);
      expect(after.data).toMatchObject({
        title: before.data.title,
        notes: before.data.notes,
        status: "todo",
        waiting: false,
      });
      expect(after.data.desktop).toEqual(before.data.desktop);
      expect((await f.manager.read()).query.task(taskId)?.deadline).toEqual(
        baseDeadline(before),
      );
    } finally {
      f.db.close();
    }
    function baseDeadline(
      entity: import("@praxis/storage-mobile").WorkspaceEntity,
    ) {
      return JSON.parse(
        (entity.data.desktop as Record<string, string>).deadline_value!,
      );
    }
  });
  it("checks project lifecycle changes inside the transaction and requires the existing confirmation path for closed ancestors", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read();
      const project = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === fixture.project.id,
      )!;
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          {
            id: project.id,
            kind: "project",
            expectedVersion: project.version,
            data: { ...project.data, status: "completed" },
          },
        ],
      });
      await expect(
        f.manager.change(base, fixture.independent.id, {
          type: "move",
          projectId: project.id,
        }),
      ).rejects.toThrow("项目已变更");
      const parentId = id(),
        childId = id();
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          change(parentId, "task", {
            title: "结束的旧父任务",
            status: "completed",
          }),
          change(childId, "task", {
            title: "结束的旧子任务",
            status: "completed",
            parentId,
          }),
        ],
      });
      const next = await f.manager.read();
      await expect(
        f.manager.change(next, childId, { type: "status", status: "todo" }),
      ).rejects.toThrow("确认重开父任务");
      expect((await f.manager.read()).query.task(childId)?.status).toBe(
        "completed",
      );
    } finally {
      f.db.close();
    }
  });
  it("moves a confirmed legacy subtree atomically, preserving task IDs, parents, and opaque fields", async () => {
    const f = setup();
    try {
      await seed(f);
      const rootId = id(),
        childId = id();
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          change(rootId, "task", {
            title: "旧行动包",
            status: "todo",
            projectId: fixture.project.id,
          }),
          change(childId, "task", {
            title: "旧子任务",
            status: "todo",
            projectId: fixture.project.id,
            parentId: rootId,
            unknown: "原内容",
          }),
        ],
      });
      const base = await f.manager.read();
      await expect(
        f.manager.change(base, rootId, {
          type: "move",
          projectId: fixture.secondProjectId,
        }),
      ).rejects.toThrow("全部子任务");
      await f.manager.change(base, rootId, {
        type: "move",
        projectId: fixture.secondProjectId,
        confirmDescendants: true,
      });
      const next = await f.manager.read();
      expect(
        next.query
          .list(fixture.secondProjectId)
          .map((t) => t.id)
          .sort(),
      ).toEqual([rootId, childId].sort());
      expect(next.query.task(childId)).toMatchObject({
        parentId: rootId,
        version: 2,
      });
      expect(
        (await f.storage.workspaceSnapshot()).entities.find(
          (e) => e.id === childId,
        )?.data.unknown,
      ).toBe("原内容");
    } finally {
      f.db.close();
    }
  });
  it("reads mobile identity/dates/status once and preserves unknown fields, dates and unknown completion on unrelated edits", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read();
      const t = base.query.task(fixture.independent.id)!;
      expect(t).toMatchObject({
        status: "waiting",
        rawStatus: "todo",
        deadline: fixture.independent.deadline,
        version: 1,
      });
      expect(base.query.groups.overdue[0]?.id).toBe(t.id);
      expect(base.query.list(null).find((row) => row.id === t.id)).toBe(t);
      await f.manager.change(base, t.id, { type: "edit", title: "修改标题" });
      const source = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === t.id,
      )!;
      expect(source.data).toMatchObject({
        title: "修改标题",
        unknown: { keep: true },
        desktop: {
          unknown: "保留扩展",
          deadline_value: JSON.stringify(fixture.independent.deadline),
        },
        waiting: true,
        executionDate: "2026-11-08",
      });
      const next = await f.manager.read();
      await f.manager.change(next, fixture.unknownCompletion.id, {
        type: "edit",
        notes: "仅补说明",
      });
      expect(
        (await f.manager.read()).query.task(fixture.unknownCompletion.id)
          ?.completedAt,
      ).toBeNull();
    } finally {
      f.db.close();
    }
  });
  it("freezes unknown-result retries, checks local versions and completes/reopens without copying the task", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read();
      const taskId = fixture.independent.id;
      f.lose();
      await expect(
        f.manager.change(base, taskId, { type: "status", status: "completed" }),
      ).rejects.toThrow("lost commit");
      await expect(
        f.manager.change(base, taskId, { type: "edit", title: "另一意图" }),
      ).rejects.toThrow("尚未确认");
      await f.manager.change(base, taskId, {
        type: "status",
        status: "completed",
      });
      let next = await f.manager.read();
      expect(next.query.task(taskId)).toMatchObject({
        version: 2,
        status: "completed",
        waiting: false,
        completedAt: clock().toISOString(),
      });
      expect(next.query.tasks.filter((t) => t.id === taskId)).toHaveLength(1);
      const rejected = await f.manager
        .change(base, taskId, { type: "edit", title: "过期覆盖" })
        .catch((error) => error);
      expect(rejected).toBeInstanceOf(PersonalTaskRejectedError);
      expect(rejected.message).toContain("已变更");
      await f.manager.change(next, taskId, { type: "status", status: "todo" });
      next = await f.manager.read();
      expect(next.query.task(taskId)?.completedAt).toBeNull();
      await f.manager.change(next, taskId, {
        type: "move",
        projectId: fixture.project.id,
      });
      next = await f.manager.read();
      await f.manager.change(next, taskId, {
        type: "move",
        projectId: fixture.secondProjectId,
      });
      next = await f.manager.read();
      expect(next.query.task(taskId)).toMatchObject({
        id: taskId,
        projectId: fixture.secondProjectId,
        version: 5,
      });
      expect(next.query.tasks.filter((t) => t.id === taskId)).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  it("guards the complete task preview in the transaction, rejects account switches, and accepts same-day explicit date changes", async () => {
    const f = setup();
    try {
      await seed(f);
      const base = await f.manager.read();
      await f.storage.workspaceCommand({
        operationId: id(),
        occurredAt: fixture.clock.now,
        changes: [
          change(id(), "task", { title: "预览后的新增", status: "todo" }),
        ],
      });
      await expect(
        f.manager.change(base, fixture.independent.id, {
          type: "move",
          projectId: fixture.project.id,
        }),
      ).rejects.toThrow("重新预览");
      const next = await f.manager.read();
      f.scope("account-b");
      await expect(
        f.manager.change(next, fixture.independent.id, {
          type: "edit",
          title: "跨账号",
        }),
      ).rejects.toThrow("账号");
      f.scope("account-a");
      await f.manager.change(next, fixture.independent.id, {
        type: "edit",
        deadline: { kind: "date", date: "2026-11-10" },
      });
      expect(
        (await f.manager.read()).query.task(fixture.independent.id)?.deadline,
      ).toEqual({ kind: "date", date: "2026-11-10" });
      const raw = (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === fixture.independent.id,
      )!;
      const cleared = mobilePersonalTaskFields(raw.data, { dueDate: null });
      expect(
        (cleared.desktop as Record<string, unknown>).deadline_value,
      ).toBeNull();
      expect(cleared.unknown).toEqual({ keep: true });
    } finally {
      f.db.close();
    }
  });
  it("uses native CAS and existing commands rather than wire versions and keeps unedited typed fields in a frozen retry", async () => {
    const work: WorkSnapshot = {
      settings: [{ timeZone: fixture.clock.timeZone, version: 0 }],
      tasks: [
        {
          id: fixture.independent.id,
          title: "原标题",
          notes: "原说明",
          projectId: null,
          parentId: null,
          sectionId: null,
          status: "waiting",
          rawStatus: "todo",
          waiting: true,
          version: 7,
          plan: { kind: "date", date: "2026-11-10" },
          deadline: { ...fixture.independent.deadline, kind: "instant" },
          followUp: null,
          priority: 4,
          important: 1,
          waitingFor: "反馈",
          waitingNote: "等待说明",
          completedAt: null,
          createdAt: fixture.clock.now,
          rank: 0,
          labels: ["legacy-label"],
        },
      ],
      projects: [],
      sections: [],
      labels: [],
      days: [],
      legacyPlans: [],
      events: [],
      migrationReport: "",
    };
    let scope = "account-a",
      lose = true;
    const sent: unknown[] = [];
    const manager = createDesktopPersonalTasks(
      {
        read: async () => structuredClone(work),
        scope: async () => scope,
        send: async (c) => {
          sent.push(c);
          if (lose) {
            lose = false;
            throw Error("lost native result");
          }
        },
      },
      clock,
    );
    const base = await manager.read();
    await expect(
      manager.change(base, fixture.independent.id, {
        type: "edit",
        title: "新标题",
      }),
    ).rejects.toThrow();
    await manager.change(base, fixture.independent.id, {
      type: "edit",
      title: "新标题",
    });
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]).toMatchObject({
      action: {
        type: "task",
        expectedVersion: 7,
        deadline: fixture.independent.deadline,
        plan: work.tasks[0]!.plan,
        waitingFor: "反馈",
        labels: ["legacy-label"],
      },
    });
    scope = "account-b";
    await expect(
      manager.change(base, fixture.independent.id, {
        type: "status",
        status: "completed",
      }),
    ).rejects.toThrow("账号");
    expect(sent).toHaveLength(2);
    const mobile = setup();
    try {
      await seed(mobile);
      const projected = mobilePersonalWork(
        await mobile.storage.workspaceSnapshot(),
        fixture.clock.timeZone,
      );
      expect(
        personalTaskQuery(projected, clock()).task(fixture.independent.id)
          ?.deadline,
      ).toEqual(base.query.task(fixture.independent.id)?.deadline);
    } finally {
      mobile.db.close();
    }
  });
});
