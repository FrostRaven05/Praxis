import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import { CaptureStore } from "./store";
import type { EntityChange } from "./entities";
const device = randomUUID(),
  second = randomUUID(),
  owner = randomUUID();
const token = "test-entities-token",
  other = "test-other-owner-token";
const servers: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
});
function setup(path = ":memory:") {
  const s = createServer({
    databasePath: path,
    devices: [
      {
        deviceId: device,
        ownerId: owner,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
      {
        deviceId: second,
        ownerId: "other",
        tokenHash: createHash("sha256").update(other).digest("hex"),
      },
    ],
  });
  servers.push(s);
  return s;
}
function change(
  kind = "task",
  data: Record<string, unknown> = { title: "Task", status: "todo" },
) {
  return {
    id: randomUUID(),
    kind,
    expectedVersion: null as number | null,
    data,
    deleted: false,
    createdAt: "2026-10-11T00:00:00Z",
  };
}
function command(changes: EntityChange[]) {
  return { operationId: randomUUID(), deviceId: device, changes };
}
async function post(s: ReturnType<typeof setup>, payload: unknown, t = token) {
  const generation = (await s.inject({ method: "GET", url: "/health" })).json()
    .generation;
  return s.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${generation}`,
    headers: { authorization: `Bearer ${t}` },
    payload: payload as object,
  });
}
function feed(s: ReturnType<typeof setup>, after = 0, limit = 25, t = token) {
  return s.inject({
    method: "GET",
    url: `/v1/entities/changes?after=${after}&limit=${limit}`,
    headers: { authorization: `Bearer ${t}` },
  });
}
it("commits related entities atomically, replays equivalent requests and isolates owners", async () => {
  const s = setup();
  const p = change("project", { title: "Project", status: "active" });
  const task = change("task", {
    title: "Task",
    status: "todo",
    projectId: p.id,
  });
  const c = command([p, task]);
  const result = await post(s, c);
  expect(result.statusCode).toBe(200);
  expect(result.json().entities).toHaveLength(2);
  expect((await post(s, JSON.parse(JSON.stringify(c)))).json()).toEqual(
    result.json(),
  );
  expect((await post(s, { ...c, changes: [p] })).statusCode).toBe(409);
  expect((await feed(s, 0, 1)).json()).toMatchObject({
    cursor: 1,
    hasMore: false,
    changes: [{ entities: result.json().entities }],
  });
  expect((await feed(s, 0, 25, other)).json().changes).toEqual([]);
  expect((await post(s, command([change()]), other)).statusCode).toBe(403);
  expect(
    (await s.inject({ method: "GET", url: "/v1/entities/changes" })).statusCode,
  ).toBe(401);
});
it("rolls back whole batch on stale same-field conflict and validates three-way bases", async () => {
  const s = setup();
  const a = change(),
    b = change();
  await post(s, command([a, b]));
  await post(
    s,
    command([
      { ...a, expectedVersion: 1, data: { ...a.data, title: "remote" } },
    ]),
  );
  const stale = {
    ...a,
    expectedVersion: 1,
    data: { ...a.data, title: "local" },
    baseData: a.data,
  };
  expect(
    (
      await post(
        s,
        command([
          {
            ...b,
            expectedVersion: 1,
            data: { ...b.data, title: "must rollback" },
          },
          stale,
        ]),
      )
    ).statusCode,
  ).toBe(409);
  expect((await feed(s)).json().cursor).toBe(2);
  const merged = await post(
    s,
    command([
      {
        ...a,
        expectedVersion: 1,
        data: { ...a.data, priority: 2 },
        baseData: a.data,
      },
    ]),
  );
  expect(merged.statusCode).toBe(200);
  expect(merged.json().entities[0]).toMatchObject({
    version: 3,
    data: { title: "remote", status: "todo", priority: 2 },
  });
  expect(
    (
      await post(
        s,
        command([
          {
            ...a,
            expectedVersion: 1,
            data: { title: "forged", status: "todo" },
            baseData: { title: "remote", status: "todo" },
          },
        ]),
      )
    ).statusCode,
  ).toBe(409);
});
it("rejects dangling references, cycles, duplicate scheduling and partial project closure", async () => {
  const s = setup();
  expect(
    (
      await post(
        s,
        command([
          change("task", {
            title: "bad",
            status: "todo",
            projectId: randomUUID(),
          }),
        ]),
      )
    ).statusCode,
  ).toBe(409);
  const p = change("project", { title: "P", status: "active" }),
    a = change(),
    b = change();
  a.data = { ...a.data, projectId: p.id, parentId: b.id };
  b.data = { ...b.data, projectId: p.id, parentId: a.id };
  expect((await post(s, command([p, a, b]))).statusCode).toBe(409);
  delete a.data.parentId;
  delete b.data.parentId;
  expect((await post(s, command([p, a, b]))).statusCode).toBe(200);
  expect(
    (
      await post(
        s,
        command([
          {
            ...p,
            expectedVersion: 1,
            data: { ...p.data, status: "completed" },
          },
        ]),
      )
    ).statusCode,
  ).toBe(409);
  const habit = change("habit", { title: "walk" });
  const check = change("habit_check", {
    habitId: habit.id,
    date: "2026-10-11",
  });
  expect(
    (await post(s, command([habit, check, { ...check, id: randomUUID() }])))
      .statusCode,
  ).toBe(409);
  expect((await feed(s)).json().cursor).toBe(1);
});
it("supports all non-AI kinds, tombstone and explicit restore, and prohibits stale resurrection", async () => {
  const s = setup();
  const task = change(),
    habit = change("habit", { title: "H" }),
    rule = change("recurrence", { title: "R", frequency: "daily" });
  const changes = [
    task,
    habit,
    rule,
    change("capture", { rawText: "hello", status: "inbox" }),
    change("record", { body: "note" }),
    change("plan", { date: "2026-10-11", taskIds: [task.id] }),
    change("habit_check", { habitId: habit.id, date: "2026-10-11" }),
    change("review", {}),
    change("view", { title: "V" }),
    change("settings", { timeZone: "Asia/Hong_Kong" }),
    change("strategy", { title: "S" }),
    change("decision", { title: "D" }),
    change("focus", {}),
    change("desktop_row", { table: "day_notes", row: { note: "abc" } }),
  ];
  expect((await post(s, command(changes))).statusCode).toBe(200);
  expect(
    (await post(s, command([{ ...task, expectedVersion: 1, deleted: true }])))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await post(
        s,
        command([{ ...task, expectedVersion: 1, baseData: task.data }]),
      )
    ).statusCode,
  ).toBe(409);
  expect(
    (await post(s, command([{ ...task, expectedVersion: 2 }]))).json()
      .entities[0],
  ).toMatchObject({ deleted: false, version: 3 });
  expect(
    (
      await post(
        s,
        command([
          change("desktop_row", {
            table: "local_profile",
            row: { token: "no" },
          }),
        ]),
      )
    ).statusCode,
  ).toBe(409);
});
it("migrates legacy captures once preserving identity/version and survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-full-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const old = new CaptureStore(path);
  const id = randomUUID();
  old.command(owner, {
    operationId: randomUUID(),
    deviceId: device,
    id,
    expectedVersion: null,
    rawText: "old",
    deleted: false,
  });
  old.command(owner, {
    operationId: randomUUID(),
    deviceId: device,
    id,
    expectedVersion: 1,
    rawText: "updated",
    deleted: false,
  });
  old.close();
  const s = setup(path);
  expect((await feed(s)).json().changes[0].entities[0]).toMatchObject({
    id,
    version: 2,
    data: { rawText: "updated" },
  });
  const c = command([change()]);
  const r = await post(s, c);
  expect(r.statusCode).toBe(200);
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  const reopened = setup(path);
  expect((await post(reopened, c)).json()).toMatchObject({
    entities: r.json().entities,
    cursor: r.json().cursor,
  });
  expect((await feed(reopened)).json().cursor).toBe(2);
  const legacy = await reopened.inject({
    method: "POST",
    url: "/v1/captures/commands",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      operationId: randomUUID(),
      deviceId: device,
      id,
      expectedVersion: 2,
      rawText: "legacy overwrite",
      deleted: false,
    },
  });
  expect(legacy.statusCode).toBe(409);
  expect(legacy.json().error).toBe("PROTOCOL_UPGRADED");
});
it("validates malformed envelopes and never advances cursor on rejected requests", async () => {
  const s = setup();
  for (const payload of [
    command([]),
    command([change("ai_prompt", {})]),
    command([{ ...change(), createdAt: "invalid" }]),
    { ...command([change()]), extra: true },
    command([{ ...change(), expectedVersion: -1 }]),
  ])
    expect((await post(s, payload)).statusCode).toBe(400);
  expect((await feed(s, 1)).statusCode).toBe(400);
  expect((await feed(s)).json().cursor).toBe(0);
});

it("paginates whole batches and validates desktop dependency and foreign-key graphs", async () => {
  const s = setup();
  const p = change("project", {
    title: "P",
    status: "active",
    desktop: { status: "paused" },
  });
  const a = change("task", {
      title: "A",
      status: "todo",
      waiting: true,
      projectId: p.id,
    }),
    b = change("task", { title: "B", status: "todo", projectId: p.id });
  expect((await post(s, command([p, a, b]))).statusCode).toBe(200);
  const edge = change("desktop_row", {
    table: "task_dependencies",
    row: { task_id: a.id, predecessor_id: b.id },
  });
  expect((await post(s, command([edge]))).statusCode).toBe(200);
  expect(
    (
      await post(
        s,
        command([
          change("desktop_row", {
            table: "task_dependencies",
            row: { task_id: b.id, predecessor_id: a.id },
          }),
        ]),
      )
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await post(
        s,
        command([
          change("desktop_row", {
            table: "daily_plan_items",
            row: { id: randomUUID(), task_id: randomUUID() },
          }),
        ]),
      )
    ).statusCode,
  ).toBe(409);
  const first = (await feed(s, 0, 1)).json();
  expect(first).toMatchObject({ cursor: 1, hasMore: true });
  expect(first.changes[0].entities).toHaveLength(3);
  expect((await feed(s, first.cursor, 1)).json()).toMatchObject({
    cursor: 2,
    hasMore: false,
  });
});
it("keeps clarification local audit version metadata independent of remote sync version", async () => {
  const s = setup();
  const capture = change("capture", {
      rawText: "capture",
      status: "clarified",
    }),
    task = change("task", {
      title: "derived",
      status: "todo",
      sourceCaptureId: capture.id,
    });
  capture.data.outputs = [{ id: task.id, kind: "task", version: 10 }];
  expect((await post(s, command([capture, task]))).statusCode).toBe(200);
});

it("rejects writes across backend restart and serves a consistent paginated recovery snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-generation-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const first = setup(path);
  const a = change(),
    b = change();
  await post(first, command([a, b]));
  const oldGeneration = (
    await first.inject({ method: "GET", url: "/health" })
  ).json().generation;
  const auth = { authorization: `Bearer ${token}` };
  const page = (
    await first.inject({
      method: "GET",
      url: "/v1/entities/snapshot?limit=1",
      headers: auth,
    })
  ).json();
  expect(page).toMatchObject({
    cursor: 1,
    hasMore: true,
    generation: oldGeneration,
  });
  await post(
    first,
    command([
      { ...b, expectedVersion: 1, data: { ...b.data, title: "later" } },
    ]),
  );
  const tail = (
    await first.inject({
      method: "GET",
      url: `/v1/entities/snapshot?at=${page.cursor}&afterId=${page.nextId}&limit=1&generation=${oldGeneration}`,
      headers: auth,
    })
  ).json();
  expect(tail.cursor).toBe(1);
  expect(
    [...page.entities, ...tail.entities].every((e) => e.version === 1),
  ).toBe(true);
  await first.close();
  servers.splice(servers.indexOf(first), 1);
  const restarted = setup(path);
  const generation = (
    await restarted.inject({ method: "GET", url: "/health" })
  ).json().generation;
  expect(generation).not.toBe(oldGeneration);
  const stale = await restarted.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${oldGeneration}`,
    headers: auth,
    payload: command([change()]),
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toBe("GENERATION_CHANGED");
  expect(
    (
      await restarted.inject({
        method: "POST",
        url: "/v1/entities/commands",
        headers: auth,
        payload: command([change()]),
      })
    ).statusCode,
  ).toBe(428);
  expect(
    (
      await restarted.inject({
        method: "GET",
        url: `/v1/entities/snapshot?generation=${oldGeneration}`,
        headers: auth,
      })
    ).statusCode,
  ).toBe(409);
  const restored = (
    await restarted.inject({
      method: "GET",
      url: "/v1/entities/snapshot",
      headers: auth,
    })
  ).json();
  expect(restored).toMatchObject({ cursor: 2, generation, hasMore: false });
  expect(
    restored.entities.find((e: { id: string }) => e.id === b.id).data.title,
  ).toBe("later");
  expect(
    (
      await restarted.inject({
        method: "GET",
        url: "/v1/entities/snapshot",
        headers: { authorization: `Bearer ${other}` },
      })
    ).json().entities,
  ).toEqual([]);
});

it("restores an actual backend backup and exposes a new generation plus the consistent old graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-restore-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite"),
    backup = join(dir, "backup.sqlite");
  let s = setup(path);
  const task = change();
  await post(s, command([task]));
  const generation = (await s.inject({ method: "GET", url: "/health" })).json()
    .generation;
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  await copyFile(path, backup);
  s = setup(path);
  await post(
    s,
    command([
      {
        ...task,
        expectedVersion: 1,
        data: { ...task.data, title: "after backup" },
      },
    ]),
  );
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  await copyFile(backup, path);
  s = setup(path);
  expect((await feed(s, 2)).statusCode).toBe(400);
  const restored = (
    await s.inject({
      method: "GET",
      url: "/v1/entities/snapshot",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  expect(restored.cursor).toBe(1);
  expect(restored.generation).not.toBe(generation);
  expect(restored.entities[0]).toMatchObject({
    id: task.id,
    version: 1,
    data: task.data,
  });
});
