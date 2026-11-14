import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import type { AccountSession } from "./accounts";
import { AccountStore } from "./accounts";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const password = "long test password for normal account";
const csrf = { "x-praxis-admin": "1" };
function setup(path = ":memory:", hash: string | undefined = tokenHash) {
  const app = createServer({
    databasePath: path,
    devices: [],
    ...(hash ? { adminTokenHash: hash } : {}),
  });
  servers.push(app);
  return app;
}
async function admin(app: ReturnType<typeof setup>) {
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/login",
    headers: csrf,
    payload: { token },
  });
  expect(response.statusCode).toBe(200);
  return {
    ...csrf,
    cookie: String(response.headers["set-cookie"]).split(";")[0]!,
  };
}
async function register(
  app: ReturnType<typeof setup>,
  email = "member@example.com",
) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password,
      deviceId: randomUUID(),
      displayName: "测试用户",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<AccountSession>();
}
afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("serves the console with CSP while denying unconfigured, unauthenticated and normal-user API access", async () => {
  const disabled = createServer({ databasePath: ":memory:", devices: [] });
  servers.push(disabled);
  expect(
    (await disabled.inject({ url: "/admin/api/overview" })).statusCode,
  ).toBe(503);
  const app = setup();
  const html = await app.inject({ url: "/admin" });
  expect(html.statusCode).toBe(200);
  expect(html.body).toContain("Praxis · 管理控制台");
  expect(html.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(html.headers["cache-control"]).toBe("no-store");
  for (const asset of ["admin.js", "admin.css"])
    expect((await app.inject({ url: `/admin/${asset}` })).statusCode).toBe(200);
  const user = await register(app);
  for (const path of [
    "session",
    "overview",
    "users",
    "audit",
    "system",
    `users/${user.user.id}`,
  ]) {
    expect((await app.inject({ url: `/admin/api/${path}` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: `/admin/api/${path}`,
          headers: { authorization: `Bearer ${user.token}` },
        })
      ).statusCode,
    ).toBe(401);
  }
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/admin/api/login",
        payload: { token },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/admin/api/login",
        headers: csrf,
        payload: { token: "wrong" },
      })
    ).statusCode,
  ).toBe(401);
});

it("paginates and filters real users, aggregates private entities without exposing contents or secrets", async () => {
  const app = setup(),
    session = await register(app);
  const headers = await admin(app);
  const generation = (await app.inject({ url: "/health" })).json().generation;
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/v1/entities/commands?generation=${generation}`,
        headers: { authorization: `Bearer ${session.token}` },
        payload: {
          operationId: randomUUID(),
          deviceId: session.deviceId,
          changes: [
            {
              id: randomUUID(),
              kind: "capture",
              expectedVersion: null,
              data: { rawText: "PRIVATE_CAPTURE_SHOULD_NEVER_BE_IN_ADMIN" },
              deleted: false,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(200);
  const overview = await app.inject({ url: "/admin/api/overview", headers });
  expect(overview.json()).toMatchObject({
    users: 1,
    activeDevices: 1,
    entities: 1,
    todayOperations: 1,
    kinds: [{ kind: "capture", count: 1 }],
  });
  expect(overview.json().daily).toHaveLength(14);
  const users = (
    await app.inject({
      url: "/admin/api/users?q=MEMBER%40example&page=1",
      headers,
    })
  ).json();
  expect(users.total).toBe(1);
  expect(users.users[0]).toMatchObject({
    email: session.user.email,
    devices: 1,
    entities: 1,
  });
  expect(
    (await app.inject({ url: "/admin/api/users?q=%25", headers })).json().total,
  ).toBe(0);
  expect(
    (await app.inject({ url: "/admin/api/users?page=2", headers })).json()
      .users,
  ).toEqual([]);
  const detail = await app.inject({
    url: `/admin/api/users/${session.user.id}`,
    headers,
  });
  expect(detail.json().sessions).toHaveLength(1);
  for (const response of [
    overview,
    detail,
    await app.inject({ url: "/admin/api/users", headers }),
  ]) {
    for (const secret of [
      "PRIVATE_CAPTURE_SHOULD_NEVER_BE_IN_ADMIN",
      "password_hash",
      "token_hash",
      session.token,
      password,
    ])
      expect(response.body).not.toContain(secret);
  }
  for (const suffix of [
    "users?page=0",
    "users?page=9999999",
    "users?status=invalid",
    "users/not-a-uuid",
    "audit?page=-1",
  ])
    expect(
      (await app.inject({ url: `/admin/api/${suffix}`, headers })).statusCode,
    ).toBe(400);
});

it("disables accounts atomically, rejects existing sessions and relogin, and requires fresh login after enabling", async () => {
  const app = setup(),
    session = await register(app),
    headers = await admin(app);
  const url = `/admin/api/users/${session.user.id}/status`;
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { disabled: true, reason: " " },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { cookie: headers.cookie },
        payload: { disabled: true, reason: "test" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { disabled: true, reason: "暂停测试账号" },
      })
    ).statusCode,
  ).toBe(200);
  const accountHeaders = { authorization: `Bearer ${session.token}` };
  expect(
    (
      await app.inject({
        url: "/v1/entities/snapshot",
        headers: accountHeaders,
      })
    ).statusCode,
  ).toBe(401);
  const login = () =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: session.user.email,
        password,
        deviceId: session.deviceId,
      },
    });
  expect((await login()).statusCode).toBe(403);
  expect(
    (
      await app.inject({ url: "/admin/api/users?status=disabled", headers })
    ).json().total,
  ).toBe(1);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { disabled: false, reason: "恢复测试账号" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: "/v1/account", headers: accountHeaders }))
      .statusCode,
  ).toBe(401);
  expect((await login()).statusCode).toBe(200);
  const audit = (await app.inject({ url: "/admin/api/audit", headers })).json();
  expect(
    audit.entries.map((entry: { action: string }) => entry.action),
  ).toEqual(["enable_user", "disable_user", "admin_login"]);
  expect(audit.entries[0].email).toBe(session.user.email);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/admin/api/users/${randomUUID()}/status`,
        headers,
        payload: { disabled: true, reason: "test" },
      })
    ).statusCode,
  ).toBe(404);
});

