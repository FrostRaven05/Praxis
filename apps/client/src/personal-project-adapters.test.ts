import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  MobileStorage,
  mobilePersonalWork,
  WorkspaceRejectedError,
  type Connection,
  type WorkspaceEntity,
} from "@praxis/storage-mobile";
import type { SaveProjectCommand } from "@praxis/application";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "../../../packages/storage-mobile/src/migration";
import { mobileProjectCommand } from "./personal-project-adapters";
const at = "2026-11-11T04:00:00Z";
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
  return { db, storage: new MobileStorage(async () => connection) };
}
const entity = (): WorkspaceEntity => ({
  id: id(),
  kind: "project",
  version: 0,
  deleted: false,
  createdAt: at,
  updatedAt: at,
  data: {
    title: "",
    status: "active",
    recoveryNote: "旧恢复卡",
    completionCriteria: "旧验收",
    custom: { keep: true },
    desktop: { priority: 2, opaque: "保留" },
  },
});
const command = (
  e: WorkspaceEntity,
  patch: Partial<SaveProjectCommand> = {},
): SaveProjectCommand => ({
  operationId: id(),
  projectId: e.id,
  expectedVersion: e.version || null,
  name: "个人项目",
  outcome: "",
  targetDate: null,
  priority: 1,
  occurredAt: at,
  ...patch,
});

it("saves a name-only mobile project once, retains opaque fields on short-form edits and exposes original update time", async () => {
  const { storage, db } = setup();
  try {
    const e = entity(),
      ws = (await storage.workspaceSnapshot()).workspaceId!;
    const c = mobileProjectCommand(e, ws, command(e));
    await storage.workspaceCommand(c);
    await storage.workspaceCommand(c);
    let snapshot = await storage.workspaceSnapshot();
    expect(snapshot.entities.filter((x) => x.kind === "project")).toHaveLength(
      1,
    );
    const saved = snapshot.entities.find((x) => x.id === e.id)!;
    expect(saved.data).toMatchObject({
      ...e.data,
      title: "个人项目",
      outcome: "",
      dueDate: null,
    });
    await storage.workspaceCommand(
      mobileProjectCommand(
        saved,
        ws,
        command(saved, {
          name: "更名",
          outcome: "目标",
          targetDate: "2026-12-01",
          occurredAt: "2026-11-11T05:00:00Z",
        }),
      ),
    );
    snapshot = await storage.workspaceSnapshot();
    const updated = snapshot.entities.find((x) => x.id === e.id)!;
    expect(updated.data).toMatchObject({
      ...e.data,
      title: "更名",
      outcome: "目标",
      dueDate: "2026-12-01",
    });
    expect(mobilePersonalWork(snapshot, "UTC").projects[0]).toMatchObject({
      id: e.id,
      name: "更名",
      targetDate: "2026-12-01",
      createdAt: saved.createdAt,
      updatedAt: updated.updatedAt,
    });
  } finally {
    db.close();
  }
});
it("rejects stale mobile edits and wrong workspace without changing project fields or sync queues", async () => {
  const { storage, db } = setup();
  try {
    const e = entity(),
      ws = (await storage.workspaceSnapshot()).workspaceId!;
    await storage.workspaceCommand(mobileProjectCommand(e, ws, command(e)));
    const before = await storage.workspaceSnapshot();
    await expect(
      storage.workspaceCommand(
        mobileProjectCommand(e, ws, command(e, { name: "stale" })),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRejectedError);
    const saved = before.entities.find((x) => x.id === e.id)!;
    await expect(
      storage.workspaceCommand(
        mobileProjectCommand(saved, "different-workspace", command(saved)),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRejectedError);
    expect(await storage.workspaceSnapshot()).toEqual(before);
  } finally {
    db.close();
  }
});
