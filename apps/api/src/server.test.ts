import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import { CaptureStore } from "./store";
const ownerA = randomUUID(),
  ownerB = randomUUID(),
  deviceA = randomUUID(),
  deviceB = randomUUID();
const tokenA = "a".repeat(64),
  tokenB = "b".repeat(64);
const devices = [
  {
    ownerId: ownerA,
    deviceId: deviceA,
    tokenHash: createHash("sha256").update(tokenA).digest("hex"),
  },
  {
    ownerId: ownerB,
    deviceId: deviceB,
    tokenHash: createHash("sha256").update(tokenB).digest("hex"),
  },
];
const servers: ReturnType<typeof createServer>[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
function setup(databasePath = ":memory:") {
  const s = createServer({ databasePath, devices });
  servers.push(s);
  return s;
}
const command = (overrides: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  deviceId: deviceA,
  id: randomUUID(),
  expectedVersion: null,
  rawText: "稍后整理",
  deleted: false,
  ...overrides,
});
const post = (
  s: ReturnType<typeof createServer>,
  payload: Record<string, unknown>,
  token = tokenA,
) =>
  s.inject({
    method: "POST",
    url: "/v1/captures/commands",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
const feed = (
  s: ReturnType<typeof createServer>,
  query = "after=0&limit=100",
  token = tokenA,
) =>
  s.inject({
    method: "GET",
    url: `/v1/captures/changes?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
it("requires registered tokens and rejects forged device identities even on deprecated writes", async () => {
  const s = setup();
  expect(
    (
      await s.inject({
        method: "POST",
        url: "/v1/captures/commands",
        payload: command(),
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await s.inject({ method: "GET", url: "/v1/captures/changes" })).statusCode,
  ).toBe(401);
  expect((await feed(s, undefined, "wrong")).statusCode).toBe(401);
  expect((await post(s, command({ deviceId: deviceB }))).statusCode).toBe(403);
  expect((await feed(s)).json().changes).toEqual([]);
});
it("rejects legacy writers immediately after startup for every owner before any entity command", async () => {
  const s = setup();
  for (const [device, token] of [
    [deviceA, tokenA],
    [deviceB, tokenB],
  ]) {
    const r = await post(s, command({ deviceId: device }), token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("PROTOCOL_UPGRADED");
    expect((await feed(s, undefined, token)).json().changes).toEqual([]);
  }
});
it("keeps owner-isolated legacy Unicode history readable and seeds the latest version without later legacy writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-legacy-migrate-"));
  directories.push(dir);
  const path = join(dir, "db.sqlite"),
    old = new CaptureStore(path),
    first = command({ rawText: "  中文 🧭\r\n e\u0301  " });
  old.command(ownerA, first);
  old.command(
    ownerA,
    command({ id: first.id, expectedVersion: 1, rawText: "最新原文" }),
  );
  old.command(
    ownerB,
    command({ id: first.id, deviceId: deviceB, rawText: "另一账号" }),
  );
  old.close();
  const s = setup(path),
    a = (await feed(s)).json(),
    b = (await feed(s, undefined, tokenB)).json();
  expect(a.changes).toHaveLength(2);
  expect(a.changes[0].capture.rawText).toBe(first.rawText);
  expect(a.changes[1].capture.version).toBe(2);
  expect(b.changes[0].capture.rawText).toBe("另一账号");
  const entityFeed = (
    await s.inject({
      method: "GET",
      url: "/v1/entities/changes",
      headers: { authorization: `Bearer ${tokenA}` },
    })
  ).json();
  expect(entityFeed.changes[0].entities[0]).toMatchObject({
    id: first.id,
    version: 2,
    data: { rawText: "最新原文" },
  });
  const rejected = await post(
    s,
    command({ id: first.id, expectedVersion: 2, rawText: "升级竞态写入" }),
  );
  expect(rejected.statusCode).toBe(409);
  expect((await feed(s)).json().changes).toHaveLength(2);
  const firstPage = (await feed(s, "after=0&limit=1")).json();
  expect(firstPage.hasMore).toBe(true);
  expect(
    (await feed(s, `after=${firstPage.cursor}&limit=1`)).json().changes,
  ).toHaveLength(1);
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  const reopened = setup(path);
  expect((await feed(reopened)).json()).toEqual(a);
  expect((await post(reopened, first)).json().error).toBe("PROTOCOL_UPGRADED");
});
it("validates malformed legacy requests and unsafe cursors without mutation", async () => {
  const s = setup();
  for (const payload of [
    command({ id: "bad" }),
    command({ expectedVersion: -1 }),
    command({ expectedVersion: 0 }),
    command({ deleted: "false" }),
    command({ rawText: null }),
    command({ rawText: " \t\r\n" }),
    command({ rawText: "x".repeat(100001) }),
  ])
    expect((await post(s, payload)).statusCode).toBe(400);
  for (const query of [
    "after=-1",
    "after=1.5",
    "after=9007199254740992",
    "after=1",
    "limit=0",
    "limit=1001",
    "limit=1.5",
  ])
    expect((await feed(s, query)).statusCode).toBe(400);
  expect((await feed(s)).json().changes).toEqual([]);
});
