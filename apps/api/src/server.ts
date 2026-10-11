import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { EntityStore, entityKinds, type EntityCommand } from "./entities.js";
import { CaptureStore, StoreError, type CaptureCommand } from "./store.js";
import { AccountStore, AccountError } from "./accounts.js";

export interface DeviceCredential {
  ownerId: string;
  deviceId: string;
  tokenHash: string;
}
export interface ServerOptions {
  databasePath: string;
  devices: DeviceCredential[];
  https?: { key: string | Buffer; cert: string | Buffer };
}
const uuid =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "operationId",
    "deviceId",
    "id",
    "expectedVersion",
    "rawText",
    "deleted",
  ],
  properties: {
    operationId: { type: "string", pattern: uuid },
    deviceId: { type: "string", pattern: uuid },
    id: { type: "string", pattern: uuid },
    expectedVersion: {
      anyOf: [
        { type: "null" },
        { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 },
      ],
    },
    rawText: { type: "string", maxLength: 100000 },
    deleted: { type: "boolean" },
  },
};

export function createServer(options: ServerOptions): FastifyInstance {
  const credentials = options.devices.map((device) => {
    if (
      !/^[a-f0-9]{64}$/i.test(device.tokenHash) ||
      !device.ownerId ||
      !new RegExp(uuid).test(device.deviceId)
    ) {
      throw new Error("Invalid device configuration");
    }
    return { ...device, hash: Buffer.from(device.tokenHash, "hex") };
  });
  if (
    new Set(credentials.map((device) => device.tokenHash.toLowerCase()))
      .size !== credentials.length
  ) {
    throw new Error("Duplicate device token");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
    requestTimeout: 15000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;
  const store = new CaptureStore(options.databasePath);
  const entities = new EntityStore(options.databasePath);
  const accounts = new AccountStore(options.databasePath);
  const identities = new WeakMap<FastifyRequest, DeviceCredential>();
  const windows = new Map<string, { start: number; count: number }>();
  app.addHook("onClose", async () => {
    entities.close();
    store.close();
    accounts.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/auth/register" || path === "/auth/login") {
      const now = Date.now();
      for (const [key, window] of windows)
        if (now - window.start >= 900000) windows.delete(key);
      const key = `auth:${request.ip}`,
        window = windows.get(key);
      if (!window) windows.set(key, { start: now, count: 1 });
      else if (++window.count > 20)
        return reply
          .code(429)
          .header("Retry-After", "900")
          .send({ error: "RATE_LIMITED" });
      return;
    }
    if (!request.url.split("?")[0]?.startsWith("/v1/")) return;
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && /^Bearer [^\s]+$/.test(header)
        ? header.slice(7)
        : "";
    const digest = createHash("sha256").update(token).digest();
    let identity: DeviceCredential | undefined;
    // Always compare every configured digest to avoid revealing which credential matched.
    for (const credential of credentials) {
      if (timingSafeEqual(digest, credential.hash) && token)
        identity = credential;
    }
    identity ??= token ? accounts.identify(token) : undefined;
    if (!identity) return reply.code(401).send({ error: "UNAUTHORIZED" });
    identities.set(request, identity);
    const key = `${identity.ownerId}:${identity.deviceId}`;
    const now = Date.now();
    const window = windows.get(key);
    if (!window || now - window.start >= 60000)
      windows.set(key, { start: now, count: 1 });
    else if (++window.count > 240)
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "RATE_LIMITED" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccountError)
      return reply
        .code(error.message === "EMAIL_EXISTS" ? 409 : 401)
        .send({ error: error.message });
    if (error instanceof StoreError)
      return reply
        .code(
          error.code === "INVALID_CURSOR"
            ? 400
            : error.code === "BODY_TOO_LARGE"
              ? 413
              : 409,
        )
        .send({ error: error.code });
    const statusCode =
      error instanceof Error && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (statusCode === 400)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (statusCode === 413)
      return reply.code(413).send({ error: "BODY_TOO_LARGE" });
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });
  app.get("/", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send("Praxis 局域网后端服务运行中。提供收件箱及全域实体同步接口。"),
  );
  app.get("/health", async () => ({
    status: "ok",
    service: "praxis-lan",
    protocolVersion: 2,
    generation: entities.generation,
  }));
  const authBody = {
    type: "object",
    additionalProperties: false,
    required: ["email", "password", "deviceId"],
    properties: {
      email: {
        type: "string",
        minLength: 3,
        maxLength: 254,
        pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      },
      password: { type: "string", minLength: 15, maxLength: 128 },
      deviceId: { type: "string", pattern: uuid },
      displayName: { type: "string", minLength: 1, maxLength: 60 },
    },
  };
  app.post<{
    Body: {
      email: string;
      password: string;
      deviceId: string;
      displayName: string;
    };
  }>(
    "/auth/register",
    {
      schema: {
        body: { ...authBody, required: [...authBody.required, "displayName"] },
      },
      bodyLimit: 4096,
    },
    async (request, reply) => {
      if (!request.body.displayName.trim())
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      const session = await accounts.register(
        request.body.email,
        request.body.password,
        request.body.displayName,
        request.body.deviceId,
      );
      return reply.code(201).header("Cache-Control", "no-store").send(session);
    },
  );
  app.post<{ Body: { email: string; password: string; deviceId: string } }>(
    "/auth/login",
    { schema: { body: authBody }, bodyLimit: 4096 },
    async (request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send(
          await accounts.login(
            request.body.email,
            request.body.password,
            request.body.deviceId,
          ),
        ),
  );
  app.get("/v1/account", async (request, reply) => {
    const account = accounts.identify(request.headers.authorization!.slice(7));
    return account
      ? reply
          .header("Cache-Control", "no-store")
          .send({ user: account.user, expiresAt: account.expiresAt })
      : reply.code(401).send({ error: "UNAUTHORIZED" });
  });
  app.post("/v1/account/logout", async (request, reply) => {
    accounts.logout(request.headers.authorization!.slice(7));
    return reply.code(204).send();
  });
  app.post<{ Body: CaptureCommand }>(
    "/v1/captures/commands",
    { schema: { body: commandSchema } },
    async (request, reply) => {
      const identity = identities.get(request)!;
      if (request.body.deviceId !== identity.deviceId)
        return reply.code(403).send({ error: "DEVICE_MISMATCH" });
      if (
        !request.body.rawText.trim() ||
        [...request.body.rawText].length > 100000
      )
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      // Seeding has already finished. Reject all legacy writers immediately to
      // close the window before an owner's first full-sync command.
      return reply.code(409).send({ error: "PROTOCOL_UPGRADED" });
    },
  );
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    "/v1/captures/changes",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            after: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            limit: { type: "string", pattern: "^[1-9][0-9]*$" },
          },
        },
      },
    },
    async (request, reply) => {
      const after = Number(request.query.after ?? "0");
      const limit = Number(request.query.limit ?? "100");
      if (
        !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(limit) ||
        limit > 100
      )
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      return store.changes(identities.get(request)!.ownerId, after, limit);
    },
  );
  const entityChangeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind", "expectedVersion", "data", "deleted", "createdAt"],
    properties: {
      id: { type: "string", pattern: uuid },
      kind: { type: "string", enum: entityKinds },
      expectedVersion: commandSchema.properties.expectedVersion,
      data: { type: "object" },
      baseData: { type: "object" },
      deleted: { type: "boolean" },
      createdAt: { type: "string", maxLength: 40 },
    },
  };
  app.post<{ Body: EntityCommand; Querystring: { generation?: string } }>(
    "/v1/entities/commands",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["operationId", "deviceId", "changes"],
          properties: {
            operationId: { type: "string", pattern: uuid },
            deviceId: { type: "string", pattern: uuid },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 10000,
              items: entityChangeSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = identities.get(request)!;
      if (request.body.deviceId !== identity.deviceId)
        return reply.code(403).send({ error: "DEVICE_MISMATCH" });
      if (
        request.body.changes.some(
          (c) => !Number.isFinite(Date.parse(c.createdAt)),
        )
      )
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      if (!request.query.generation)
        return reply.code(428).send({ error: "GENERATION_REQUIRED" });
      if (request.query.generation !== entities.generation)
        return reply.code(409).send({ error: "GENERATION_CHANGED" });
      return {
        ...entities.command(identity.ownerId, request.body),
        generation: entities.generation,
      };
    },
  );
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    "/v1/entities/changes",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            after: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            limit: { type: "string", pattern: "^[1-9][0-9]*$" },
          },
        },
      },
    },
    async (request, reply) => {
      const after = Number(request.query.after ?? "0"),
        limit = Number(request.query.limit ?? "25");
      if (
        !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(limit) ||
        limit > 100
      )
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      return entities.changes(identities.get(request)!.ownerId, after, limit);
    },
  );
  app.get<{
    Querystring: {
      at?: string;
      afterId?: string;
      limit?: string;
      generation?: string;
    };
  }>(
    "/v1/entities/snapshot",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            at: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
            afterId: { type: "string", maxLength: 36 },
            limit: { type: "string", pattern: "^[1-9][0-9]*$" },
            generation: { type: "string", pattern: uuid },
          },
        },
      },
    },
    async (request, reply) => {
      const at =
          request.query.at === undefined ? undefined : Number(request.query.at),
        limit = Number(request.query.limit ?? 100);
      if (
        (at !== undefined && !Number.isSafeInteger(at)) ||
        !Number.isSafeInteger(limit) ||
        limit > 1000
      )
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      if (
        request.query.generation &&
        request.query.generation !== entities.generation
      )
        return reply.code(409).send({ error: "GENERATION_CHANGED" });
      return entities.snapshot(
        identities.get(request)!.ownerId,
        at,
        request.query.afterId ?? "",
        limit,
      );
    },
  );
  return app;
}
