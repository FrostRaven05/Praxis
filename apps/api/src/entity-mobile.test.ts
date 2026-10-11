import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import {
  MobileStorage,
  type Connection,
  type WorkspaceKind,
} from "../../../packages/storage-mobile/src/index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "../../../packages/storage-mobile/src/migration";
const databases: DatabaseSync[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const db of databases.splice(0)) db.close();
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
async function setup(databasePath = ":memory:") {
  const owner = randomUUID();
  const clients = await Promise.all(
    [0, 1].map(async () => {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      for (const sql of [
        ...initialStatements,
        ...captureStatements,
        ...workspaceStatements,
        ...lanStatements,
        ...entitySyncStatements,
      ])
        db.exec(sql);
      const connection: Connection = {
        async query(sql, args = []) {
          return {
            values: db
              .prepare(sql)
              .all(...(args as (string | number | null)[])),
          };
        },
        async run(sql, args = [], transaction = true) {
          if (transaction) db.exec("BEGIN");
          try {
            db.prepare(sql).run(...(args as (string | number | null)[]));
            if (transaction) db.exec("COMMIT");
          } catch (e) {
            if (transaction) db.exec("ROLLBACK");
            throw e;
          }
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
      const storage = new MobileStorage(async () => connection),
        deviceId = randomUUID(),
        token = randomUUID();
      await storage.lanBind({
        baseUrl: "https://lan.test:4318",
        ownerId: owner,
        deviceId,
        workspaceId: "local",
      });
      return { db, storage, deviceId, token };
    }),
  );
  const options = {
    databasePath,
    devices: clients.map((c) => ({
      ownerId: owner,
      deviceId: c.deviceId,
      tokenHash: createHash("sha256").update(c.token).digest("hex"),
    })),
  };
  let server = createServer(options);
  servers.push(server);
  async function pull(client: (typeof clients)[number]) {
    const r = await server.inject({
      method: "GET",
      url: `/v1/entities/changes?after=${(await client.storage.entityState()).cursor}&limit=25`,
      headers: { authorization: `Bearer ${client.token}` },
    });
    expect(r.statusCode).toBe(200);
    await client.storage.entityPull(r.json());
  }
  async function push(client: (typeof clients)[number]) {
    const c = await client.storage.entityPrepare();
    if (!c) return null;
    const r = await server.inject({
      method: "POST",
      url: `/v1/entities/commands?generation=${(await server.inject({ method: "GET", url: "/health" })).json().generation}`,
      headers: { authorization: `Bearer ${client.token}` },
      payload: c,
    });
    if (r.statusCode === 200)
      await client.storage.entityAck(c, r.json().entities);
    return r;
  }
  async function drain(client: (typeof clients)[number]) {
    for (let i = 0; i < 30; i++) {
      const result = await push(client);
      if (!result) return;
      expect(result.statusCode, result.body).toBe(200);
    }
    throw Error("Queue did not converge");
  }
  async function restart() {
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    server = createServer(options);
    servers.push(server);
    return server;
  }
  return { a: clients[0]!, b: clients[1]!, pull, push, drain, server, restart };
}
function c(kind: WorkspaceKind, data: Record<string, unknown>) {
  return {
    id: String(randomUUID()),
    kind,
    data,
    expectedVersion: null as number | null,
  };
}
it("synchronizes nested task trees and rejects an ancestor cycle atomically", async () => {
  const { a, b, drain, pull, server } = await setup();
  const p = c("project", { title: "Tree project", status: "active" });
  const section = c("section", { title: "Tree section", projectId: p.id });
  const root = c("task", {
    title: "Root",
    status: "todo",
    projectId: p.id,
    sectionId: section.id,
  });
  const child = c("task", {
    title: "Child",
    status: "todo",
    projectId: p.id,
    sectionId: section.id,
    parentId: root.id,
  });
  const grandchild = c("task", {
    title: "Grandchild",
    status: "todo",
    projectId: p.id,
    sectionId: section.id,
    parentId: child.id,
  });
  await save(a.storage, [grandchild, section, child, p, root]);
  await drain(a);
  await pull(a);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities.find(
      (e) => e.id === grandchild.id,
    )?.data,
  ).toMatchObject({
    parentId: child.id,
    projectId: p.id,
    sectionId: section.id,
  });
  await edit(b.storage, grandchild.id, { title: "Edited grandchild" });
  await drain(b);
  await pull(a);
  expect(
    (await a.storage.workspaceSnapshot()).entities.find(
      (e) => e.id === grandchild.id,
    )?.data.title,
  ).toBe("Edited grandchild");
  const state = (await a.storage.workspaceSnapshot()).entities.find(
    (e) => e.id === root.id,
  )!;
  await expect(
    edit(a.storage, root.id, { parentId: grandchild.id }),
  ).rejects.toThrow("循环");
  const result = await server.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${(await server.inject({ method: "GET", url: "/health" })).json().generation}`,
    headers: { authorization: `Bearer ${a.token}` },
    payload: {
      operationId: randomUUID(),
      deviceId: a.deviceId,
      changes: [
        {
          id: root.id,
          kind: "task",
          expectedVersion: state.version,
          data: { ...state.data, parentId: grandchild.id },
          deleted: false,
          createdAt: state.createdAt,
        },
      ],
    },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().error).toBe("INVALID_GRAPH");
  // Supporting deep trees does not relax identity, placement or live-parent checks.
  for (const invalid of [
    { data: { ...state.data, parentId: root.id } },
    { data: { ...state.data, projectId: null, sectionId: null } },
    { data: { ...state.data, sectionId: null } },
    { data: { ...state.data, parentId: randomUUID() } },
    { data: state.data, deleted: true },
  ]) {
    const rejected = await server.inject({
      method: "POST",
      url: `/v1/entities/commands?generation=${(await server.inject({ method: "GET", url: "/health" })).json().generation}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: {
        operationId: randomUUID(),
        deviceId: a.deviceId,
        changes: [
          {
            id: root.id,
            kind: "task",
            expectedVersion: state.version,
            createdAt: state.createdAt,
            deleted: false,
            ...invalid,
          },
        ],
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe("INVALID_GRAPH");
  }
  const exported = JSON.parse(await a.storage.workspaceExport());
  for (const patch of [
    { parentId: child.id },
    { parentId: randomUUID() },
    { projectId: null, sectionId: null },
    { sectionId: null },
  ]) {
    const damaged = structuredClone(exported);
    const task = damaged.entities.find(
      (e: { id: string }) => e.id === child.id,
    );
    task.data = { ...task.data, ...patch };
    await expect(
      a.storage.workspaceImport(JSON.stringify(damaged), randomUUID()),
    ).rejects.toThrow();
  }
  expect(await a.storage.workspaceList()).toHaveLength(1);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities.find((e) => e.id === root.id)
      ?.data.parentId ?? null,
  ).toBeNull();
});
async function save(storage: MobileStorage, changes: ReturnType<typeof c>[]) {
  await storage.workspaceCommand({
    operationId: randomUUID(),
    occurredAt: "2026-10-11T00:00:00Z",
    changes,
  });
}
async function edit(
  storage: MobileStorage,
  id: string,
  patch: Record<string, unknown>,
) {
  const e = (await storage.workspaceSnapshot()).entities.find(
    (e) => e.id === id,
  )!;
  await save(storage, [
    {
      id,
      kind: e.kind,
      expectedVersion: e.version,
      data: { ...e.data, ...patch },
    },
  ]);
}
it("synchronizes a real mobile project/task/plan graph and merges disconnected independent changes through API", async () => {
  const { a, b, pull, push } = await setup();
  const p = c("project", { title: "P", status: "active" }),
    task = c("task", {
      title: "T",
      status: "todo",
      projectId: p.id,
      priority: 0,
    }),
    plan = c("plan", { date: "2026-10-11", taskIds: [task.id] });
  await save(a.storage, [p, task, plan]);
  expect((await push(a))?.statusCode).toBe(200);
  await pull(a);
  await pull(b);
  expect((await b.storage.workspaceSnapshot()).entities).toHaveLength(3);
  await edit(a.storage, task.id, { title: "offline A" });
  await edit(b.storage, task.id, { priority: 2 });
  expect((await push(b))?.statusCode).toBe(200);
  expect((await push(a))?.statusCode).toBe(200);
  await pull(a);
  await pull(b);
  for (const client of [a, b]) {
    expect(
      (await client.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === task.id,
      )?.data,
    ).toMatchObject({ title: "offline A", priority: 2 });
    expect((await client.storage.entityState()).conflicts).toHaveLength(0);
    expect(await client.storage.entityPrepare()).toBeNull();
  }
});
it("keeps same-field conflict durable, resolves with guarded local revision and converges both clients", async () => {
  const { a, b, pull, push } = await setup();
  const task = c("task", { title: "T", status: "todo" });
  await save(a.storage, [task]);
  await push(a);
  await pull(a);
  await pull(b);
  await edit(a.storage, task.id, { title: "A" });
  await edit(b.storage, task.id, { title: "B" });
  await push(b);
  expect((await push(a))?.statusCode).toBe(409);
  await a.storage.entityReject();
  await pull(a);
  const conflict = (await a.storage.entityState()).conflicts[0]!;
  expect(conflict.local[0]?.data.title).toBe("A");
  expect(conflict.batch.entities[0]?.data.title).toBe("B");
  await a.storage.entityResolve(
    conflict.operationId,
    true,
    conflict.expected,
    randomUUID(),
  );
  expect((await push(a))?.statusCode).toBe(200);
  await pull(a);
  await pull(b);
  expect((await b.storage.workspaceSnapshot()).entities[0]?.data.title).toBe(
    "A",
  );
});
it("roundtrips every domain kind through the actual server validator", async () => {
  const { a, b, pull, drain } = await setup();
  const p = c("project", { title: "P", status: "active" }),
    h = c("habit", { title: "H" }),
    rec = c("recurrence", { title: "R", frequency: "daily" }),
    task = c("task", { title: "T", status: "todo", projectId: p.id });
  const all = [
    p,
    h,
    rec,
    task,
    c("section", { title: "Section", projectId: p.id }),
    c("capture", { rawText: "raw", status: "inbox" }),
    c("record", { body: "note" }),
    c("plan", { date: "2026-10-11", taskIds: [task.id] }),
    c("habit_check", { habitId: h.id, date: "2026-10-11", count: 1 }),
    c("review", { date: "2026-10-11" }),
    c("view", { title: "View" }),
    c("settings", { timeZone: "Asia/Hong_Kong" }),
    c("strategy", { title: "Strategy" }),
    c("decision", { title: "Decision" }),
    c("focus", { taskId: task.id, elapsedSeconds: 5 }),
    c("desktop_row", {
      table: "day_notes",
      row: { date: "2026-10-11", outcome: "completed" },
    }),
  ];
  await save(a.storage, all);
  await drain(a);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities.map((e) => e.kind).sort(),
  ).toEqual(all.map((e) => e.kind).sort());
  expect(await b.storage.entityPrepare()).toBeNull();
});
it("initial migration uploads local tombstones without blocking unrelated live entities and guards resurrection", async () => {
  const { a, b, pull, drain, server } = await setup();
  const removed = c("task", {
      title: "Deleted before pairing",
      status: "todo",
    }),
    live = c("project", { title: "Live migration", status: "active" });
  await save(a.storage, [removed, live]);
  const before = (await a.storage.workspaceSnapshot()).entities.find(
    (e) => e.id === removed.id,
  )!;
  await a.storage.workspaceCommand({
    operationId: randomUUID(),
    occurredAt: "2026-10-11T00:00:01Z",
    changes: [
      {
        id: removed.id,
        kind: "task",
        expectedVersion: before.version,
        data: before.data,
        deleted: true,
      },
    ],
  });
  await drain(a);
  await pull(a);
  await pull(b);
  expect(await a.storage.entityPrepare()).toBeNull();
  const migrated = (await b.storage.workspaceSnapshot()).entities;
  expect(migrated.find((e) => e.id === removed.id)?.deleted).toBe(true);
  expect(migrated.find((e) => e.id === live.id)?.deleted).toBe(false);
  const stale = await server.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${(await server.inject({ method: "GET", url: "/health" })).json().generation}`,
    headers: { authorization: `Bearer ${b.token}` },
    payload: {
      operationId: randomUUID(),
      deviceId: b.deviceId,
      changes: [
        { ...removed, deleted: false, createdAt: "2026-10-11T00:00:00Z" },
      ],
    },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toBe("VERSION_CONFLICT");
});
it("keeps API and mobile canonical state and habit-target validation compatible", async () => {
  const { a, server } = await setup();
  const generation = (
    await server.inject({ method: "GET", url: "/health" })
  ).json().generation;
  for (const entry of [
    c("habit", { title: "H", target: 8 }),
    c("habit", {
      title: "H",
      ruleHistory: [
        { effectiveDate: "2026-10-11", frequency: "weekly", target: 8 },
      ],
    }),
    c("task", { title: "T", status: "waiting" }),
    c("project", { title: "P", status: "paused" }),
    c("task", { title: "T", status: "todo", estimatedMinutes: 0 }),
    c("task", { title: "T", status: "todo", estimatedMinutes: 1441 }),
  ]) {
    await expect(save(a.storage, [entry])).rejects.toThrow();
    const result = await server.inject({
      method: "POST",
      url: `/v1/entities/commands?generation=${generation}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: {
        operationId: randomUUID(),
        deviceId: a.deviceId,
        changes: [
          { ...entry, deleted: false, createdAt: "2026-10-11T00:00:00Z" },
        ],
      },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe("INVALID_GRAPH");
  }
});
it("refuses two live workspace settings in both clients without silently deleting either", async () => {
  const { a, server } = await setup();
  const entries = [
    c("settings", { timeZone: "Asia/Hong_Kong" }),
    c("settings", { timeZone: "UTC" }),
  ];
  await expect(save(a.storage, entries)).rejects.toThrow("一份");
  expect((await a.storage.workspaceSnapshot()).entities).toEqual([]);
  const result = await server.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${(await server.inject({ method: "GET", url: "/health" })).json().generation}`,
    headers: { authorization: `Bearer ${a.token}` },
    payload: {
      operationId: randomUUID(),
      deviceId: a.deviceId,
      changes: entries.map((e) => ({
        ...e,
        deleted: false,
        createdAt: "2026-10-11T00:00:00Z",
      })),
    },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().error).toBe("INVALID_GRAPH");
});
it("merges native default materialization with an offline mobile note without hiding custom-field conflicts", async () => {
  const { a, b, pull, push } = await setup();
  const task = c("task", { title: "Created mobile", status: "todo" });
  await save(a.storage, [task]);
  await push(a);
  await pull(a);
  await pull(b);
  await edit(a.storage, task.id, {
    notes: "Offline note",
    estimatedMinutes: 15,
  });
  await edit(b.storage, task.id, {
    title: "Desktop title",
    notes: "",
    completionCriteria: "",
    waiting: false,
    priority: 0,
    projectId: null,
    estimatedMinutes: null,
  });
  await push(b);
  await pull(a);
  expect((await a.storage.entityState()).conflicts).toHaveLength(0);
  expect(
    (await a.storage.workspaceSnapshot()).entities.find((e) => e.id === task.id)
      ?.data,
  ).toMatchObject({
    title: "Desktop title",
    notes: "Offline note",
    estimatedMinutes: 15,
  });
  expect((await push(a))?.statusCode).toBe(200);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities.find((e) => e.id === task.id)
      ?.data.notes,
  ).toBe("Offline note");
  // Exercise server-side stale CAS merge separately, with the native default
  // newly materialized on the winning revision before the mobile note uploads.
  const next = c("task", { title: "Second", status: "todo" });
  await save(a.storage, [next]);
  await push(a);
  await pull(a);
  await pull(b);
  await edit(a.storage, next.id, { notes: "Server merge offline" });
  await edit(b.storage, next.id, { title: "Native defaults", notes: "" });
  await push(b);
  expect((await push(a))?.statusCode).toBe(200);
  await pull(a);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities.find((e) => e.id === next.id)
      ?.data,
  ).toMatchObject({ title: "Native defaults", notes: "Server merge offline" });
  await edit(a.storage, next.id, { custom: "Local custom" });
  await edit(b.storage, next.id, { custom: "" });
  await push(b);
  expect((await push(a))?.statusCode).toBe(409);
});
it("isolates a real restart snapshot conflict while another project's remote changes and local creations keep syncing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxis-components-restart-"));
  directories.push(dir);
  const { a, b, pull, drain, restart } = await setup(join(dir, "db.sqlite"));
  const pa = c("project", { title: "A project", status: "active" }),
    pb = c("project", { title: "B project", status: "active" }),
    ta = c("task", { title: "A initial", status: "todo", projectId: pa.id }),
    tb = c("task", { title: "B initial", status: "todo", projectId: pb.id });
  await save(a.storage, [pa, pb, ta, tb]);
  await drain(a);
  await pull(a);
  await pull(b);
  const oldGeneration = (await a.storage.entityState()).generation;
  await edit(a.storage, ta.id, { title: "A offline local" });
  await edit(a.storage, tb.id, { notes: "B offline note" });
  const extra = c("task", {
    title: "B new offline task",
    status: "todo",
    projectId: pb.id,
  });
  await save(a.storage, [extra]);
  await edit(b.storage, ta.id, { title: "A remote title" });
  await edit(b.storage, tb.id, { title: "B remote title" });
  await drain(b);
  const server = await restart();
  const snapshot = async (token: string) => {
    const r = await server.inject({
      method: "GET",
      url: "/v1/entities/snapshot?limit=100",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  const staged = await snapshot(a.token);
  expect(staged.generation).not.toBe(oldGeneration);
  await a.storage.entityRebase(
    staged.entities,
    staged.cursor,
    staged.generation,
  );
  const state = await a.storage.entityState();
  expect(state.cursor).toBe(staged.cursor);
  expect(state.generation).toBe(staged.generation);
  expect(state.conflicts).toHaveLength(1);
  expect(state.conflicts[0]?.batch.entities.map((e) => e.id).sort()).toEqual(
    [pa.id, ta.id].sort(),
  );
  expect(
    state.conflicts[0]?.local.find((e) => e.id === ta.id)?.data.title,
  ).toBe("A offline local");
  expect(
    state.conflicts[0]?.batch.entities.find((e) => e.id === ta.id)?.data.title,
  ).toBe("A remote title");
  const prepared = (await a.storage.entityPrepare())!;
  expect(prepared.changes.map((c) => c.id).sort()).toEqual(
    [tb.id, extra.id].sort(),
  );
  expect(prepared.changes.find((c) => c.id === tb.id)?.data).toMatchObject({
    title: "B remote title",
    notes: "B offline note",
  });
  await drain(a);
  const updated = await snapshot(b.token);
  await b.storage.entityRebase(
    updated.entities,
    updated.cursor,
    updated.generation,
  );
  expect(
    (await b.storage.workspaceSnapshot()).entities.find((e) => e.id === tb.id)
      ?.data,
  ).toMatchObject({ title: "B remote title", notes: "B offline note" });
  expect(
    (await b.storage.workspaceSnapshot()).entities.find(
      (e) => e.id === extra.id,
    )?.data.title,
  ).toBe("B new offline task");
  expect((await a.storage.entityState()).conflicts).toHaveLength(1);
});
it("merges structured weekly-review fields independently and regenerates its derived body on both sides", async () => {
  const { a, b, pull, push } = await setup();
  const fields = {
    title: "Review",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    achievements: "Initial",
    blockers: "",
    stopPause: "",
    nextFocus: "",
  };
  const review = c("review", {
    ...fields,
    body: "incorrect derived body",
    desktop: { body: "incorrect native body", extension: "retained" },
  });
  await save(a.storage, [review]);
  expect((await push(a))?.statusCode).toBe(200);
  await pull(a);
  await pull(b);
  expect(
    (await a.storage.workspaceSnapshot()).entities[0]?.data.body,
  ).toContain("推进成果\nInitial");
  await edit(a.storage, review.id, {
    achievements: "Phone results",
    desktop: { body: "A derived body", extension: "retained" },
  });
  await edit(b.storage, review.id, {
    blockers: "Desktop blocker",
    desktop: { body: "B derived body", extension: "retained" },
  });
  await push(b);
  await pull(a);
  expect((await a.storage.entityState()).conflicts).toHaveLength(0);
  expect((await a.storage.workspaceSnapshot()).entities[0]?.data).toMatchObject(
    { achievements: "Phone results", blockers: "Desktop blocker" },
  );
  expect(
    (await a.storage.workspaceSnapshot()).entities[0]?.data.body,
  ).toContain("推进成果\nPhone results\n\n阻塞\nDesktop blocker");
  const combined = (await a.storage.workspaceSnapshot()).entities[0]!.data;
  expect(combined.desktop).toMatchObject({
    body: combined.body,
    extension: "retained",
  });
  await push(a);
  await pull(a);
  await pull(b);
  await edit(a.storage, review.id, {
    stopPause: "Phone stops",
    desktop: { body: "A newer body", extension: "retained" },
  });
  await edit(b.storage, review.id, {
    nextFocus: "Desktop next",
    desktop: { body: "B newer body", extension: "retained" },
  });
  await push(b);
  expect((await push(a))?.statusCode).toBe(200);
  await pull(b);
  expect(
    (await b.storage.workspaceSnapshot()).entities[0]?.data.body,
  ).toContain("停止 / 暂停\nPhone stops\n\n下周重点\nDesktop next");
  await edit(a.storage, review.id, { nextFocus: "Phone collision" });
  await edit(b.storage, review.id, { nextFocus: "Desktop collision" });
  await push(b);
  expect((await push(a))?.statusCode).toBe(409);
});
it("merges first native default materialization with bare project, record and habit edits while keeping custom fields strict", async () => {
  const { a, b, pull, push } = await setup();
  for (const [kind, bare, local, defaults] of [
    [
      "project",
      { title: "Bare", status: "active" },
      { blocker: "Offline blocker" },
      {
        outcome: "",
        recoveryNote: "",
        completionCriteria: "",
        blocker: "",
        nextActionId: null,
        reviewDate: null,
        dueDate: null,
        archivedAt: null,
      },
    ],
    [
      "record",
      { title: "Bare" },
      { body: "Offline body" },
      {
        body: "",
        projectId: null,
        taskId: null,
        sourceCaptureId: null,
        links: [],
      },
    ],
    [
      "habit",
      { title: "Bare" },
      { notes: "Offline habit notes" },
      {
        notes: "",
        trigger: "",
        normalVersion: "",
        minimumVersion: "",
        projectId: null,
      },
    ],
  ] as const) {
    const entry = c(kind, bare);
    await save(a.storage, [entry]);
    await push(a);
    await pull(a);
    await pull(b);
    await edit(a.storage, entry.id, local);
    await edit(b.storage, entry.id, { ...defaults, title: "Desktop title" });
    await push(b);
    await pull(a);
    expect((await a.storage.entityState()).conflicts).toHaveLength(0);
    expect(
      (await a.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === entry.id,
      )?.data,
    ).toMatchObject({ ...local, title: "Desktop title" });
    expect((await push(a))?.statusCode).toBe(200);
    await pull(a);
    await pull(b);
    const second = c(kind, bare);
    await save(a.storage, [second]);
    await push(a);
    await pull(a);
    await pull(b);
    await edit(a.storage, second.id, local);
    await edit(b.storage, second.id, {
      ...defaults,
      title: "Desktop stale-CAS title",
    });
    await push(b);
    expect((await push(a))?.statusCode).toBe(200);
    await pull(a);
    await pull(b);
    expect(
      (await b.storage.workspaceSnapshot()).entities.find(
        (e) => e.id === second.id,
      )?.data,
    ).toMatchObject({ ...local, title: "Desktop stale-CAS title" });
  }
  const p = c("project", { title: "Strict custom", status: "active" });
  await save(a.storage, [p]);
  await push(a);
  await pull(a);
  await pull(b);
  await edit(a.storage, p.id, { custom: { new: "local" } });
  await edit(b.storage, p.id, { custom: { new: "" } });
  await push(b);
  expect((await push(a))?.statusCode).toBe(409);
});
