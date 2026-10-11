import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MobileStorage, type Connection, type WorkspaceChange } from "./index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
} from "./migration";
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const sql of [...initialStatements, ...captureStatements]) db.exec(sql);
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
    },
    async rollbackTransaction() {
      db.exec("ROLLBACK");
    },
  };
  return {
    db,
    connection,
    storage: new MobileStorage(async () => connection),
    upgrade() {
      for (const sql of workspaceStatements) db.exec(sql);
    },
  };
}
const occurredAt = "2026-10-11T12:00:00.000Z";
const change = (
  kind: WorkspaceChange["kind"],
  data: Record<string, unknown>,
): WorkspaceChange => ({
  id: crypto.randomUUID(),
  kind,
  expectedVersion: null,
  data,
});
it("upgrades old tasks and original captures without losing either source", async () => {
  const { db, storage, upgrade } = setup();
  try {
    await storage.capture({
      operationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      planId: crypto.randomUUID(),
      title: "旧任务",
      executionDate: "2026-10-11",
      timeZone: "UTC",
      occurredAt,
    });
    await storage.saveCapture({
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      expectedVersion: null,
      rawText: " 原文\n保留 ",
      occurredAt,
    });
    upgrade();
    const s = await storage.workspaceSnapshot();
    expect(s.entities.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["capture", "task"]),
    );
    expect(s.entities.find((e) => e.kind === "capture")?.data.rawText).toBe(
      " 原文\n保留 ",
    );
    expect(await storage.listCaptures()).toHaveLength(1);
  } finally {
    db.close();
  }
});
it("commits graph atomically, clears completed next actions, rejects stale writes and replays safely", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const p = change("project", { title: "项目", status: "active" });
    const t = change("task", {
      title: "任务",
      status: "todo",
      projectId: p.id,
    });
    p.data.nextActionId = t.id;
    const command = {
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [p, t],
    };
    await storage.workspaceCommand(command);
    await storage.workspaceCommand(command);
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(1);
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [
        { ...t, expectedVersion: 1, data: { ...t.data, status: "completed" } },
      ],
    });
    const s = await storage.workspaceSnapshot();
    expect(s.entities.find((e) => e.id === p.id)?.data.nextActionId).toBeNull();
    expect(s.entities.find((e) => e.id === t.id)?.data.completedAt).toBe(
      occurredAt,
    );
    await expect(
      storage.workspaceCommand({
        ...command,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("已变更");
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(2);
  } finally {
    db.close();
  }
});
it("rejects parent cycles and duplicate habit checks without partial writes", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const p = change("project", { title: "项目", status: "active" });
    const t = change("task", { title: "父", status: "todo", projectId: p.id });
    const c = change("task", { title: "子", status: "todo", parentId: t.id });
    c.data.parentId = c.id;
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [p, t, c],
      }),
    ).rejects.toThrow("同一项目");
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
    const h = change("habit", { title: "喝水" });
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [
          h,
          change("habit_check", { habitId: h.id, date: "2026-10-11" }),
          change("habit_check", { habitId: h.id, date: "2026-10-11" }),
        ],
      }),
    ).rejects.toThrow("每天只能");
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("imports into a separate switchable workspace and rejects damaged references atomically", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const t = change("task", { title: "保存的数据", status: "todo" });
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [t],
    });
    const json = await storage.workspaceExport();
    const op = crypto.randomUUID();
    await storage.workspaceImport(json, op);
    expect(await storage.workspaceList()).toHaveLength(2);
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [
        {
          ...t,
          expectedVersion: 1,
          data: { title: "副本修改", status: "todo" },
        },
      ],
    });
    await storage.workspaceSwitch("local");
    expect((await storage.workspaceSnapshot()).entities[0]?.data.title).toBe(
      "保存的数据",
    );
    const bad = JSON.parse(json);
    bad.entities[0].data.projectId = crypto.randomUUID();
    await expect(
      storage.workspaceImport(JSON.stringify(bad), crypto.randomUUID()),
    ).rejects.toThrow("不存在");
    expect(await storage.workspaceList()).toHaveLength(2);
  } finally {
    db.close();
  }
});
it("rolls entity writes back when the operation log fails and can retry the same command", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    db.exec(
      "CREATE TRIGGER fail_operation BEFORE INSERT ON mobile_operations BEGIN SELECT RAISE(ABORT,'disk simulation'); END",
    );
    const command = {
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [change("task", { title: "重试", status: "todo" })],
    };
    await expect(storage.workspaceCommand(command)).rejects.toThrow(
      "disk simulation",
    );
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
    db.exec("DROP TRIGGER fail_operation");
    await storage.workspaceCommand(command);
    await storage.workspaceCommand(command);
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(1);
  } finally {
    db.close();
  }
});

