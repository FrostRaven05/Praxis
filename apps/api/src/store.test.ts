import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CaptureStore } from "./store";
const owner = randomUUID(),
  deviceId = randomUUID();
const cmd = (extra: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  deviceId,
  id: randomUUID(),
  expectedVersion: null,
  rawText: "原文",
  deleted: false,
  ...extra,
});
it("legacy storage replays exact receipts and atomically guards CAS and tombstones", () => {
  const store = new CaptureStore(":memory:");
  try {
    const first = cmd(),
      r = store.command(owner, first);
    store.command(
      owner,
      cmd({ id: first.id, expectedVersion: 1, rawText: "新值" }),
    );
    expect(store.command(owner, first)).toEqual(r);
    expect(() => store.command(owner, { ...first, rawText: "换值" })).toThrow(
      "OPERATION_MISMATCH",
    );
    const stale = cmd({ id: first.id, expectedVersion: 1, rawText: "旧值" });
    expect(() => store.command(owner, stale)).toThrow("VERSION_CONFLICT");
    expect(
      store.command(owner, { ...stale, expectedVersion: 2 }).capture.version,
    ).toBe(3);
    store.command(
      owner,
      cmd({ id: first.id, expectedVersion: 3, deleted: true }),
    );
    for (const expectedVersion of [null, 1, 4])
      expect(() =>
        store.command(owner, cmd({ id: first.id, expectedVersion })),
      ).toThrow("DELETED_CAPTURE");
    expect(store.changes(owner, 0, 100).changes).toHaveLength(4);
  } finally {
    store.close();
  }
});
it("legacy storage receipts and owner-specific pagination survive reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-legacy-store-")),
    path = join(dir, "db.sqlite"),
    first = cmd();
  let store = new CaptureStore(path);
  try {
    const saved = store.command(owner, first);
    store.command(randomUUID(), cmd());
    store.command(owner, cmd());
    const page = store.changes(owner, 0, 1);
    expect(page.hasMore).toBe(true);
    expect(store.changes(owner, page.cursor, 1).changes).toHaveLength(1);
    store.close();
    store = new CaptureStore(path);
    expect(store.command(owner, first)).toEqual(saved);
    expect(store.changes(owner, 0, 100).changes).toHaveLength(2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
