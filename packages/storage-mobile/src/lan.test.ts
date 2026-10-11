import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { MobileStorage, type Connection, type LanCapture } from "./index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
} from "./migration";
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const sql of [
    ...initialStatements,
    ...captureStatements,
    ...workspaceStatements,
    ...lanStatements,
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
async function save(
  storage: MobileStorage,
  id: string,
  text: string,
  version: number | null,
) {
  await storage.workspaceCommand({
    operationId: crypto.randomUUID(),
    occurredAt: at,
    changes: [
      {
        id,
        kind: "capture",
        expectedVersion: version,
        data: { rawText: text, status: "inbox" },
      },
    ],
  });
}
const remote = (id: string, rawText: string, version = 1): LanCapture => ({
  id,
  rawText,
  version,
  deleted: false,
  updatedAt: at,
});
it("freezes unknown-commit upload and preserves in-flight local edits on acknowledgment", async () => {
  const { storage, db, lose } = setup();
  try {
    await storage.lanBind(binding);
    const id = crypto.randomUUID();
    await save(storage, id, "一\n二", null);
    lose();
    await expect(storage.lanPrepare()).rejects.toThrow("lost");
    const first = await storage.lanPrepare();
    expect(first).not.toBeNull();
    await save(storage, id, "edited while offline", 1);
    expect(await storage.lanPrepare()).toEqual(first);
    await storage.lanAck(first!, remote(id, "一\n二"));
    expect((await storage.workspaceSnapshot()).entities[0]!.data.rawText).toBe(
      "edited while offline",
    );
    const next = await storage.lanPrepare();
    expect(next?.expectedVersion).toBe(1);
    expect(next?.rawText).toBe("edited while offline");
    expect(next?.operationId).not.toBe(first?.operationId);
  } finally {
    db.close();
  }
});
it("commits pull with cursor atomically and retains dirty local value as a visible conflict", async () => {
  const { storage, db, lose } = setup();
  try {
    await storage.lanBind(binding);
    const id = crypto.randomUUID();
    await storage.lanPull({
      changes: [{ capture: remote(id, "remote"), cursor: 1 }],
      cursor: 1,
      hasMore: false,
    });
    await save(storage, id, "local draft", 1);
    lose();
    await expect(
      storage.lanPull({
        changes: [{ capture: remote(id, "remote changed", 2), cursor: 2 }],
        cursor: 2,
        hasMore: false,
      }),
    ).rejects.toThrow("lost");
    expect((await storage.lanState()).cursor).toBe(2);
    expect((await storage.lanState()).conflicts).toHaveLength(1);
    expect((await storage.workspaceSnapshot()).entities[0]!.data.rawText).toBe(
      "local draft",
    );
    expect(await storage.lanPrepare()).toBeNull();
    await expect(
      storage.lanResolve(id, true, 1, 2, crypto.randomUUID()),
    ).rejects.toThrow("内容已变化");
    const resolveId = crypto.randomUUID();
    lose();
    await expect(storage.lanResolve(id, true, 2, 2, resolveId)).rejects.toThrow(
      "lost",
    );
    await storage.lanResolve(id, true, 2, 2, resolveId);
    expect(
      (await storage.workspaceSnapshot()).entities
        .map((e) => e.data.rawText)
        .sort(),
    ).toEqual(["local draft", "remote changed"]);
    expect((await storage.lanState()).conflicts).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("binds uploads to one workspace and owner, while preserving local clarification data on clean pull", async () => {
  const { storage, db } = setup();
  try {
    await storage.lanBind(binding);
    const id = crypto.randomUUID();
    await storage.lanPull({
      changes: [{ capture: remote(id, "first"), cursor: 1 }],
      cursor: 1,
      hasMore: false,
    });
    db.prepare(
      "UPDATE mobile_entities SET data=json_set(data,'$.status','clarified') WHERE id=?",
    ).run(id);
    await storage.lanPull({
      changes: [{ capture: remote(id, "second", 2), cursor: 2 }],
      cursor: 2,
      hasMore: false,
    });
    expect((await storage.workspaceSnapshot()).entities[0]!.data.status).toBe(
      "clarified",
    );
    db.exec("INSERT INTO mobile_workspaces VALUES('other','other',0)");
    await storage.workspaceSwitch("other");
    await save(storage, crypto.randomUUID(), "private workspace", null);
    expect(await storage.lanPrepare()).toBeNull();
    await expect(
      storage.lanBind({ ...binding, ownerId: "another" }),
    ).rejects.toThrow("身份");
    expect((await storage.lanState()).active).toBe(false);
  } finally {
    db.close();
  }
});
it("blocks rejected commands but continues independent captures and retains frozen payload", async () => {
  const { storage, db } = setup();
  try {
    await storage.lanBind(binding);
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    await save(storage, a, "A", null);
    const pending = await storage.lanPrepare();
    await storage.lanBlock(a);
    await save(storage, b, "B", null);
    expect((await storage.lanPrepare())?.id).toBe(b);
    expect(
      JSON.parse(
        String(
          db.prepare("SELECT payload FROM mobile_lan_pending WHERE id=?").get(a)
            ?.payload,
        ),
      ),
    ).toEqual(pending);
  } finally {
    db.close();
  }
});
it("rejects malformed pages without applying entities or advancing the cursor", async () => {
  const { storage, db } = setup();
  try {
    await storage.lanBind(binding);
    const id = crypto.randomUUID();
    await expect(
      storage.lanPull({
        changes: [
          { capture: remote(id, "valid"), cursor: 1 },
          { capture: remote(crypto.randomUUID(), "bad", 0), cursor: 2 },
        ],
        cursor: 2,
        hasMore: false,
      }),
    ).rejects.toThrow("无效同步条目");
    expect((await storage.lanState()).cursor).toBe(0);
    expect((await storage.workspaceSnapshot()).entities).toHaveLength(0);
    await expect(
      storage.lanPull({
        changes: [{ capture: remote(id, "valid"), cursor: 1 }],
        cursor: 3,
        hasMore: false,
      }),
    ).rejects.toThrow("无效同步游标");
    expect((await storage.lanState()).cursor).toBe(0);
  } finally {
    db.close();
  }
});
