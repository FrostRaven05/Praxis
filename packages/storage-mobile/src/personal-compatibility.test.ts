// Host SQLite coverage for P0-02; this does not claim Android device/backup UI acceptance.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import fixture from "../../../docs/p0/personal-compatibility-fixtures.json";
import { MobileStorage, type Connection } from "./index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "./migration";

const at = fixture.clock.now;
const owner = () => crypto.randomUUID();
function connection(read: () => DatabaseSync): Connection {
  return {
    async query(sql, values = []) {
      return {
        values: read()
          .prepare(sql)
          .all(...(values as (string | number | null)[])),
      };
    },
    async run(sql, values = []) {
      read()
        .prepare(sql)
        .run(...(values as (string | number | null)[]));
    },
    async beginTransaction() {
      read().exec("BEGIN");
    },
    async commitTransaction() {
      read().exec("COMMIT");
    },
    async rollbackTransaction() {
      read().exec("ROLLBACK");
    },
  };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "praxis-personal-compat-"));
  const path = join(root, "praxis.db");
  let db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of [...initialStatements, ...captureStatements]) db.exec(sql);
  const storage = new MobileStorage(async () => connection(() => db));
  return {
    storage,
    root,
    path,
    db: () => db,
    upgrade() {
      for (const sql of [
        ...workspaceStatements,
        ...lanStatements,
        ...entitySyncStatements,
      ])
        db.exec(sql);
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function snapshot(db: DatabaseSync) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => {
      const table = '"' + String(name).replaceAll('"', '""') + '"';
      return [
        String(name),
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ];
    }),
  );
}
const binding = (ownerId: string) => ({
  baseUrl: "https://personal.test",
  ownerId,
  deviceId: crypto.randomUUID(),
  workspaceId: "local",
});
const create = (
  id: string,
  kind: "project" | "task",
  data: Record<string, unknown>,
) => ({ id, kind, data, expectedVersion: null });

it("upgrades mobile schema 2 through 5 while retaining old IDs, original text, plans, events and unsent outbox", async () => {
  const f = setup();
  try {
    expect(fixture.synthetic).toBe(true);
    await f.storage.capture({
      operationId: owner(),
      taskId: fixture.independent.id,
      planId: owner(),
      title: fixture.independent.title,
      executionDate: fixture.independent.planDates[0]!,
      timeZone: fixture.clock.timeZone,
      occurredAt: fixture.independent.planDates[0] + "T04:00:00Z",
    });
    await f.storage.saveCapture({
      operationId: owner(),
      id: owner(),
      expectedVersion: null,
      rawText: fixture.independent.notes,
      occurredAt: at,
    });
    const before = snapshot(f.db());
    f.upgrade();
    const after = snapshot(f.db());
    for (const table of [
      "local_profile",
      "tasks",
      "daily_plan_items",
      "domain_events",
      "captures",
      "capture_events",
      "sync_outbox",
    ])
      expect(after[table], table).toEqual(before[table]);
    const migrated = (await f.storage.workspaceSnapshot()).entities.find(
      (e) => e.id === fixture.independent.id,
    )!;
    expect(migrated).toMatchObject({
      kind: "task",
      version: 1,
      data: {
        title: fixture.independent.title,
        projectId: null,
        executionDate: fixture.independent.planDates[0],
      },
    });
    expect(
      (await f.storage.workspaceSnapshot()).entities.find(
        (e) => e.kind === "capture",
      )?.data.rawText,
    ).toBe(fixture.independent.notes);
    f.reopen();
    expect(snapshot(f.db())).toEqual(after);
  } finally {
    f.close();
  }
});

