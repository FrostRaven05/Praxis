import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createServer } from "./server";
import type { AccountSession } from "./accounts";
import type { Entity } from "./entities";

it("runs as personal management without team routes or schema initialization and preserves archived tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "praxis-personal-scope-"));
  const path = join(root, "api.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE shared_projects(id TEXT PRIMARY KEY, historical_payload TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO shared_projects VALUES(?,?)").run(
    "historical-only",
    "preserve existing content",
  );
  const server = createServer({ databasePath: path, devices: [] });
  try {
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
    for (const url of [
      "/v2/projects",
      "/v2/projects/historical-only/snapshot",
      "/v2/invitations/join",
    ]) {
      expect(
        (await server.inject({ method: "POST", url, payload: {} })).statusCode,
      ).toBe(404);
    }
    expect(
      (await server.inject({ url: "/v2/projects/historical-only/snapshot" }))
        .statusCode,
    ).toBe(404);
    expect(
      db
        .prepare("SELECT historical_payload FROM shared_projects WHERE id=?")
        .get("historical-only")?.historical_payload,
    ).toBe("preserve existing content");
    for (const name of [
      "shared_project_schema",
      "project_members",
      "project_tasks",
      "shared_command_receipts",
    ]) {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      ).toBeUndefined();
    }
  } finally {
    await server.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps one personal project/task across two devices of the same account while isolating another account", async () => {
  const server = createServer({ databasePath: ":memory:", devices: [] });
  const password = "personal scope test password only";
  const register = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email,
        password,
        displayName: email.split("@")[0],
        deviceId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<AccountSession>();
  };
  const headers = (session: AccountSession) => ({
    authorization: `Bearer ${session.token}`,
  });
  try {
    const owner = await register("owner@personal.test");
    const other = await register("other@personal.test");
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: owner.user.email, password, deviceId: randomUUID() },
    });
    expect(login.statusCode).toBe(200);
    const secondDevice = login.json<AccountSession>();
    expect(secondDevice.user.id).toBe(owner.user.id);
    const generation = (await server.inject({ url: "/health" })).json()
      .generation;
    const projectId = randomUUID(),
      taskId = randomUUID(),
      operationId = randomUUID();
    const createdAt = "2026-11-10T04:00:00Z";
    const changes = [
      {
        id: projectId,
        kind: "project",
        expectedVersion: null,
        data: { title: "我的项目", status: "active" },
        deleted: false,
        createdAt,
      },
      {
        id: taskId,
        kind: "task",
        expectedVersion: null,
        data: { title: "我的下一步", status: "todo", projectId },
        deleted: false,
        createdAt,
      },
    ];
    const command = (session: AccountSession, value: object) =>
      server.inject({
        method: "POST",
        url: `/v1/entities/commands?generation=${generation}`,
        headers: headers(session),
        payload: { deviceId: session.deviceId, ...value },
      });
    const receipt = await command(owner, { operationId, changes });
    expect(receipt.statusCode).toBe(200);
    expect((await command(owner, { operationId, changes })).json()).toEqual(
      receipt.json(),
    );
    const snapshot = async (session: AccountSession) =>
      (
        await server.inject({
          url: "/v1/entities/snapshot",
          headers: headers(session),
        })
      ).json<{ entities: Entity[] }>().entities;
    const fromSecond = await snapshot(secondDevice);
    expect(fromSecond).toHaveLength(2);
    const task = fromSecond.find((entity) => entity.id === taskId)!;
    expect(task.data.projectId).toBe(projectId);
    const update = {
      id: task.id,
      kind: task.kind,
      expectedVersion: task.version,
      data: { ...task.data, status: "completed" },
      deleted: false,
      createdAt: task.createdAt,
    };
    expect(
      (
        await command(secondDevice, {
          operationId: randomUUID(),
          changes: [update],
        })
      ).statusCode,
    ).toBe(200);
    const firstAgain = await snapshot(owner);
    expect(firstAgain.filter((entity) => entity.id === taskId)).toHaveLength(1);
    expect(firstAgain.find((entity) => entity.id === taskId)?.data.status).toBe(
      "completed",
    );
    expect(await snapshot(other)).toEqual([]);
  } finally {
    await server.close();
  }
});
