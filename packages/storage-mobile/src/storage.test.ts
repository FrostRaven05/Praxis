import scenarios from "../../application/fixtures/capture-storage.json";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { CaptureCommand } from "@praxis/application";
import { MobileStorage, type Connection } from "./index";
import { initialStatements } from "./migration";

function command(): CaptureCommand {
  return {
    operationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    title: "手机离线任务",
    executionDate: "2026-09-16",
    timeZone: "Asia/Hong_Kong",
    occurredAt: "2026-09-16T12:00:00.000Z",
  };
}
function fixture(failBegin = false) {
  const dir = mkdtempSync(join(tmpdir(), "praxis-mobile-"));
  const path = join(dir, "test.db");
  let db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;");
  for (const statement of initialStatements) db.prepare(statement).run();
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
      if (failBegin) {
        failBegin = false;
        throw new Error("database busy: private diagnostic");
      }
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
    store: new MobileStorage(async () => connection),
    count(table: string) {
      return db.prepare("SELECT count(*) AS count FROM " + table).get()?.count;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON;");
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}
describe("mobile adapter against actual host SQLite (not Android acceptance)", () => {
  it("saves four records, replays once and survives reopening", async () => {
    const f = fixture();
    try {
      const c = command();
      await f.store.capture(c);
      await f.store.capture(c);
      f.reopen();
      expect(await f.store.listDay(c.executionDate)).toMatchObject([
        { title: c.title, projectId: null },
      ]);
      for (const table of [
        "tasks",
        "daily_plan_items",
        "domain_events",
        "sync_outbox",
      ])
        expect(f.count(table)).toBe(1);
    } finally {
      f.close();
    }
  });
  it("rolls back a failure after task insertion and allows retry", async () => {
    const f = fixture();
    try {
      const first = command();
      await f.store.capture(first);
      const second = { ...command(), planId: first.planId };
      await expect(f.store.capture(second)).rejects.toThrow();
      for (const table of [
        "tasks",
        "daily_plan_items",
        "domain_events",
        "sync_outbox",
      ])
        expect(f.count(table)).toBe(1);
      await f.store.capture({ ...second, planId: crypto.randomUUID() });
      expect(f.count("tasks")).toBe(2);
    } finally {
      f.close();
    }
  });
  it("rejects changed payload and invalid date without extra writes", async () => {
    const f = fixture();
    try {
      const c = command();
      await f.store.capture(c);
      await expect(
        f.store.capture({ ...c, title: "changed" }),
      ).rejects.toThrow();
      await expect(
        f.store.capture({ ...command(), executionDate: "2026-09-17" }),
      ).rejects.toThrow();
      expect(f.count("sync_outbox")).toBe(1);
    } finally {
      f.close();
    }
  });
  it("serializes simultaneous capture and read operations", async () => {
    const f = fixture();
    try {
      const c = command();
      const [, rows] = await Promise.all([
        f.store.capture(c),
        f.store.listDay(c.executionDate),
        f.store.capture(command()),
      ]);
      expect(rows).toHaveLength(1);
      expect(f.count("sync_outbox")).toBe(2);
    } finally {
      f.close();
    }
  });
});

it("runs the shared desktop/mobile storage contract", async () => {
  const f = fixture();
  try {
    for (const scenario of scenarios) {
      if (scenario.success) await f.store.capture(scenario.command);
      else await expect(f.store.capture(scenario.command)).rejects.toThrow();
      expect(
        await f.store.listDay(scenario.command.executionDate),
      ).toHaveLength(scenario.count);
      for (const table of [
        "tasks",
        "daily_plan_items",
        "domain_events",
        "sync_outbox",
      ])
        expect(f.count(table)).toBe(scenario.count);
    }
  } finally {
    f.close();
  }
});

it("maps transaction-start failure and permits a subsequent retry", async () => {
  const f = fixture(true);
  try {
    const c = command();
    await expect(f.store.capture(c)).rejects.toThrow("未能确认保存结果");
    expect(f.count("tasks")).toBe(0);
    await f.store.capture(c);
    expect(f.count("sync_outbox")).toBe(1);
  } finally {
    f.close();
  }
});