it("roundtrips all mobile tables including desktop time precision, old states, unknown completion, pending and conflicts", async () => {
  const f = setup();
  try {
    f.upgrade();
    await f.storage.lanBind(binding(owner()));
    const taskData = {
      title: fixture.independent.title,
      status: "todo",
      projectId: fixture.project.id,
      notes: fixture.independent.notes,
      completionCriteria: fixture.independent.criteria,
      executionDate: fixture.independent.planDates[1],
      dueDate: "2026-11-10",
      desktop: {
        deadline_value: JSON.stringify(fixture.independent.deadline),
        deadline: fixture.independent.deadline.atUtc,
        deadline_time_zone: fixture.independent.deadline.displayTimezone,
      },
    };
    const command = {
      operationId: owner(),
      occurredAt: at,
      changes: [
        create(fixture.project.id, "project", {
          title: fixture.project.name,
          status: "active",
          dueDate: fixture.project.targetDate,
        }),
        create(fixture.independent.id, "task", taskData),
        create(fixture.dateTask.id, "task", {
          title: "只有截止日期",
          status: "todo",
          dueDate: fixture.dateTask.deadline.date,
        }),
        ...fixture.legacyTasks.map((t) =>
          create(t.id, "task", {
            title: t.title,
            status: t.status,
            waiting: t.waiting,
            parentId: t.parentId,
            projectId: fixture.project.id,
            waitingFor: "原有反馈",
            waitingReason: "保留旧说明",
          }),
        ),
        create(fixture.unknownCompletion.id, "task", {
          title: fixture.unknownCompletion.title,
          status: "completed",
        }),
      ],
    };
    await f.storage.workspaceCommand(command);
    await f.storage.workspaceCommand(command);
    // Represents already-existing history. Do not create a present-day completion fact.
    f.db()
      .prepare(
        "UPDATE mobile_entities SET data=json_set(data,'$.completedAt',NULL) WHERE id=?",
      )
      .run(fixture.unknownCompletion.id);
    const pending = await f.storage.entityPrepare();
    expect(pending).not.toBeNull();
    expect(await f.storage.entityPrepare()).toEqual(pending);
    const incoming = {
      id: fixture.independent.id,
      kind: "task" as const,
      version: 1,
      data: { ...taskData, title: "远端不同标题" },
      deleted: false,
      createdAt: at,
      updatedAt: at,
    };
    await f.storage.entityPull({
      changes: [
        {
          operationId: owner(),
          deviceId: owner(),
          cursor: 1,
          entities: [incoming],
        },
      ],
      cursor: 1,
      hasMore: false,
    });
    const state = await f.storage.entityState();
    expect(state.conflicts).toHaveLength(1);
    f.db().exec(
      "CREATE TABLE personal_compatibility_extension(id TEXT PRIMARY KEY,payload TEXT)",
    );
    f.db()
      .prepare("INSERT INTO personal_compatibility_extension VALUES('keep',?)")
      .run("未知扩展内容 😀");
    const before = snapshot(f.db());
    const backupPath = join(f.root, "backup.db");
    f.db().prepare("VACUUM INTO ?").run(backupPath);
    const copy = new DatabaseSync(backupPath);
    try {
      expect(snapshot(copy)).toEqual(before);
      expect(
        copy.prepare("PRAGMA integrity_check").get()?.integrity_check,
      ).toBe("ok");
      expect(copy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      copy.close();
    }
    f.reopen();
    expect(snapshot(f.db())).toEqual(before);
    expect(await f.storage.entityPrepare()).toEqual(pending);
    const saved = (await f.storage.workspaceSnapshot()).entities;
    expect(
      saved.find((e) => e.id === fixture.independent.id)?.data.desktop,
    ).toEqual(taskData.desktop);
    expect(
      saved.find((e) => e.id === fixture.legacyTasks[2]!.id)?.data,
    ).toMatchObject({
      status: "todo",
      waiting: true,
      waitingReason: "保留旧说明",
    });
    expect(
      saved.find((e) => e.id === fixture.unknownCompletion.id)?.data
        .completedAt,
    ).toBeNull();
    expect((await f.storage.entityState()).conflicts).toEqual(state.conflicts);
  } finally {
    f.close();
  }
});

it("keeps one task identity when changing personal project, rejects stale edits and does not merge separate account stores", async () => {
  const a = setup(),
    b = setup();
  try {
    a.upgrade();
    b.upgrade();
    const identityA = binding(owner()),
      identityB = binding(owner());
    await a.storage.lanBind(identityA);
    await b.storage.lanBind(identityB);
    const data = {
      title: "甲的任务",
      status: "todo",
      notes: fixture.independent.notes,
      projectId: null,
    };
    const original = {
      operationId: owner(),
      occurredAt: at,
      changes: [create(fixture.independent.id, "task", data)],
    };
    await a.storage.workspaceCommand(original);
    await b.storage.workspaceCommand({
      operationId: owner(),
      occurredAt: at,
      changes: [
        create(fixture.independent.id, "task", { ...data, title: "乙的任务" }),
      ],
    });
    const bBefore = snapshot(b.db());
    const move = {
      operationId: owner(),
      occurredAt: at,
      changes: [
        create(fixture.project.id, "project", {
          title: fixture.project.name,
          status: "active",
        }),
        {
          ...create(fixture.independent.id, "task", {
            ...data,
            projectId: fixture.project.id,
          }),
          expectedVersion: 1,
        },
      ],
    };
    await a.storage.workspaceCommand(move);
    await a.storage.workspaceCommand(move);
    const tasks = (await a.storage.workspaceSnapshot()).entities.filter(
      (e) => e.kind === "task",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: fixture.independent.id,
      version: 2,
      data: { projectId: fixture.project.id, notes: fixture.independent.notes },
    });
    await expect(
      a.storage.workspaceCommand({
        ...move,
        operationId: owner(),
        changes: [move.changes[1]!],
      }),
    ).rejects.toThrow("已变更");
    const beforeRebind = snapshot(a.db());
    await expect(a.storage.lanBind(identityB)).rejects.toThrow("身份已变化");
    expect(snapshot(a.db())).toEqual(beforeRebind);
    expect(snapshot(b.db())).toEqual(bBefore);
  } finally {
    a.close();
    b.close();
  }
});