it("restores a deleted project with its tasks and rejects premature parent completion", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const p = change("project", { title: "工程", status: "active" });
    const parent = change("task", {
      title: "父",
      status: "todo",
      projectId: p.id,
    });
    const child = change("task", {
      title: "子",
      status: "todo",
      projectId: p.id,
      parentId: parent.id,
    });
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [p, parent, child],
    });
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [
          {
            ...parent,
            expectedVersion: 1,
            data: { ...parent.data, status: "completed" },
          },
        ],
      }),
    ).rejects.toThrow("先完成");
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [{ ...p, expectedVersion: 1, deleted: true }],
    });
    expect(
      (await storage.workspaceSnapshot()).entities.every((e) => e.deleted),
    ).toBe(true);
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [{ ...p, expectedVersion: 2, deleted: false }],
    });
    expect(
      (await storage.workspaceSnapshot()).entities.every((e) => !e.deleted),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it("keeps committed writes idempotent after a lost commit response", async () => {
  const { db, connection, storage, upgrade } = setup();
  upgrade();
  try {
    const commit = connection.commitTransaction;
    let fail = true;
    connection.commitTransaction = async () => {
      await commit();
      if (fail) {
        fail = false;
        throw new Error("response lost");
      }
    };
    const c = {
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [change("capture", { rawText: "可靠原文" })],
    };
    await expect(storage.workspaceCommand(c)).rejects.toThrow("response lost");
    await storage.workspaceCommand(c);
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(1);
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(1);
  } finally {
    db.close();
  }
});

it("keeps operation history through import and validates a capture clarification as one graph", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const capture = change("capture", { rawText: "项目想法" });
    const task = change("task", {
      title: "执行",
      status: "todo",
      sourceCaptureId: capture.id,
    });
    capture.data.outputs = [{ id: task.id, kind: "task", version: 1 }];
    capture.data.status = "clarified";
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [capture, task],
    });
    const original = JSON.parse(await storage.workspaceExport());
    expect(original.history).toHaveLength(1);
    await storage.workspaceImport(
      JSON.stringify(original),
      crypto.randomUUID(),
    );
    const exported = JSON.parse(await storage.workspaceExport());
    expect(exported.history).toHaveLength(2);
    expect(exported.history[0].payload).toBeTruthy();
    const invalid = change("capture", {
      rawText: "不正确引用",
      outputs: [{ id: task.id, kind: "task", version: 1 }],
    });
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [invalid],
      }),
    ).rejects.toThrow("澄清输出");
  } finally {
    db.close();
  }
});

it("protects effective rules, rejects unavailable next actions and duplicate repeated instances", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const p = change("project", { title: "项目", status: "active" });
    const t = change("task", {
      title: "等待",
      status: "todo",
      waiting: true,
      projectId: p.id,
    });
    p.data.nextActionId = t.id;
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [p, t],
      }),
    ).rejects.toThrow("下一步");
    const r = change("recurrence", {
      title: "例行",
      frequency: "daily",
      ruleHistory: [{ effectiveDate: "2026-10-10", frequency: "daily" }],
    });
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt,
      changes: [r],
    });
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [
          {
            ...r,
            expectedVersion: 1,
            data: {
              ...r.data,
              ruleHistory: [
                { effectiveDate: "2026-10-10", frequency: "weekly" },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow("历史规则不能");
    const data = {
      title: "实例",
      status: "todo",
      recurrenceId: r.id,
      originalDate: "2026-10-11",
    };
    await expect(
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes: [change("task", data), change("task", data)],
      }),
    ).rejects.toThrow("已经生成");
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(1);
  } finally {
    db.close();
  }
});

it("enforces terminal state graph and separate archive state across reopening", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const p = change("project", { title: "项目", status: "completed" });
    const parent = change("task", {
      title: "父",
      status: "completed",
      projectId: p.id,
    });
    const child = change("task", {
      title: "子",
      status: "completed",
      projectId: p.id,
      parentId: parent.id,
    });
    const run = (changes: WorkspaceChange[]) =>
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes,
      });
    await run([p, parent, child]);
    await expect(
      run([
        {
          ...child,
          expectedVersion: 1,
          data: { ...child.data, status: "todo" },
        },
      ]),
    ).rejects.toThrow("重新打开");
    await expect(
      run([
        {
          ...p,
          expectedVersion: 1,
          data: { ...p.data, status: "active", archivedAt: occurredAt },
        },
      ]),
    ).rejects.toThrow("可以归档");
    await run([
      { ...p, expectedVersion: 1, data: { ...p.data, archivedAt: occurredAt } },
    ]);
    expect(
      (await storage.workspaceSnapshot()).entities.find((e) => e.id === p.id)
        ?.data.status,
    ).toBe("completed");
    await run([
      {
        ...p,
        expectedVersion: 2,
        data: { ...p.data, status: "active", archivedAt: null },
      },
      {
        ...parent,
        expectedVersion: 1,
        data: { ...parent.data, status: "todo" },
      },
      { ...child, expectedVersion: 1, data: { ...child.data, status: "todo" } },
    ]);
    await expect(
      run([
        {
          ...parent,
          expectedVersion: 2,
          data: { ...parent.data, status: "cancelled" },
        },
      ]),
    ).rejects.toThrow("全部子任务");
    await expect(
      run([
        { ...p, expectedVersion: 3, data: { ...p.data, status: "cancelled" } },
      ]),
    ).rejects.toThrow("项目中的任务");
  } finally {
    db.close();
  }
});

