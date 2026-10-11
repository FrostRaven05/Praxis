import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";

const ownerA = randomUUID();
const ownerB = randomUUID();
const deviceA = randomUUID();
const deviceA2 = randomUUID();
const deviceB = randomUUID();
const tokenA = "a".repeat(64);
const tokenA2 = "b".repeat(64);
const tokenB = "c".repeat(64);
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const devices = [
  { ownerId: ownerA, deviceId: deviceA, tokenHash: hash(tokenA) },
  { ownerId: ownerA, deviceId: deviceA2, tokenHash: hash(tokenA2) },
  { ownerId: ownerB, deviceId: deviceB, tokenHash: hash(tokenB) },
];
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
function setup(databasePath = ":memory:") {
  const server = createServer({ databasePath, devices });
  servers.push(server);
  return server;
}
function command(overrides: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    deviceId: deviceA,
    id: randomUUID(),
    expectedVersion: null,
    rawText: "稍后整理",
    deleted: false,
    ...overrides,
  };
}
function post(
  server: ReturnType<typeof createServer>,
  payload: Record<string, unknown>,
  token = tokenA,
) {
  return server.inject({
    method: "POST",
    url: "/v1/captures/commands",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
function changes(
  server: ReturnType<typeof createServer>,
  query = "after=0&limit=100",
  token = tokenA,
) {
  return server.inject({
    method: "GET",
    url: `/v1/captures/changes?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

it("requires a registered bearer token and rejects a forged device without writing", async () => {
  const server = setup();
  for (const request of [
    { method: "GET" as const, url: "/v1/captures/changes" },
    {
      method: "POST" as const,
      url: "/v1/captures/commands",
      payload: command(),
    },
  ]) {
    const response = await server.inject(request);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "UNAUTHORIZED" });
  }
  expect((await changes(server, undefined, "invalid-token")).statusCode).toBe(
    401,
  );
  const forged = await post(server, command({ deviceId: deviceB }));
  expect(forged.statusCode).toBe(403);
  expect(forged.json()).toEqual({ error: "DEVICE_MISMATCH" });
  expect((await changes(server)).json().changes).toEqual([]);
});

it("preserves raw Unicode and newlines, sharing captures only between the owner's devices", async () => {
  const server = setup();
  const rawText = "  中文原文 🧭\r\n第二行\n\n e\u0301 保留空格  ";
  const original = command({ rawText });
  const saved = await post(server, original);
  expect(saved.statusCode).toBe(200);
  expect(saved.json().capture).toMatchObject({
    id: original.id,
    version: 1,
    rawText,
    deleted: false,
  });
  const sibling = (await changes(server, undefined, tokenA2)).json();
  expect(sibling.changes).toHaveLength(1);
  expect(sibling.changes[0]).toMatchObject({
    deviceId: deviceA,
    operationId: original.operationId,
    capture: { rawText },
  });
  expect((await changes(server, undefined, tokenB)).json().changes).toEqual([]);

  // Another owner can use the same entity ID without overwriting this owner's copy.
  const other = await post(
    server,
    command({
      id: original.id,
      operationId: original.operationId,
      deviceId: deviceB,
      rawText: "另一账号",
    }),
    tokenB,
  );
  expect(other.statusCode).toBe(200);
  expect((await changes(server)).json().changes).toHaveLength(1);
  expect(
    (await changes(server, undefined, tokenB)).json().changes[0].capture
      .rawText,
  ).toBe("另一账号");
});

it("replays the exact original response after later edits, rejecting changed operation payloads", async () => {
  const server = setup();
  const first = command();
  const saved = await post(server, first);
  expect(saved.statusCode).toBe(200);
  const update = command({
    id: first.id,
    expectedVersion: 1,
    rawText: "已编辑",
  });
  expect((await post(server, update)).statusCode).toBe(200);
  const replay = await post(server, first);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(saved.json());
  const mismatch = await post(server, { ...first, rawText: "被替换的内容" });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json()).toEqual({ error: "OPERATION_MISMATCH" });
  expect((await changes(server)).json().changes).toHaveLength(2);
});

it("rejects stale updates atomically and leaves their operation IDs available for corrected retries", async () => {
  const server = setup();
  const first = command();
  await post(server, first);
  const winning = command({
    id: first.id,
    expectedVersion: 1,
    rawText: "另一台设备的新值",
    deviceId: deviceA2,
  });
  expect((await post(server, winning, tokenA2)).statusCode).toBe(200);
  const stale = command({
    id: first.id,
    expectedVersion: 1,
    rawText: "旧版本编辑",
  });
  const conflict = await post(server, stale);
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ error: "VERSION_CONFLICT" });
  const beforeRetry = (await changes(server)).json();
  expect(beforeRetry.changes).toHaveLength(2);
  expect(beforeRetry.changes[1].capture).toMatchObject({
    version: 2,
    rawText: winning.rawText,
  });
  const corrected = await post(server, { ...stale, expectedVersion: 2 });
  expect(corrected.statusCode).toBe(200);
  expect(corrected.json().capture.version).toBe(3);
});

it("keeps a tombstone when a disconnected device uploads an old edit or attempts resurrection", async () => {
  const server = setup();
  const first = command();
  await post(server, first);
  const deleted = command({ id: first.id, expectedVersion: 1, deleted: true });
  expect((await post(server, deleted)).statusCode).toBe(200);
  for (const expectedVersion of [null, 1, 2]) {
    const response = await post(
      server,
      command({ id: first.id, expectedVersion, rawText: "离线旧值" }),
    );
    expect(response.statusCode).toBe(409);
  }
  const result = (await changes(server)).json();
  expect(result.changes).toHaveLength(2);
  expect(result.changes[1].capture).toMatchObject({
    version: 2,
    deleted: true,
  });
});

it("paginates an owner's events safely across interleaved owners and persists receipts on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-api-test-"));
  directories.push(directory);
  const databasePath = join(directory, "sync.sqlite");
  const server = setup(databasePath);
  const originals = [command(), command(), command()];
  const initial = await post(server, originals[0]!);
  await post(server, command({ deviceId: deviceB }), tokenB);
  await post(server, originals[1]!);
  await post(server, command({ deviceId: deviceB }), tokenB);
  await post(server, originals[2]!);

  const firstPage = (await changes(server, "after=0&limit=2")).json();
  expect(firstPage.changes).toHaveLength(2);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.cursor).toBe(firstPage.changes[1].cursor);
  const secondPage = (
    await changes(server, `after=${firstPage.cursor}&limit=2`)
  ).json();
  expect(secondPage.changes).toHaveLength(1);
  expect(secondPage.hasMore).toBe(false);
  expect(
    [...firstPage.changes, ...secondPage.changes].map(
      (event) => event.capture.id,
    ),
  ).toEqual(originals.map((item) => item.id));
  const empty = (
    await changes(server, `after=${secondPage.cursor}&limit=2`)
  ).json();
  expect(empty.changes).toEqual([]);
  expect(empty.cursor).toBe(secondPage.cursor);

  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const reopened = setup(databasePath);
  expect((await post(reopened, originals[0]!)).json()).toEqual(initial.json());
  expect((await changes(reopened)).json().changes).toHaveLength(3);
});

it("rejects malformed commands and unsafe cursors without creating events", async () => {
  const server = setup();
  const invalid = [
    command({ id: "not-a-uuid" }),
    command({ operationId: "not-a-uuid" }),
    command({ expectedVersion: -1 }),
    command({ expectedVersion: 0 }),
    command({ expectedVersion: 1.5 }),
    command({ deleted: "false" }),
    command({ rawText: null }),
    command({ rawText: "" }),
    command({ rawText: " \t\r\n\u00a0\u2003\u3000" }),
    command({ rawText: "x".repeat(100_001) }),
  ];
  for (const payload of invalid) {
    const response = await post(server, payload);
    expect(response.statusCode).toBe(400);
  }
  for (const query of [
    "after=-1",
    "after=1.5",
    "after=9007199254740992",
    "after=1",
    "after=0&limit=0",
    "after=0&limit=1001",
    "after=0&limit=1.5",
  ]) {
    const response = await changes(server, query);
    expect(response.statusCode).toBe(400);
  }
  expect((await changes(server)).json().changes).toEqual([]);
});
