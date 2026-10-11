import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { CaptureStore, StoreError, type CaptureCommand } from "./store.js";

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
    bodyLimit: 1024 * 1024,
    requestTimeout: 15000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;
  const store = new CaptureStore(options.databasePath);
  const identities = new WeakMap<FastifyRequest, DeviceCredential>();
  const windows = new Map<string, { start: number; count: number }>();
  app.addHook("onClose", async () => store.close());
  app.addHook("onRequest", async (request, reply) => {
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
    if (error instanceof StoreError)
      return reply
        .code(error.code === "INVALID_CURSOR" ? 400 : 409)
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
      .send("Praxis 局域网后端服务运行中。当前提供收件箱同步接口。"),
  );
  app.get("/health", async () => ({
    status: "ok",
    service: "praxis-lan",
    protocolVersion: 1,
  }));
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
      return store.command(identity.ownerId, request.body);
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
  return app;
}