it("moves children atomically with parent placement and ignores independent child placement", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const a = change("project", { title: "甲", status: "active" }),
      b = change("project", { title: "乙", status: "active" });
    const s = change("section", { title: "分区", projectId: b.id });
    const parent = change("task", {
      title: "父",
      status: "todo",
      projectId: a.id,
    });
    const child = change("task", {
      title: "子",
      status: "todo",
      projectId: a.id,
      parentId: parent.id,
    });
    const run = (changes: WorkspaceChange[]) =>
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes,
      });
    await run([a, b, s, parent, child]);
    await run([
      {
        ...parent,
        expectedVersion: 1,
        data: { ...parent.data, projectId: b.id, sectionId: s.id },
      },
    ]);
    let c = (await storage.workspaceSnapshot()).entities.find(
      (e) => e.id === child.id,
    )!;
    expect(c.data.projectId).toBe(b.id);
    expect(c.data.sectionId).toBe(s.id);
    expect(c.version).toBe(2);
    await run([
      {
        ...child,
        expectedVersion: 2,
        data: { ...c.data, projectId: a.id, sectionId: null },
      },
    ]);
    c = (await storage.workspaceSnapshot()).entities.find(
      (e) => e.id === child.id,
    )!;
    expect(c.data.projectId).toBe(b.id);
    expect(c.data.sectionId).toBe(s.id);
  } finally {
    db.close();
  }
});

it("protects effective history at Hong Kong midnight and allows future edits in negative time zones", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const hk = change("habit", {
      title: "香港",
      ruleHistory: [
        {
          effectiveDate: "2026-10-12",
          frequency: "daily",
          timeZone: "Asia/Hong_Kong",
        },
      ],
    });
    const la = change("habit", {
      title: "洛杉矶",
      ruleHistory: [
        {
          effectiveDate: "2026-10-12",
          frequency: "daily",
          timeZone: "America/Los_Angeles",
        },
      ],
    });
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: "2026-10-11T12:00:00.000Z",
      changes: [hk, la],
    });
    const edit = (e: WorkspaceChange, at: string) =>
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt: at,
        changes: [
          {
            ...e,
            expectedVersion: 1,
            data: {
              ...e.data,
              ruleHistory: [
                {
                  ...(e.data.ruleHistory as Record<string, unknown>[])[0],
                  frequency: "weekly",
                },
              ],
            },
          },
        ],
      });
    await expect(edit(hk, "2026-10-11T17:00:00.000Z")).rejects.toThrow(
      "历史规则不能",
    );
    await expect(edit(la, "2026-10-12T01:00:00.000Z")).resolves.toBeTruthy();
  } finally {
    db.close();
  }
});

it("refuses destructive clarification undo after a child is added without changing the parent version", async () => {
  const { db, storage, upgrade } = setup();
  upgrade();
  try {
    const cap = change("capture", { rawText: "原始想法", status: "clarified" });
    const task = change("task", {
      title: "输出任务",
      status: "todo",
      sourceCaptureId: cap.id,
    });
    cap.data.outputs = [{ id: task.id, kind: "task", version: 1 }];
    const run = (changes: WorkspaceChange[]) =>
      storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt,
        changes,
      });
    await run([cap, task]);
    const child = change("task", {
      title: "后续子任务",
      status: "todo",
      parentId: task.id,
    });
    await run([child]);
    expect(
      (await storage.workspaceSnapshot()).entities.find((e) => e.id === task.id)
        ?.version,
    ).toBe(1);
    const restore = {
      ...cap,
      expectedVersion: 1,
      data: {
        rawText: cap.data.rawText,
        status: "inbox",
        lastOutputs: cap.data.outputs,
      },
    };
    await expect(
      run([restore, { ...task, expectedVersion: 1, deleted: true }]),
    ).rejects.toThrow("后续关联");
    expect(
      (await storage.workspaceSnapshot()).entities.every((e) => !e.deleted),
    ).toBe(true);
    await run([restore]);
    expect(
      (await storage.workspaceSnapshot()).entities.find(
        (e) => e.id === child.id,
      )?.deleted,
    ).toBe(false);
  } finally {
    db.close();
  }
});
