import { mobileAiLaunch } from "./ai-context-mobile";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MobileStorage,
  aiRecoveryReadSet,
  type Connection,
  type WorkspaceCommand,
  type WorkspaceEntity,
} from "@praxis/storage-mobile";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "../../../packages/storage-mobile/src/migration";
import { validateGraph as validateApiGraph } from "../../api/src/entity-validation";
import type { AiApplyCommand } from "../../api/src/ai-contract";
import {
  buildMobileAiApply,
  buildMobileAiUndo,
  createMobileAiAdapter,
  mobileAiReceipt,
  type AiMobilePort,
} from "./ai-mobile-adapter";

const databases: DatabaseSync[] = [];
it("applies the personal flat task notes/date once and keeps its original receipt",async()=>{
  const f=setup(),c=command();c.tasks=c.tasks.map(t=>({...t,dependsOn:[],estimatedMinutes:null,notes:"个人说明",deadline:"2026-12-01"}));c.reward=null;
  const result=await f.adapter.apply(c);const replay=await f.adapter.apply(c);expect(replay.operationId).toBe(result.operationId);
  const rows=(await f.storage.workspaceSnapshot()).entities.filter(e=>e.kind==="task");expect(rows).toHaveLength(c.tasks.length);
  expect(rows[0]?.data).toMatchObject({notes:"个人说明",dueDate:"2026-12-01",status:"todo",parentId:null});
});
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const sql of [
    ...initialStatements,
    ...captureStatements,
    ...workspaceStatements,
    ...lanStatements,
    ...entitySyncStatements,
  ])
    db.exec(sql);
  const connection: Connection = {
    async query(sql, values = []) {
      return {
        values: db
          .prepare(sql)
          .all(...(values as (string | number | null)[])) as Record<
          string,
          unknown
        >[],
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
  const storage = new MobileStorage(async () => connection);
  const cacheData = new Map<string, string>();
  const cache = {
    getItem: (k: string) => cacheData.get(k) ?? null,
    setItem: (k: string, v: string) => {
      cacheData.set(k, v);
    },
    removeItem: (k: string) => {
      cacheData.delete(k);
    },
  };
  const scope = {
    key: "account-a|server-a|database-a|local",
    workspaceId: "local",
  };
  const port: AiMobilePort = {
    snapshot: () => storage.workspaceSnapshot(),
    commit: (c) => storage.workspaceCommand(c),
    scope: async () => scope,
    cache,
  };
  return {
    db,
    storage,
    cacheData,
    scope,
    port,
    adapter: createMobileAiAdapter(port),
  };
}
function command(
  project?: WorkspaceEntity,
  basis: WorkspaceEntity[] = [],
): AiApplyCommand {
  return {
    operationId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    input: "完成摄影作品集",
    source: null,
    project: project
      ? {
          id: project.id,
          version: project.version,
          planVersion: Number(project.data.planVersion ?? 0),
        }
      : null,
    newProject: project
      ? null
      : {
          id: crypto.randomUUID(),
          name: "摄影作品集",
          outcome: "发布第一组作品",
        },
    basisTasks: basis.map((t) => ({ id: t.id, version: t.version })),
    tasks: [
      {
        id: crypto.randomUUID(),
        key: "s1",
        title: "选片",
        criteria: "选出十张照片",
        estimatedMinutes: 15,
        dependsOn: [],
      },
      {
        id: crypto.randomUUID(),
        key: "s2",
        title: "排版",
        criteria: "形成第一版页面",
        estimatedMinutes: null,
        dependsOn: ["s1"],
      },
    ],
    reward: { title: "摄影出游", condition: "发布第一组作品" },
  };
}
const at = "2026-10-25T10:00:00.000Z";
async function seedProject(storage: MobileStorage) {
  const projectId = crypto.randomUUID(),
    taskId = crypto.randomUUID();
  await storage.workspaceCommand({
    operationId: crypto.randomUUID(),
    occurredAt: at,
    changes: [
      {
        id: projectId,
        kind: "project",
        expectedVersion: null,
        data: { title: "已有项目", status: "active", planVersion: 0 },
      },
      {
        id: taskId,
        kind: "task",
        expectedVersion: null,
        data: { title: "已有任务", status: "todo", projectId },
      },
    ],
  });
  const snapshot = await storage.workspaceSnapshot();
  return {
    project: snapshot.entities.find((e) => e.id === projectId)!,
    task: snapshot.entities.find((e) => e.id === taskId)!,
  };
}
describe("mobile AI atomic adoption", () => {
  it("adopts editable steps, canonical dependencies, original text and reward in one SQLite transaction, then undoes safely", async () => {
    const { storage, adapter } = setup();
    const input = command();
    const receipt = await adapter.apply(input);
    const snapshot = await storage.workspaceSnapshot();
    expect(receipt.taskIds).toEqual(input.tasks.map((t) => t.id));
    expect(snapshot.pendingOperations).toBe(1);
    expect(
      snapshot.entities.find((e) => e.id === receipt.sourceCaptureId)?.data
        .rawText,
    ).toBe(input.input);
    expect(
      snapshot.entities
        .filter((e) => e.kind === "task")
        .every((e) => !e.data.executionDate),
    ).toBe(true);
    const edges = snapshot.entities.filter((e) => e.kind === "desktop_row");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.data).toEqual({
      table: "task_dependencies",
      row: { task_id: input.tasks[1]!.id, predecessor_id: input.tasks[0]!.id },
    });
    expect(snapshot.entities.filter((e) => e.kind === "record")).toHaveLength(
      1,
    );
    validateApiGraph(snapshot.entities);
    expect(await adapter.apply(input)).toEqual(receipt);
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(1);
    await adapter.undo(crypto.randomUUID(), input.operationId);
    const undone = await storage.workspaceSnapshot();
    expect(mobileAiReceipt(undone, input.operationId)?.undone).toBe(true);
    expect(
      undone.entities
        .filter(
          (e) =>
            e.kind === "task" ||
            e.kind === "record" ||
            e.kind === "desktop_row",
        )
        .every((e) => e.deleted),
    ).toBe(true);
    expect(undone.entities.find((e) => e.kind === "capture")?.data.status).toBe(
      "inbox",
    );
    expect(undone.entities.find((e) => e.kind === "project")?.deleted).toBe(
      false,
    );
    expect((await adapter.apply(input)).undone).toBe(true);
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(2);
    validateApiGraph(undone.entities);
  });
  it.each(["addition", "modification", "deletion"] as const)(
    "rejects a concurrent task %s inside the actual transaction without partial output",
    async (kind) => {
      const { storage } = setup();
      const { project, task } = await seedProject(storage);
      const input = command(project, [task]);
      const before = await storage.workspaceSnapshot();
      const built = buildMobileAiApply(before, input, "local", at);
      await storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt: at,
        changes: [
          kind === "addition"
            ? {
                id: crypto.randomUUID(),
                kind: "task",
                expectedVersion: null,
                data: {
                  title: "插入的新任务",
                  status: "todo",
                  projectId: project.id,
                },
              }
            : {
                id: task.id,
                kind: "task",
                expectedVersion: task.version,
                data: { ...task.data, notes: "已有变更" },
                ...(kind === "deletion" ? { deleted: true } : {}),
              },
        ],
      });
      await expect(storage.workspaceCommand(built.workspace)).rejects.toThrow(
        "AI_STALE_PROJECT",
      );
      const after = await storage.workspaceSnapshot();
      expect(
        after.entities.some((e) => input.tasks.some((t) => t.id === e.id)),
      ).toBe(false);
      expect(after.entities.some((e) => e.id === input.operationId)).toBe(
        false,
      );
      expect(after.entities.find((e) => e.id === project.id)!.version).toBe(
        project.version,
      );
    },
  );
  it("keeps unchanged basis revisions and rejects two different batches for the same run atomically", async () => {
    const { storage } = setup();
    const { project, task } = await seedProject(storage);
    const snapshot = await storage.workspaceSnapshot();
    const first = command(project, [task]);
    const second = { ...command(project, [task]), runId: first.runId };
    const a = buildMobileAiApply(snapshot, first, "local", at);
    const b = buildMobileAiApply(snapshot, second, "local", at);
    await storage.workspaceCommand(a.workspace);
    await expect(storage.workspaceCommand(b.workspace)).rejects.toThrow(
      "AI_ALREADY_APPLIED",
    );
    expect(
      (await storage.workspaceSnapshot()).entities.find(
        (e) => e.id === task.id,
      )!.version,
    ).toBe(task.version);
  });
  it("reuses complete cached changes, generated IDs and occurredAt after interruption before commit", async () => {
    const { storage, port } = setup();
    const input = command();
    const calls: WorkspaceCommand[] = [];
    let fail = true;
    const unstable: AiMobilePort = {
      ...port,
      commit: async (c) => {
        calls.push(c);
        if (fail) {
          fail = false;
          throw Error("connection lost");
        }
        return storage.workspaceCommand(c);
      },
    };
    await expect(createMobileAiAdapter(unstable).apply(input)).rejects.toThrow(
      "AI_APPLY_UNCONFIRMED",
    );
    await createMobileAiAdapter(unstable).apply(input);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]!.occurredAt).toBeTruthy();
    expect((await storage.workspaceSnapshot()).pendingOperations).toBe(1);
  });
  it("resumes an Inbox undo after restart with the original operation, changes and occurrence time", async () => {
    const { storage, adapter, port } = setup();
    const input = command();
    await adapter.apply(input);
    const calls: WorkspaceCommand[] = [];
    let interrupted = true;
    const unstable: AiMobilePort = {
      ...port,
      commit: async (c) => {
        calls.push(c);
        if (interrupted) {
          interrupted = false;
          throw Error("connection lost");
        }
        return storage.workspaceCommand(c);
      },
    };
    await expect(
      createMobileAiAdapter(unstable).undoSavedApplication(input.operationId),
    ).rejects.toThrow("AI_APPLY_UNCONFIRMED");
    await createMobileAiAdapter(unstable).undoSavedApplication(
      input.operationId,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect((await adapter.receipt(input.operationId))?.undone).toBe(true);
  });
  it("recovers a receipt after commit but before the response and never repeats the write", async () => {
    const { storage, port } = setup();
    const input = command();
    let calls = 0;
    const unstable: AiMobilePort = {
      ...port,
      commit: async (c) => {
        calls++;
        await storage.workspaceCommand(c);
        throw Error("response lost");
      },
    };
    await expect(createMobileAiAdapter(unstable).apply(input)).rejects.toThrow(
      "AI_APPLY_UNCONFIRMED",
    );
    const receipt = await createMobileAiAdapter(unstable).apply(input);
    expect(receipt.taskIds).toEqual(input.tasks.map((t) => t.id));
    expect(calls).toBe(1);
  });
  it("prevents a pending operation from moving into another account or workspace", async () => {
    const { port, scope } = setup();
    const input = command();
    let commits = 0;
    const unstable: AiMobilePort = {
      ...port,
      commit: async () => {
        commits++;
        throw Error("not committed");
      },
    };
    await expect(createMobileAiAdapter(unstable).apply(input)).rejects.toThrow(
      "AI_APPLY_UNCONFIRMED",
    );
    scope.key = "account-b|server-a|database-b|local";
    await expect(createMobileAiAdapter(unstable).apply(input)).rejects.toThrow(
      "AI_STALE_PROJECT",
    );
    expect(commits).toBe(1);
  });
  it("rejects later edits and external references even if a prepared undo tries to delete the reference too", async () => {
    const { storage, adapter } = setup();
    const input = command();
    await adapter.apply(input);
    const before = await storage.workspaceSnapshot();
    const undo = buildMobileAiUndo(
      before,
      input.operationId,
      crypto.randomUUID(),
      "local",
      at,
    )!;
    const foreign = crypto.randomUUID();
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [
        {
          id: foreign,
          kind: "task",
          expectedVersion: null,
          data: {
            title: "后续子任务",
            status: "todo",
            projectId: input.newProject!.id,
            parentId: input.tasks[0]!.id,
          },
        },
      ],
    });
    await expect(storage.workspaceCommand(undo)).rejects.toThrow("后续关联");
    await expect(
      adapter.undo(crypto.randomUUID(), input.operationId),
    ).rejects.toThrow("AI_UNDO_CONFLICT");
    expect(
      (await storage.workspaceSnapshot()).entities
        .filter((e) => e.kind === "task")
        .every((e) => !e.deleted),
    ).toBe(true);
  });
  it("preserves local guards without leaking them into the strict entity sync command", async () => {
    const { storage, adapter } = setup();
    await adapter.apply(command());
    await storage.lanBind({
      baseUrl: "https://example.invalid",
      ownerId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      workspaceId: "local",
    });
    const wire = await storage.entityPrepare();
    expect(wire).not.toBeNull();
    expect(Object.keys(wire!).sort()).toEqual([
      "changes",
      "deviceId",
      "operationId",
    ]);
    expect(wire).not.toHaveProperty("expectedProjectTasks");
    expect(wire).not.toHaveProperty("expectedAiRunUnused");
    expect(wire).not.toHaveProperty("expectedWorkspaceId");
  });
});

