import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { MobileStorage, type Connection, type WorkspaceEntity } from "./index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "./migration";
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const sql of [
    ...initialStatements,
    ...captureStatements,
    ...workspaceStatements,
    ...lanStatements,
    ...entitySyncStatements,
  ])
    db.exec(sql);
  let lose = false;
  const connection: Connection = {
    async query(sql, values = []) {
      return {
        values: db.prepare(sql).all(...(values as (string | number | null)[])),
      };
    },
    async run(sql, values = [], transaction = true) {
      // Match CapacitorSQLite: run() owns a transaction unless explicitly disabled.
      if (transaction) db.exec("BEGIN");
      try {
        db.prepare(sql).run(...(values as (string | number | null)[]));
        if (transaction) db.exec("COMMIT");
      } catch (error) {
        if (transaction) db.exec("ROLLBACK");
        throw error;
      }
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
  return { db, storage, lose: () => (lose = true) };
}
const at = "2026-10-11T00:00:00Z";
const binding = {
  baseUrl: "https://192.168.1.1:4318",
  ownerId: "owner",
  deviceId: crypto.randomUUID(),
  workspaceId: "local",
};

const entity = (
  kind: WorkspaceEntity["kind"],
  data: Record<string, unknown>,
  id: string = crypto.randomUUID(),
  version = 1,
): WorkspaceEntity => ({
  id,
  kind,
  version,
  data,
  deleted: false,
  createdAt: at,
  updatedAt: at,
});
const page = (entities: WorkspaceEntity[], cursor = 1) => ({
  changes: [
    {
      entities,
      cursor,
      operationId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
    },
  ],
  cursor,
  hasMore: false,
});
async function save(
  storage: MobileStorage,
  e: WorkspaceEntity,
  expectedVersion: number | null = null,
) {
  await storage.workspaceCommand({
    operationId: crypto.randomUUID(),
    occurredAt: at,
    changes: [
      {
        id: e.id,
        kind: e.kind,
        data: e.data,
        deleted: e.deleted,
        expectedVersion,
      },
    ],
  });
}
it("atomically pulls dependent project/task/plan and retains desktop extensions on local edits", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const p = entity("project", {
      title: "Project",
      status: "active",
      desktop: { notes: "retained" },
    });
    const t = entity("task", {
      title: "Task",
      status: "todo",
      projectId: p.id,
      desktop: { source: "manual" },
    });
    const plan = entity("plan", {
      date: "2026-10-11",
      taskIds: [t.id],
      timeZone: "Asia/Hong_Kong",
    });
    await storage.entityPull(page([p, t, plan]));
    expect(await storage.entityPrepare()).toBeNull();
    await save(storage, { ...t, data: { ...t.data, title: "Edited" } }, 1);
    const command = await storage.entityPrepare();
    expect(command?.changes).toHaveLength(1);
    expect(command?.changes[0]?.data.desktop).toEqual({ source: "manual" });
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(3);
  } finally {
    db.close();
  }
});
it("freezes unknown commit retries and preserves in-flight edits and independent remote fields", async () => {
  const { db, storage, lose } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", { title: "Initial", status: "todo", priority: 0 });
    await save(storage, t);
    lose();
    await expect(storage.entityPrepare()).rejects.toThrow("lost");
    const frozen = (await storage.entityPrepare())!;
    await save(
      storage,
      { ...t, data: { ...t.data, title: "During upload" } },
      1,
    );
    expect(await storage.entityPrepare()).toEqual(frozen);
    await storage.entityAck(frozen, [{ ...t, version: 1 }]);
    let next = (await storage.entityPrepare())!;
    expect(next.changes[0]?.data.title).toBe("During upload");
    await storage.entityReject();
    await storage.entityPull(
      page([{ ...t, version: 2, data: { ...t.data, priority: 2 } }]),
    );
    next = (await storage.entityPrepare())!;
    expect(next.changes[0]?.data).toMatchObject({
      title: "During upload",
      priority: 2,
    });
  } finally {
    db.close();
  }
});
it("same-field conflicts preserve both versions, CAS guard resolution and retry commit idempotently", async () => {
  const { db, storage, lose } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", { title: "Initial", status: "todo" });
    await storage.entityPull(page([t]));
    await save(storage, { ...t, data: { ...t.data, title: "Local" } }, 1);
    await storage.entityPull(
      page([{ ...t, version: 2, data: { ...t.data, title: "Remote" } }], 2),
    );
    let c = (await storage.entityState()).conflicts[0]!;
    expect(c.local[0]?.data.title).toBe("Local");
    expect(c.batch.entities[0]?.data.title).toBe("Remote");
    expect(await storage.entityPrepare()).toBeNull();
    await save(storage, { ...t, data: { ...t.data, title: "Newer local" } }, 2);
    await expect(
      storage.entityResolve(
        c.operationId,
        true,
        c.expected,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("已变化");
    c = (await storage.entityState()).conflicts[0]!;
    const receipt = crypto.randomUUID();
    lose();
    await expect(
      storage.entityResolve(c.operationId, true, c.expected, receipt),
    ).rejects.toThrow("lost");
    await storage.entityResolve(c.operationId, true, c.expected, receipt);
    expect((await storage.entityPrepare())?.changes[0]).toMatchObject({
      expectedVersion: 2,
      data: { title: "Newer local" },
    });
  } finally {
    db.close();
  }
});
it("malformed pages roll back rows and cursor; remote tombstones do not overwrite dirty edits", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", { title: "Initial", status: "todo" });
    const invalid = page([t]);
    invalid.cursor = 9;
    await expect(storage.entityPull(invalid)).rejects.toThrow("游标");
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
    expect((await storage.entityState()).cursor).toBe(0);
    await storage.entityPull(page([t]));
    await save(storage, { ...t, data: { ...t.data, title: "Local" } }, 1);
    await storage.entityPull(page([{ ...t, deleted: true, version: 2 }], 2));
    expect((await storage.workspaceSnapshot()).entities[0]?.deleted).toBe(
      false,
    );
    expect((await storage.entityState()).conflicts).toHaveLength(1);
  } finally {
    db.close();
  }
});
it("migrates dirty legacy capture and clarification metadata while keeping pending until v2 acknowledgment", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const c = entity("capture", { rawText: "old", status: "inbox" });
    await save(storage, c);
    const old = (await storage.lanPrepare())!;
    await storage.lanAck(old, {
      id: c.id,
      rawText: "old",
      deleted: false,
      version: 1,
      updatedAt: at,
    });
    await save(
      storage,
      {
        ...c,
        data: { rawText: "offline new", status: "inbox", notes: "metadata" },
      },
      1,
    );
    await storage.lanPrepare();
    await storage.entityPull(page([c]));
    const next = (await storage.entityPrepare())!;
    expect(next.changes[0]?.data).toEqual({
      rawText: "offline new",
      status: "inbox",
      notes: "metadata",
    });
    expect(
      db.prepare("SELECT count(*) n FROM mobile_lan_pending").get()?.n,
    ).toBe(1);
    await storage.entityAck(next, [
      { ...c, version: 2, data: next.changes[0]!.data },
    ]);
    expect(
      db.prepare("SELECT count(*) n FROM mobile_lan_pending").get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});