it("revokes one device without affecting another and supports revoking every login", async () => {
  const app = setup(),
    session = await register(app),
    headers = await admin(app);
  const second = (
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: session.user.email, password, deviceId: randomUUID() },
    })
  ).json<AccountSession>();
  const revoke = (deviceId?: string) =>
    app.inject({
      method: "POST",
      url: `/admin/api/users/${session.user.id}/revoke`,
      headers,
      payload: {
        reason: "用户申请撤销登录",
        ...(deviceId ? { deviceId } : {}),
      },
    });
  expect((await revoke(session.deviceId)).json().revoked).toBe(1);
  expect(
    (
      await app.inject({
        url: "/v1/account",
        headers: { authorization: `Bearer ${session.token}` },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: "/v1/account",
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
  ).toBe(200);
  expect((await revoke()).json().revoked).toBe(1);
  expect(
    (
      await app.inject({
        url: "/v1/account",
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
  ).toBe(401);
});

it("preserves audit and hashed admin sessions after restart and invalidates logout, expiry and credential rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-admin-"));
  directories.push(directory);
  const path = join(directory, "api.db");
  let app = setup(path);
  const headers = await admin(app);
  await app.close();
  servers.splice(servers.indexOf(app), 1);
  app = setup(path);
  expect(
    (await app.inject({ url: "/admin/api/session", headers })).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: "/admin/api/audit", headers })).json().total,
  ).toBe(1);
  const db = new DatabaseSync(path);
  const stored = db.prepare("SELECT * FROM admin_sessions").get()!;
  expect(Object.values(stored)).not.toContain(
    headers.cookie.slice("praxis_admin=".length),
  );
  db.prepare("UPDATE admin_sessions SET expires_at=0").run();
  db.close();
  expect(
    (await app.inject({ url: "/admin/api/session", headers })).statusCode,
  ).toBe(401);
  const fresh = await admin(app);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/admin/api/logout",
        headers: fresh,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await app.inject({ url: "/admin/api/session", headers: fresh }))
      .statusCode,
  ).toBe(401);
  const beforeRotation = await admin(app);
  await app.close();
  servers.splice(servers.indexOf(app), 1);
  app = setup(path, "a".repeat(64));
  expect(
    (await app.inject({ url: "/admin/api/session", headers: beforeRotation }))
      .statusCode,
  ).toBe(401);
});

it("upgrades legacy account schemas without losing accounts and persists disabled state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-admin-legacy-"));
  directories.push(directory);
  const path = join(directory, "api.db"),
    id = randomUUID();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE account_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO account_users VALUES(?,?,?,?,?)").run(
    id,
    "legacy@example.com",
    "Legacy",
    "salt",
    "hash",
  );
  db.close();
  let app = setup(path);
  const headers = await admin(app);
  const detail = (
    await app.inject({ url: `/admin/api/users/${id}`, headers })
  ).json();
  expect(detail.user).toMatchObject({
    email: "legacy@example.com",
    disabled: 0,
    createdAt: null,
  });
  await app.inject({
    method: "POST",
    url: `/admin/api/users/${id}/status`,
    headers,
    payload: { disabled: true, reason: "legacy disabled" },
  });
  await app.close();
  servers.splice(servers.indexOf(app), 1);
  app = setup(path);
  expect(
    (await app.inject({ url: `/admin/api/users/${id}`, headers })).json().user
      .disabled,
  ).toBe(1);
});

it("rate limits admin login attempts independently of user authentication", async () => {
  const app = setup();
  for (let i = 0; i < 10; i++)
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/api/login",
          headers: csrf,
          payload: { token: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
  const result = await app.inject({
    method: "POST",
    url: "/admin/api/login",
    headers: csrf,
    payload: { token },
  });
  expect(result.statusCode).toBe(429);
  expect(result.headers["retry-after"]).toBe("900");
  expect((await register(app)).user.email).toBe("member@example.com");
});

it("rejects a login when the account is disabled during asynchronous password verification", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountStore(db);
  try {
    const session = await accounts.register(
      "race@example.com",
      password,
      "Race",
      randomUUID(),
    );
    const pending = accounts.login("race@example.com", password, randomUUID());
    db.prepare("UPDATE account_users SET disabled=1 WHERE id=?").run(
      session.user.id,
    );
    await expect(pending).rejects.toThrow("ACCOUNT_DISABLED");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM account_sessions").get()?.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});

it("rolls back account changes and session deletion if their audit insert cannot commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-admin-atomic-"));
  directories.push(directory);
  const path = join(directory, "api.db"),
    app = setup(path),
    user = await register(app),
    headers = await admin(app);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit WHEN NEW.action='disable_user' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    );
    const response = await app.inject({
      method: "POST",
      url: `/admin/api/users/${user.user.id}/status`,
      headers,
      payload: { disabled: true, reason: "must rollback" },
    });
    expect(response.statusCode).toBe(500);
    expect(
      db
        .prepare("SELECT disabled FROM account_users WHERE id=?")
        .get(user.user.id)?.disabled,
    ).toBe(0);
    expect(
      (
        await app.inject({
          url: "/v1/account",
          headers: { authorization: `Bearer ${user.token}` },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    db.close();
  }
});