async function recoverySetup(withContext = true) {
  const base = setup();
  const { project, task } = await seedProject(base.storage);
  const recordId = crypto.randomUUID(),
    contextId = crypto.randomUUID(),
    foreignProjectId = crypto.randomUUID();
  await base.storage.workspaceCommand({
    operationId: crypto.randomUUID(),
    occurredAt: at,
    changes: [
      {
        id: recordId,
        kind: "record",
        expectedVersion: null,
        data: {
          title: "最近进展",
          body: "选片完成一半",
          projectId: project.id,
          type: "progress",
        },
      },
      {
        id: foreignProjectId,
        kind: "project",
        expectedVersion: null,
        data: { title: "其他项目", status: "active" },
      },
      ...(withContext
        ? [
            {
              id: contextId,
              kind: "desktop_row" as const,
              expectedVersion: null,
              data: {
                table: "project_context",
                row: {
                  project_id: project.id,
                  version: 0,
                  last_context: "已整理相册",
                  restart_hint: "继续选片",
                },
              },
            },
          ]
        : []),
    ],
  });
  const snapshot = await base.storage.workspaceSnapshot();
  const launch = mobileAiLaunch(snapshot, project, "decompose", "继续作品集");
  const input = command(project, [task]);
  input.basisRecovery = {
    version: launch.context.recovery?.version ?? null,
    records: (launch.context.recentRecords ?? []).map((record) => ({
      id: record.id,
      version: record.version,
    })),
  };
  return {
    ...base,
    snapshot,
    project,
    task,
    recordId,
    contextId,
    foreignProjectId,
    launch,
    input,
  };
}
describe("mobile AI recovery evidence CAS", () => {
  it.each([
    "record_addition",
    "record_modification",
    "record_deletion",
    "context_addition",
    "context_modification",
    "shared_link_addition",
  ] as const)(
    "rejects %s inside the real SQLite transaction without changing output or project versions",
    async (kind) => {
      const env = await recoverySetup(kind !== "context_addition");
      const {
        storage,
        snapshot,
        input,
        launch,
        project,
        recordId,
        contextId,
        foreignProjectId,
      } = env;
      const built = buildMobileAiApply(
        snapshot,
        input,
        "local",
        at,
        undefined,
        launch.localRecoveryReadSet,
      );
      const record = snapshot.entities.find(
        (entity) => entity.id === recordId,
      )!;
      const context = snapshot.entities.find(
        (entity) => entity.id === contextId,
      );
      let change: WorkspaceCommand["changes"][number];
      if (kind === "record_addition")
        change = {
          id: crypto.randomUUID(),
          kind: "record",
          expectedVersion: null,
          data: {
            title: "新进展",
            body: "新的实际上下文",
            projectId: project.id,
          },
        };
      else if (kind === "record_modification" || kind === "record_deletion")
        change = {
          id: record.id,
          kind: "record",
          expectedVersion: record.version,
          data: { ...record.data, body: "已更新" },
          ...(kind === "record_deletion" ? { deleted: true } : {}),
        };
      else if (kind === "shared_link_addition")
        change = {
          id: crypto.randomUUID(),
          kind: "desktop_row",
          expectedVersion: null,
          data: {
            table: "record_links",
            row: {
              record_id: recordId,
              target_type: "project",
              target_id: foreignProjectId,
            },
          },
        };
      else
        change = {
          id: contextId,
          kind: "desktop_row",
          expectedVersion: context?.version ?? null,
          data: {
            table: "project_context",
            row: {
              project_id: project.id,
              version: 1,
              last_context: "恢复依据已变化",
            },
          },
        };
      await storage.workspaceCommand({
        operationId: crypto.randomUUID(),
        occurredAt: at,
        changes: [change],
      });
      await expect(storage.workspaceCommand(built.workspace)).rejects.toThrow(
        "AI_STALE_PROJECT",
      );
      const after = await storage.workspaceSnapshot();
      expect(
        after.entities.some(
          (entity) =>
            entity.id === input.operationId ||
            input.tasks.some((task) => task.id === entity.id),
        ),
      ).toBe(false);
      expect(
        after.entities.find((entity) => entity.id === project.id)?.version,
      ).toBe(project.version);
    },
  );
  it("compares generation-time evidence before preparing apply, including absence, and requires missing metadata to be regenerated", async () => {
    const { storage, snapshot, input, launch, project } =
      await recoverySetup(false);
    expect(input.basisRecovery?.version).toBeNull();
    expect(() => buildMobileAiApply(snapshot, input, "local", at)).toThrow(
      "AI_STALE_PROJECT",
    );
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [
        {
          id: crypto.randomUUID(),
          kind: "record",
          expectedVersion: null,
          data: { title: "新增资料", body: "新方向", projectId: project.id },
        },
      ],
    });
    expect(() =>
      buildMobileAiApply(
        { ...snapshot, entities: [...snapshot.entities] },
        { ...input, basisRecovery: { ...input.basisRecovery!, version: 999 } },
        "local",
        at,
        undefined,
        launch.localRecoveryReadSet,
      ),
    ).toThrow("AI_STALE_PROJECT");
    const changed = await storage.workspaceSnapshot();
    expect(() =>
      buildMobileAiApply(
        changed,
        input,
        "local",
        at,
        undefined,
        launch.localRecoveryReadSet,
      ),
    ).toThrow("AI_STALE_PROJECT");
  });
  it("does not reject unrelated project records and never projects the local recovery guard to the entity protocol", async () => {
    const { storage, snapshot, input, launch, foreignProjectId } =
      await recoverySetup();
    const built = buildMobileAiApply(
      snapshot,
      input,
      "local",
      at,
      undefined,
      launch.localRecoveryReadSet,
    );
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [
        {
          id: crypto.randomUUID(),
          kind: "record",
          expectedVersion: null,
          data: {
            title: "别处资料",
            body: "不属于本项目",
            projectId: foreignProjectId,
          },
        },
      ],
    });
    await storage.workspaceCommand(built.workspace);
    expect(
      mobileAiReceipt(await storage.workspaceSnapshot(), input.operationId)
        ?.taskIds,
    ).toEqual(input.tasks.map((task) => task.id));
    await storage.lanBind({
      baseUrl: "https://example.invalid",
      ownerId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      workspaceId: "local",
    });
    const wire = await storage.entityPrepare();
    expect(wire).not.toHaveProperty("expectedAiRecoveryReadSet");
    expect(Object.keys(wire!).sort()).toEqual([
      "changes",
      "deviceId",
      "operationId",
    ]);
    expect(JSON.stringify(wire)).not.toContain("expectedAiRecoveryReadSet");
  });
  it("recovers the exact frozen guard, generated changes and time across restart even without draft metadata", async () => {
    const { storage, port, input, launch } = await recoverySetup();
    const calls: WorkspaceCommand[] = [];
    let interrupted = true;
    const unstable: AiMobilePort = {
      ...port,
      commit: async (command) => {
        calls.push(command);
        if (interrupted) {
          interrupted = false;
          throw Error("connection interrupted");
        }
        return storage.workspaceCommand(command);
      },
    };
    await expect(
      createMobileAiAdapter(unstable).apply(input, launch.localRecoveryReadSet),
    ).rejects.toThrow("AI_APPLY_UNCONFIRMED");
    await createMobileAiAdapter(unstable).apply(input);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]?.expectedAiRecoveryReadSet).toEqual(
      launch.localRecoveryReadSet,
    );
  });
  it("keeps legacy commands unchanged and protects all related entities beyond the five displayed record excerpts", async () => {
    const { storage, project, task } = await recoverySetup();
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: Array.from({ length: 7 }, (_, index) => ({
        id: crypto.randomUUID(),
        kind: "record" as const,
        expectedVersion: null,
        data: {
          title: "项目历史 " + index,
          body: "较早的上下文",
          projectId: project.id,
        },
      })),
    });
    const snapshot = await storage.workspaceSnapshot(),
      input = command(project, [task]);
    const legacy = buildMobileAiApply(snapshot, input, "local", at);
    expect(legacy.workspace).not.toHaveProperty("expectedAiRecoveryReadSet");
    const launch = mobileAiLaunch(snapshot, project, "resume", "继续");
    expect(launch.context.recentRecords).toHaveLength(5);
    expect(
      aiRecoveryReadSet(snapshot, project.id).entities.filter(
        (entity) =>
          snapshot.entities.find((item) => item.id === entity.id)?.kind ===
          "record",
      ),
    ).toHaveLength(8);
  });
});