it("roundtrips every non-AI domain including opaque desktop rows without losing nested fields", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const p = entity("project", { title: "P", status: "active" });
    const h = entity("habit", { title: "H", frequency: "daily" });
    const rec = entity("recurrence", {
      title: "R",
      frequency: "weekly",
      weekdays: [1],
    });
    const t = entity("task", {
      title: "T",
      status: "todo",
      projectId: p.id,
      recurrenceId: rec.id,
      originalDate: "2026-10-11",
    });
    const all = [
      p,
      h,
      rec,
      t,
      entity("capture", { rawText: "raw", status: "inbox" }),
      entity("section", { title: "S", projectId: p.id }),
      entity("plan", { date: "2026-10-11", taskIds: [t.id] }),
      entity("record", { body: "Body", projectId: p.id }),
      entity("habit_check", { habitId: h.id, date: "2026-10-11", count: 2 }),
      entity("review", { date: "2026-10-11", note: "review" }),
      entity("view", { title: "View", filters: { tags: ["x"] } }),
      entity("settings", { timeZone: "Asia/Hong_Kong" }),
      entity("strategy", { title: "Strategy", body: "s" }),
      entity("decision", { title: "Decision", body: "d" }),
      entity("focus", { taskId: t.id, elapsedSeconds: 12 }),
      entity("desktop_row", {
        table: "record_links",
        row: { id: crypto.randomUUID(), nested: { exact: [1, null, "x"] } },
      }),
    ];
    await storage.entityPull(page(all));
    expect(
      (await storage.workspaceSnapshot()).entities.map((e) => e.kind).sort(),
    ).toEqual(all.map((e) => e.kind).sort());
    expect(await storage.entityPrepare()).toBeNull();
    const roundtrip = JSON.parse(await storage.workspaceExport());
    expect(
      roundtrip.entities.find((e: WorkspaceEntity) => e.kind === "desktop_row")
        .data,
    ).toEqual(all[15]!.data);
  } finally {
    db.close();
  }
});
it("rejects workspace identity changes and pauses imported workspaces", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    await expect(
      storage.lanBind({ ...binding, deviceId: crypto.randomUUID() }),
    ).rejects.toThrow("身份");
    const original = await storage.workspaceExport();
    await storage.workspaceImport(original, crypto.randomUUID());
    expect((await storage.entityState()).active).toBe(false);
    expect(await storage.entityPrepare()).toBeNull();
    await expect(
      storage.entityPull({ changes: [], cursor: 0, hasMore: false }),
    ).rejects.toThrow("切回");
  } finally {
    db.close();
  }
});
it("remote atomic graph failures stay in explicit conflicts, never partly apply or lose cursor", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", {
      title: "Orphan",
      status: "todo",
      projectId: crypto.randomUUID(),
    });
    await storage.entityPull(page([t]));
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
    expect((await storage.entityState()).cursor).toBe(1);
    const conflict = (await storage.entityState()).conflicts[0]!;
    await expect(
      storage.entityResolve(
        conflict.operationId,
        false,
        conflict.expected,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("关联");
    expect((await storage.entityState()).conflicts).toHaveLength(1);
  } finally {
    db.close();
  }
});
it("isolates conflicted connected projects while unrelated content continues syncing", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const p = entity("project", { title: "P", status: "active" }),
      q = entity("project", { title: "Q", status: "active" }),
      t = entity("task", { title: "T", status: "todo", projectId: p.id });
    await storage.entityPull(page([p, q, t]));
    await save(storage, { ...t, data: { ...t.data, title: "Local" } }, 1);
    await storage.entityPull(
      page([{ ...t, version: 2, data: { ...t.data, title: "Remote" } }], 2),
    );
    await save(storage, { ...q, data: { ...q.data, title: "Independent" } }, 1);
    const command = (await storage.entityPrepare())!;
    expect(command.changes.map((c) => c.id)).toEqual([q.id]);
    await storage.entityReject();
    const u = entity("task", {
      title: "Unrelated remote",
      status: "todo",
      projectId: q.id,
    });
    await storage.entityPull(page([u], 3));
    expect(
      (await storage.workspaceSnapshot()).entities.some((e) => e.id === u.id),
    ).toBe(true);
    expect((await storage.entityState()).conflicts).toHaveLength(1);
  } finally {
    db.close();
  }
});
it("merges different nested desktop fields and validates explicit merged conflict identities", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", {
      title: "T",
      status: "todo",
      desktop: { a: 1, b: 1 },
    });
    await storage.entityPull(page([t]));
    await save(
      storage,
      { ...t, data: { ...t.data, desktop: { a: 2, b: 1 } } },
      1,
    );
    await storage.entityPull(
      page(
        [{ ...t, version: 2, data: { ...t.data, desktop: { a: 1, b: 2 } } }],
        2,
      ),
    );
    expect(
      (await storage.workspaceSnapshot()).entities[0]?.data.desktop,
    ).toEqual({ a: 2, b: 2 });
    await storage.entityPull(
      page(
        [{ ...t, version: 3, data: { ...t.data, desktop: { a: 3, b: 2 } } }],
        3,
      ),
    );
    const c = (await storage.entityState()).conflicts[0]!;
    await expect(
      storage.entityResolve(
        c.operationId,
        true,
        c.expected,
        crypto.randomUUID(),
        [{ ...t, id: crypto.randomUUID() }],
      ),
    ).rejects.toThrow("身份");
    await storage.entityResolve(
      c.operationId,
      true,
      c.expected,
      crypto.randomUUID(),
      [
        {
          ...c.batch.entities[0]!,
          data: { ...t.data, desktop: { a: 4, b: 2 } },
        },
      ],
    );
    expect((await storage.entityPrepare())?.changes[0]?.data.desktop).toEqual({
      a: 4,
      b: 2,
    });
  } finally {
    db.close();
  }
});
it("rebases a rolled back backend without losing acknowledged or pending local changes", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity(
      "task",
      { title: "Newest acknowledged", status: "todo" },
      crypto.randomUUID(),
      3,
    );
    const generation = crypto.randomUUID();
    await storage.entityPull({ ...page([t]), generation });
    const pending = entity("record", { body: "Not yet acknowledged" });
    await save(storage, pending);
    const frozen = (await storage.entityPrepare())!;
    const restored = {
      ...t,
      version: 1,
      data: { ...t.data, title: "Old backup" },
    };
    await storage.entityRebase([restored], 1, crypto.randomUUID());
    const next = (await storage.entityPrepare())!;
    expect(next.operationId).not.toBe(frozen.operationId);
    await storage.entityAck(
      next,
      next.changes.map((c) => ({
        id: c.id,
        kind: c.kind as WorkspaceEntity["kind"],
        data: c.data,
        deleted: c.deleted,
        version: (c.expectedVersion ?? 0) + 1,
        createdAt: c.createdAt,
        updatedAt: at,
      })),
    );
    const remaining = (await storage.entityPrepare())!;
    const rebased = [...next.changes, ...remaining.changes];
    expect(rebased.find((c) => c.id === t.id)).toMatchObject({
      expectedVersion: 1,
      data: { title: "Newest acknowledged" },
    });
    expect(rebased.find((c) => c.id === pending.id)).toMatchObject({
      expectedVersion: null,
      data: { body: "Not yet acknowledged" },
    });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM mobile_operations WHERE payload LIKE '%entity_sync_rebase%'",
        )
        .get()?.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});
