import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MobileStorage, CaptureRejectedError, type Connection } from "./index";
import { initialStatements, captureStatements } from "./migration";

it("preserves independent original text, editing and pending operations across database restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-captures-"));
  const path = join(dir, "mobile.db");
  let db = new DatabaseSync(path);
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
  try {
    for (const sql of initialStatements) db.exec(sql);
    const storage = new MobileStorage(async () => connection);
    await storage.capture({
      operationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      planId: crypto.randomUUID(),
      title: "旧每日任务",
      executionDate: "2026-10-09",
      timeZone: "UTC",
      occurredAt: "2026-10-09T12:00:00.000Z",
    });
    for (const sql of captureStatements) db.exec(sql);
    const c = {
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      expectedVersion: null,
      rawText: "  中文原文\n 第二行  ",
      occurredAt: "2026-10-09T12:00:00.000Z",
    };
    await storage.saveCapture(c);
    await storage.saveCapture(c);
    expect(await storage.listCaptures()).toMatchObject([
      { rawText: c.rawText, version: 1 },
    ]);
    expect(await storage.captureQueueCount()).toBe(1);
    const edit = {
      ...c,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      rawText: "编辑后\n原文",
    };
    await storage.saveCapture(edit);
    db.close();
    db = new DatabaseSync(path);
    expect(await storage.listCaptures()).toMatchObject([
      { rawText: edit.rawText, version: 2 },
    ]);
    expect(await storage.listDay("2026-10-09")).toHaveLength(1);
    expect(await storage.captureQueueCount()).toBe(2);
    await expect(
      storage.saveCapture({
        ...edit,
        operationId: crypto.randomUUID(),
        rawText: "过期覆盖",
      }),
    ).rejects.toBeInstanceOf(CaptureRejectedError);
    expect(await storage.listCaptures()).toMatchObject([
      { rawText: edit.rawText, version: 2 },
    ]);
    expect(await storage.captureQueueCount()).toBe(2);
    await expect(
      storage.saveCapture({
        ...c,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        rawText: "字".repeat(100_001),
      }),
    ).rejects.toBeInstanceOf(CaptureRejectedError);
    expect(await storage.captureQueueCount()).toBe(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

it("rolls back a failed queue write and safely replays an unacknowledged commit", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of [...initialStatements, ...captureStatements]) db.exec(sql);
  let failQueue = true;
  let loseAcknowledgement = false;
  const connection: Connection = {
    async query(sql, values = []) {
      return {
        values: db.prepare(sql).all(...(values as (string | number | null)[])),
      };
    },
    async run(sql, values = []) {
      if (failQueue && sql.startsWith("INSERT INTO sync_outbox")) {
        failQueue = false;
        throw new Error("simulated full storage");
      }
      db.prepare(sql).run(...(values as (string | number | null)[]));
    },
    async beginTransaction() {
      db.exec("BEGIN");
    },
    async commitTransaction() {
      db.exec("COMMIT");
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("simulated lost response");
      }
    },
    async rollbackTransaction() {
      db.exec("ROLLBACK");
    },
  };
  const storage = new MobileStorage(async () => connection);
  const c = {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedVersion: null,
    rawText: "失败后原文",
    occurredAt: "2026-10-09T12:00:00Z",
  };
  try {
    await expect(storage.saveCapture(c)).rejects.toThrow("未能确认保存");
    expect(await storage.listCaptures()).toEqual([]);
    expect(await storage.captureQueueCount()).toBe(0);
    loseAcknowledgement = true;
    await expect(storage.saveCapture(c)).rejects.toThrow("未能确认保存");
    await storage.saveCapture(c);
    expect(await storage.listCaptures()).toMatchObject([
      { id: c.id, rawText: c.rawText, version: 1 },
    ]);
    expect(await storage.captureQueueCount()).toBe(1);
    await expect(
      storage.saveCapture({ ...c, rawText: "另一个内容" }),
    ).rejects.toThrow();
    expect(await storage.listCaptures()).toMatchObject([
      { rawText: c.rawText, version: 1 },
    ]);
    expect(await storage.captureQueueCount()).toBe(1);
  } finally {
    db.close();
  }
});
