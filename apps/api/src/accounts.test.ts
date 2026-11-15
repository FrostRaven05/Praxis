import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import type { AccountSession } from "./accounts";
const servers: ReturnType<typeof createServer>[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const password = "a sufficiently long test password";
const setup = (path = ":memory:") => {
  const server = createServer({ databasePath: path, devices: [] });
  servers.push(server);
  return server;
};
const register = (
  server: ReturnType<typeof setup>,
  email: string,
  deviceId = randomUUID(),
) =>
  server.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password, deviceId, displayName: email.split("@")[0] },
  });
const headers = (session: AccountSession) => ({
  authorization: `Bearer ${session.token}`,
});

it("registers, normalizes email, rejects duplicate and wrong credentials, and revokes only the logged-out session", async () => {
  const server = setup(),
    registration = await register(server, "Alice@Example.com");
  expect(registration.statusCode).toBe(201);
  expect(registration.headers["cache-control"]).toBe("no-store");
  const session = registration.json<AccountSession>();
  expect(session.user.email).toBe("alice@example.com");
  expect((await register(server, "alice@example.com")).statusCode).toBe(409);
  const login = (email: string, pass: string) =>
    server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: pass, deviceId: session.deviceId },
    });
  expect(
    (await login("alice@example.com", "a completely wrong password"))
      .statusCode,
  ).toBe(401);
  expect((await login("missing@example.com", password)).json()).toEqual({
    error: "INVALID_CREDENTIALS",
  });
  const other = await login(" ALICE@example.com ", password);
  // Schema rejects whitespace before normalization, so clients trim input first.
  expect(other.statusCode).toBe(400);
  const relogin = (
    await login("ALICE@example.com", password)
  ).json<AccountSession>();
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/account/logout",
        headers: headers(session),
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await server.inject({ url: "/v1/account", headers: headers(session) }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await server.inject({ url: "/v1/account", headers: headers(relogin) })
    ).json().user.id,
  ).toBe(session.user.id);
});
it("isolates same-ID entities, feeds and snapshots by authenticated owner and refuses forged devices/owners", async () => {
  const server = setup(),
    a = (await register(server, "a@example.com")).json<AccountSession>(),
    b = (await register(server, "b@example.com")).json<AccountSession>();
  const generation = (await server.inject({ url: "/health" })).json()
      .generation,
    id = randomUUID();
  const write = (session: AccountSession, title: string, extra = {}) =>
    server.inject({
      method: "POST",
      url: `/v1/entities/commands?generation=${generation}`,
      headers: headers(session),
      payload: {
        operationId: randomUUID(),
        deviceId: session.deviceId,
        changes: [
          {
            id,
            kind: "capture",
            expectedVersion: null,
            data: { rawText: title },
            deleted: false,
            createdAt: new Date().toISOString(),
          },
        ],
        ...extra,
      },
    });
  expect((await write(a, "Alice private")).statusCode).toBe(200);
  const empty = await server.inject({
    url: "/v1/entities/snapshot",
    headers: headers(b),
  });
  expect(empty.json().entities).toEqual([]);
  expect(
    (await write(b, "Bob private", { deviceId: a.deviceId })).statusCode,
  ).toBe(403);
  expect((await write(b, "forged", { ownerId: a.user.id })).statusCode).toBe(
    400,
  );
  expect((await write(b, "Bob private")).statusCode).toBe(200);
  for (const [session, title] of [
    [a, "Alice private"],
    [b, "Bob private"],
  ] as const) {
    const snapshot = (
      await server.inject({
        url: "/v1/entities/snapshot",
        headers: headers(session),
      })
    ).json();
    expect(
      snapshot.entities.map(
        (e: { data: { rawText: string } }) => e.data.rawText,
      ),
    ).toEqual([title]);
    const feed = (
      await server.inject({
        url: "/v1/entities/changes",
        headers: headers(session),
      })
    ).json();
    expect(JSON.stringify(feed)).toContain(title);
    expect(JSON.stringify(feed)).not.toContain(
      title === "Alice private" ? "Bob private" : "Alice private",
    );
  }
});
it("persists password hashes and session expiry across server restart without storing password or token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-accounts-"));
  directories.push(directory);
  const path = join(directory, "api.db");
  let server = setup(path);
  const session = (
    await register(server, "saved@example.com")
  ).json<AccountSession>();
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const db = new DatabaseSync(path),
    user = db.prepare("SELECT * FROM account_users").get()!,
    stored = db.prepare("SELECT * FROM account_sessions").get()!;
  expect(Object.values(user)).not.toContain(password);
  expect(Object.values(stored)).not.toContain(session.token);
  server = setup(path);
  expect(
    (await server.inject({ url: "/v1/account", headers: headers(session) }))
      .statusCode,
  ).toBe(200);
  db.prepare("UPDATE account_sessions SET expires_at=0").run();
  db.close();
  expect(
    (
      await server.inject({
        url: "/v1/entities/snapshot",
        headers: headers(session),
      })
    ).statusCode,
  ).toBe(401);
});
it("validates account input and limits authentication attempts", async () => {
  const server = setup();
  for (let i = 0; i < 20; i++)
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/auth/register",
          payload: {
            email: "bad",
            password: "short",
            displayName: "A",
            deviceId: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(400);
  expect((await register(server, "valid@example.com")).statusCode).toBe(429);
});
it("changes the password, keeps this session, and signs out the other device", async () => {
  const server = setup();
  const first = (await register(server, "owner@example.com")).json<AccountSession>();
  const second = (
    await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "owner@example.com",
        password,
        deviceId: randomUUID(),
      },
    })
  ).json<AccountSession>();
  const next = "a different long test password";
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/account/password",
        headers: headers(first),
        payload: { currentPassword: "not the current password", newPassword: next },
      })
    ).json(),
  ).toEqual({ error: "INVALID_CREDENTIALS" });
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/account/password",
        headers: headers(first),
        payload: { currentPassword: password, newPassword: password },
      })
    ).json(),
  ).toEqual({ error: "PASSWORD_UNCHANGED" });
  const changed = await server.inject({
    method: "POST",
    url: "/v1/account/password",
    headers: headers(first),
    payload: { currentPassword: password, newPassword: next },
  });
  expect(changed.statusCode).toBe(204);
  expect(
    (await server.inject({ url: "/v1/account", headers: headers(first) })).statusCode,
  ).toBe(200);
  expect(
    (await server.inject({ url: "/v1/account", headers: headers(second) })).statusCode,
  ).toBe(401);
  const login = (pass: string) =>
    server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.com", password: pass, deviceId: second.deviceId },
    });
  expect((await login(password)).statusCode).toBe(401);
  expect((await login(next)).statusCode).toBe(200);
});
it("publishes the app release without a login", async () => {
  const server = setup();
  const release = await server.inject({ url: "/app/release" });
  expect(release.statusCode).toBe(200);
  expect(release.json()).toMatchObject({ version: "0.1.0", windows: null, android: null });
});
