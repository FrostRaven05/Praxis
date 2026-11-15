import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { AiService } from "./ai.js";

interface AdminOptions {
  tokenHash: string | undefined;
  secureCookies: boolean;
  generation: string;
  configuredDevices: number;
  ai: AiService;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "string", pattern: "^[1-9][0-9]{0,5}$" },
    q: { type: "string", maxLength: 200 },
    status: { type: "string", enum: ["all", "active", "disabled"] },
  },
};
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
const reasonProperty = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "\\S",
};

/** Uses the existing transaction connection so account changes and audit entries commit together. */
export function registerAdmin(
  app: FastifyInstance,
  db: DatabaseSync,
  options: AdminOptions,
) {
  if (
    options.tokenHash !== undefined &&
    !/^[a-f0-9]{64}$/i.test(options.tokenHash)
  )
    throw new Error("Invalid admin credential hash");
  const expected = options.tokenHash
    ? Buffer.from(options.tokenHash, "hex")
    : undefined;
  const startedAt = Date.now();
  db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at);
    CREATE TABLE IF NOT EXISTS admin_ai_settings(id INTEGER PRIMARY KEY CHECK (id=1), provider TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const savedModel = db
    .prepare(
      "SELECT provider, base_url AS baseUrl, model, api_key AS apiKey FROM admin_ai_settings WHERE id=1",
    )
    .get() as
    | {
        provider: "openai" | "deepseek";
        baseUrl: string;
        model: string;
        apiKey: string;
      }
    | undefined;
  if (savedModel) options.ai.configure(savedModel);
  const audit = (action: string, target: string | null, reason: string) =>
    db
      .prepare(
        "INSERT INTO admin_audit(action,target_id,reason,created_at) VALUES(?,?,?,?)",
      )
      .run(action, target, reason, new Date().toISOString());
  const cookie = (token: string, age: number) =>
    `praxis_admin=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookies ? "; Secure" : ""}`;
  const loginWindows = new Map<string, { start: number; count: number }>();
  const assets = new Map([
    ["/admin", ["index.html", "text/html; charset=utf-8"]],
    ["/admin/", ["index.html", "text/html; charset=utf-8"]],
    ["/admin/admin.css", ["admin.css", "text/css; charset=utf-8"]],
    ["/admin/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
    ["/admin/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ]);
  for (const [url, asset] of assets)
    app.get(url, async (_request, reply) =>
      reply
        .type(asset[1]!)
        .send(
          readFileSync(new URL(`./admin-web/${asset[0]}`, import.meta.url)),
        ),
    );
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (path !== "/admin" && !path.startsWith("/admin/")) return;
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    if (!path.startsWith("/admin/api/")) return;
    if (!expected)
      return reply.code(503).send({ error: "ADMIN_NOT_CONFIGURED" });
    // Cross-origin forms cannot supply this header; no cross-origin API access is enabled.
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-praxis-admin"] !== "1"
    )
      return reply.code(403).send({ error: "INVALID_ORIGIN" });
    if (path === "/admin/api/login") {
      const now = Date.now();
      for (const [key, value] of loginWindows)
        if (now - value.start >= 900000) loginWindows.delete(key);
      let window = loginWindows.get(request.ip);
      if (!window) {
        window = { start: now, count: 0 };
        loginWindows.set(request.ip, window);
      }
      if (++window.count > 10)
        return reply
          .code(429)
          .header("Retry-After", "900")
          .send({ error: "RATE_LIMITED" });
      return;
    }
    const token =
      request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("praxis_admin="))
        ?.slice(13) ?? "";
    const session = db
      .prepare(
        "SELECT 1 FROM admin_sessions WHERE token_hash=? AND credential_hash=? AND expires_at>?",
      )
      .get(hash(token), options.tokenHash!, Date.now());
    if (!session) return reply.code(401).send({ error: "UNAUTHORIZED" });
  });
  app.post<{ Body: { token: string } }>(
    "/admin/api/login",
    {
      bodyLimit: 2048,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      if (
        !expected ||
        !timingSafeEqual(Buffer.from(hash(request.body.token), "hex"), expected)
      )
        return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
      const token = randomBytes(32).toString("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "DELETE FROM admin_sessions WHERE expires_at<=? OR credential_hash<>?",
        ).run(Date.now(), options.tokenHash!);
        db.prepare("INSERT INTO admin_sessions VALUES(?,?,?)").run(
          hash(token),
          options.tokenHash!,
          Date.now() + 8 * 3600000,
        );
        audit("admin_login", null, "管理员登录");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return reply
        .header("Set-Cookie", cookie(token, 8 * 3600))
        .send({ ok: true });
    },
  );
  app.get("/admin/api/session", async () => ({ authenticated: true }));
  app.post("/admin/api/logout", async (request, reply) => {
    const token =
      request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("praxis_admin="))
        ?.slice(13) ?? "";
    db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(
      hash(token),
    );
    return reply.header("Set-Cookie", cookie("", 0)).code(204).send();
  });
  const count = (sql: string, ...args: (string | number)[]) =>
    Number(db.prepare(sql).get(...args)?.n ?? 0);
  const entityCounts = (owner?: string) =>
    db
      .prepare(
        `SELECT json_extract(payload,'$.kind') AS kind, COUNT(*) AS count FROM sync_entities WHERE json_extract(payload,'$.deleted')=0 ${owner ? "AND owner=?" : ""} GROUP BY kind ORDER BY count DESC`,
      )
      .all(...(owner ? [owner] : []));
  app.get("/admin/api/overview", async () => {
    // UTC day boundaries keep aggregation stable across server and browser time zones.
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 13 * 86400000)
      .toISOString()
      .slice(0, 10);
    const dailyRows = db
      .prepare(
        "SELECT substr(json_extract(result,'$.entities[0].updatedAt'),1,10) AS day, COUNT(*) AS count FROM sync_entity_changes WHERE json_extract(result,'$.entities[0].updatedAt')>=? GROUP BY day ORDER BY day",
      )
      .all(since);
    const daily = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(
        Date.parse(`${today}T00:00:00Z`) - (13 - index) * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      return {
        day,
        count: Number(dailyRows.find((row) => row.day === day)?.count ?? 0),
      };
    });
    return {
      users: count("SELECT COUNT(*) AS n FROM account_users"),
      disabledUsers: count(
        "SELECT COUNT(*) AS n FROM account_users WHERE disabled=1",
      ),
      activeDevices: count(
        "SELECT COUNT(*) AS n FROM (SELECT DISTINCT s.user_id,s.device_id FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.expires_at>? AND u.disabled=0)",
        Date.now(),
      ),
      entities: count(
        "SELECT COUNT(*) AS n FROM sync_entities WHERE json_extract(payload,'$.deleted')=0",
      ),
      todayOperations: daily.at(-1)!.count,
      operations: count("SELECT COUNT(*) AS n FROM sync_entity_changes"),
      kinds: entityCounts(),
      daily,
      updatedAt: new Date().toISOString(),
    };
  });
  app.get<{ Querystring: { page?: string; q?: string; status?: string } }>(
    "/admin/api/users",
    { schema: { querystring: pageSchema } },
    async (request) => {
      const page = Number(request.query.page ?? 1),
        q = request.query.q?.trim() ?? "",
        status = request.query.status ?? "all";
      const where =
        "WHERE (instr(lower(u.email),lower(?))>0 OR instr(lower(u.display_name),lower(?))>0 OR instr(u.id,?)>0) AND (?='all' OR u.disabled=?)";
      const args = [q, q, q, status, Number(status === "disabled")];
      return {
        total: count(
          `SELECT COUNT(*) AS n FROM account_users u ${where}`,
          ...args,
        ),
        page,
        pageSize: 12,
        users: db
          .prepare(
            `SELECT u.id,u.email,u.display_name AS displayName,u.disabled,u.created_at AS createdAt,u.last_login_at AS lastLoginAt,
        (SELECT COUNT(DISTINCT device_id) FROM account_sessions WHERE user_id=u.id AND expires_at>?) AS devices,
        (SELECT COUNT(*) FROM sync_entities WHERE owner=u.id AND json_extract(payload,'$.deleted')=0) AS entities
        FROM account_users u ${where} ORDER BY u.created_at DESC,u.id LIMIT 12 OFFSET ?`,
          )
          .all(Date.now(), ...args, (page - 1) * 12),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/admin/api/users/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const user = db
        .prepare(
          "SELECT id,email,display_name AS displayName,disabled,created_at AS createdAt,last_login_at AS lastLoginAt FROM account_users WHERE id=?",
        )
        .get(request.params.id);
      if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
      return {
        user,
        kinds: entityCounts(request.params.id),
        sessions: db
          .prepare(
            "SELECT device_id AS deviceId,MAX(expires_at) AS expiresAt,COUNT(*) AS sessions FROM account_sessions WHERE user_id=? AND expires_at>? GROUP BY device_id ORDER BY expiresAt DESC",
          )
          .all(request.params.id, Date.now()),
      };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { disabled: boolean; reason: string };
  }>(
    "/admin/api/users/:id/status",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["disabled", "reason"],
          properties: { disabled: { type: "boolean" }, reason: reasonProperty },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      if (!db.prepare("SELECT 1 FROM account_users WHERE id=?").get(id))
        return reply.code(404).send({ error: "USER_NOT_FOUND" });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE account_users SET disabled=? WHERE id=?").run(
          Number(request.body.disabled),
          id,
        );
        if (request.body.disabled)
          db.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
        audit(
          request.body.disabled ? "disable_user" : "enable_user",
          id,
          request.body.reason.trim(),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { ok: true };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { deviceId?: string; reason: string };
  }>(
    "/admin/api/users/:id/revoke",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            deviceId: { type: "string", format: "uuid" },
            reason: reasonProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      if (!db.prepare("SELECT 1 FROM account_users WHERE id=?").get(id))
        return reply.code(404).send({ error: "USER_NOT_FOUND" });
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = request.body.deviceId
          ? db
              .prepare(
                "DELETE FROM account_sessions WHERE user_id=? AND device_id=?",
              )
              .run(id, request.body.deviceId)
          : db.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
        audit("revoke_sessions", id, request.body.reason.trim());
        db.exec("COMMIT");
        return { ok: true, revoked: Number(result.changes) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  );
  app.delete<{
    Params: { id: string };
    Body: { email: string; reason: string };
  }>(
    "/admin/api/users/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "reason"],
          properties: {
            email: { type: "string", minLength: 1, maxLength: 254 },
            reason: reasonProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const user = db
        .prepare("SELECT email FROM account_users WHERE id=?")
        .get(id);
      if (!user) return reply.code(404).send({ error: "USER_NOT_FOUND" });
      if (request.body.email.trim().toLowerCase() !== user.email)
        return reply.code(400).send({ error: "EMAIL_CONFIRMATION_MISMATCH" });
      db.exec("BEGIN IMMEDIATE");
      try {
        // Keep only the ID to block legacy paired credentials after account deletion.
        db.prepare("INSERT INTO account_deleted_users(id) VALUES(?)").run(id);
        for (const table of [
          "sync_entity_versions",
          "sync_entity_changes",
          "sync_entities",
          "sync_entity_upgrades",
          "capture_changes",
          "captures",
        ])
          db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(id);
        db.prepare("DELETE FROM ai_runs WHERE owner_id=?").run(id);
        db.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
        db.prepare("DELETE FROM account_users WHERE id=?").run(id);
        audit("delete_user", id, request.body.reason.trim());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      options.ai.abortOwner(id);
      return reply.code(204).send();
    },
  );
  app.get<{ Querystring: { page?: string } }>(
    "/admin/api/audit",
    {
      schema: {
        querystring: {
          ...pageSchema,
          properties: { page: pageSchema.properties.page },
        },
      },
    },
    async (request) => {
      const page = Number(request.query.page ?? 1);
      return {
        total: count("SELECT COUNT(*) AS n FROM admin_audit"),
        page,
        pageSize: 15,
        entries: db
          .prepare(
            "SELECT a.id,a.action,a.target_id AS targetId,u.email AS email,a.reason,a.created_at AS createdAt FROM admin_audit a LEFT JOIN account_users u ON u.id=a.target_id ORDER BY a.id DESC LIMIT 15 OFFSET ?",
          )
          .all((page - 1) * 15),
      };
    },
  );
  app.get("/admin/api/system", async () => ({
    service: "Praxis API",
    status: "ok",
    protocolVersion: 2,
    generation: options.generation,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    configuredDevices: options.configuredDevices,
    administratorSessionHours: 8,
    secureCookies: options.secureCookies,
    databaseBytes:
      Number(db.prepare("PRAGMA page_count").get()?.page_count ?? 0) *
      Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 0),
    checkedAt: new Date().toISOString(),
  }));
  const modelView = () => {
    const saved = db
      .prepare(
        "SELECT provider, base_url AS baseUrl, model, updated_at AS updatedAt FROM admin_ai_settings WHERE id=1",
      )
      .get() as
      | {
          provider: string;
          baseUrl: string;
          model: string;
          updatedAt: string;
        }
      | undefined;
    const live = options.ai.status();
    const current = options.ai.credentials();
    return {
      provider: saved?.provider ?? current?.provider ?? "deepseek",
      baseUrl: saved?.baseUrl ?? current?.baseUrl ?? "https://api.deepseek.com",
      model: saved?.model ?? live.model ?? "deepseek-flash",
      hasApiKey: Boolean(saved || current?.apiKey),
      enabled: live.enabled,
      source: saved ? "saved" : current ? "environment" : "none",
      updatedAt: saved?.updatedAt ?? null,
    };
  };
  app.get("/admin/api/model", async () => modelView());
  app.put<{
    Body: {
      provider: "openai" | "deepseek";
      baseUrl: string;
      model: string;
      apiKey?: string;
    };
  }>(
    "/admin/api/model",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "baseUrl", "model"],
          properties: {
            provider: { type: "string", enum: ["openai", "deepseek"] },
            baseUrl: { type: "string", minLength: 8, maxLength: 300 },
            model: { type: "string", minLength: 1, maxLength: 200 },
            apiKey: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      let baseUrl: URL;
      try {
        baseUrl = new URL(request.body.baseUrl.trim());
      } catch {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }
      if (
        baseUrl.protocol !== "https:" ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.search ||
        baseUrl.hash
      )
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      const model = request.body.model.trim();
      if (!model) return reply.code(400).send({ error: "INVALID_REQUEST" });
      const savedKey = (
        db.prepare("SELECT api_key FROM admin_ai_settings WHERE id=1").get() as
          { api_key: string } | undefined
      )?.api_key;
      const apiKey =
        request.body.apiKey?.trim() ||
        savedKey ||
        options.ai.credentials()?.apiKey;
      if (!apiKey) return reply.code(400).send({ error: "INVALID_REQUEST" });
      const next = {
        provider: request.body.provider,
        baseUrl: baseUrl.toString().replace(/\/$/, ""),
        model,
        apiKey,
      };
      db.prepare(
        "INSERT INTO admin_ai_settings(id,provider,base_url,model,api_key,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key, updated_at=excluded.updated_at",
      ).run(
        next.provider,
        next.baseUrl,
        next.model,
        next.apiKey,
        new Date().toISOString(),
      );
      options.ai.configure(next);
      audit("update_model", null, `${next.provider} / ${next.model}`);
      return modelView();
    },
  );
}