it("prepares separate unrelated graphs while preserving a task move and both project reference changes atomically", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const p = entity(
        "project",
        { title: "P", status: "active" },
        "00000000-0000-4000-8000-000000000001",
      ),
      q = entity(
        "project",
        { title: "Q", status: "active" },
        "00000000-0000-4000-8000-000000000002",
      ),
      t = entity(
        "task",
        { title: "T", status: "todo", projectId: p.id },
        "00000000-0000-4000-8000-000000000003",
      ),
      u = entity(
        "task",
        { title: "U", status: "todo", projectId: q.id },
        "00000000-0000-4000-8000-000000000004",
      );
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [p, q, t, u].map((e) => ({
        id: e.id,
        kind: e.kind,
        data: e.data,
        expectedVersion: null,
      })),
    });
    const first = (await storage.entityPrepare())!;
    expect(first.changes.map((c) => c.id)).toEqual([p.id, t.id]);
    await storage.entityAck(first, [p, t]);
    const second = (await storage.entityPrepare())!;
    expect(second.changes.map((c) => c.id)).toEqual([q.id, u.id]);
    await storage.entityAck(second, [q, u]);
    await storage.workspaceCommand({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [
        {
          id: p.id,
          kind: p.kind,
          expectedVersion: 1,
          data: { ...p.data, recoveryNote: "cleanup" },
        },
        {
          id: q.id,
          kind: q.kind,
          expectedVersion: 1,
          data: { ...q.data, nextActionId: t.id },
        },
        {
          id: t.id,
          kind: t.kind,
          expectedVersion: 1,
          data: { ...t.data, projectId: q.id },
        },
      ],
    });
    expect((await storage.entityPrepare())?.changes.map((c) => c.id)).toEqual([
      p.id,
      q.id,
      t.id,
    ]);
  } finally {
    db.close();
  }
});
it("rebases isolated components with one transaction and preserves cross-project plan graphs as a single conflict unit", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const pa = entity("project", { title: "A", status: "active" }),
      pb = entity("project", { title: "B", status: "active" }),
      ta = entity("task", { title: "A old", status: "todo", projectId: pa.id }),
      tb = entity("task", { title: "B old", status: "todo", projectId: pb.id });
    const generation = crypto.randomUUID();
    await storage.entityPull({ ...page([pa, ta, pb, tb]), generation });
    await save(storage, { ...ta, data: { ...ta.data, title: "A local" } }, 1);
    const remote = [
      pa,
      { ...ta, version: 2, data: { ...ta.data, title: "A remote" } },
      pb,
      { ...tb, version: 2, data: { ...tb.data, title: "B remote" } },
    ];
    db.exec(
      `CREATE TRIGGER reject_rebase_b BEFORE UPDATE ON mobile_entities WHEN NEW.id='${tb.id}' BEGIN SELECT RAISE(ABORT, 'simulated second component write failure'); END`,
    );
    const nextGeneration = crypto.randomUUID();
    await expect(
      storage.entityRebase(remote, 9, nextGeneration),
    ).rejects.toThrow("second component");
    expect(await storage.entityState()).toMatchObject({
      cursor: 1,
      generation,
      conflicts: [],
    });
    expect(
      (await storage.workspaceSnapshot()).entities.find((e) => e.id === tb.id)
        ?.data.title,
    ).toBe("B old");
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM mobile_operations WHERE payload LIKE '%entity_sync_rebase%'",
        )
        .get()?.n,
    ).toBe(0);
    db.exec("DROP TRIGGER reject_rebase_b");
    await storage.entityRebase(remote, 9, nextGeneration);
    expect(await storage.entityState()).toMatchObject({
      cursor: 9,
      generation: nextGeneration,
    });
    expect(
      (await storage.entityState()).conflicts[0]?.batch.entities
        .map((e) => e.id)
        .sort(),
    ).toEqual([pa.id, ta.id].sort());
    expect(
      (await storage.workspaceSnapshot()).entities.find((e) => e.id === tb.id)
        ?.data.title,
    ).toBe("B remote");
    // A plan that spans both projects is a business relationship, so its whole
    // graph must remain one unit rather than splitting an atomic plan update.
    const plan = entity("plan", {
      date: "2026-10-11",
      taskIds: [ta.id, tb.id],
    });
    await storage.entityRebase([...remote, plan], 10, crypto.randomUUID());
    expect((await storage.entityState()).conflicts).toHaveLength(1);
    expect(
      (await storage.entityState()).conflicts[0]?.batch.entities,
    ).toHaveLength(5);
  } finally {
    db.close();
  }
});
it("persists rejected batches and resumes when user repairs data", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const t = entity("task", { title: "T", status: "todo" });
    await save(storage, t);
    await storage.entityPrepare();
    await storage.entityReject("INVALID_GRAPH");
    expect((await storage.entityState()).rejected?.error).toBe("INVALID_GRAPH");
    expect(await storage.entityPrepare()).toBeNull();
    await storage.entityRepair({
      operationId: crypto.randomUUID(),
      occurredAt: at,
      changes: [
        {
          id: t.id,
          kind: t.kind,
          expectedVersion: 1,
          data: { ...t.data, title: "Repaired" },
        },
      ],
    });
    expect((await storage.entityPrepare())?.changes[0]?.data.title).toBe(
      "Repaired",
    );
    expect((await storage.entityState()).rejected).toBeUndefined();
  } finally {
    db.close();
  }
});
it("uses seeded server creation time while preserving legacy local creation metadata", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    const c = entity("capture", { rawText: "original", status: "inbox" });
    await save(storage, c);
    db.prepare("UPDATE mobile_entities SET created_at=? WHERE id=?").run(
      "2026-01-01T00:00:00Z",
      c.id,
    );
    const v1 = (await storage.lanPrepare())!;
    await storage.lanAck(v1, {
      id: c.id,
      rawText: "original",
      deleted: false,
      version: 1,
      updatedAt: at,
    });
    await save(storage, { ...c, data: { ...c.data, rawText: "changed" } }, 1);
    await storage.entityPull(page([c]));
    const command = (await storage.entityPrepare())!;
    expect(command.changes[0]?.createdAt).toBe(at);
    expect((await storage.workspaceSnapshot()).entities[0]?.createdAt).toBe(
      "2026-01-01T00:00:00Z",
    );
  } finally {
    db.close();
  }
});
it("rolls back malformed UUID and empty continuation pages", async () => {
  const { db, storage } = setup();
  try {
    await storage.lanBind(binding);
    await expect(
      storage.entityPull(page([entity("record", { body: "x" }, "not-a-uuid")])),
    ).rejects.toThrow("无效");
    await expect(
      storage.entityPull({ changes: [], cursor: 0, hasMore: true }),
    ).rejects.toThrow("无效");
    expect((await storage.entityState()).cursor).toBe(0);
  } finally {
    db.close();
  }
});
