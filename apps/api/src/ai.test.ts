import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "./server";
import { AiService, modelGenerator, type AiOptions } from "./ai";
import {
  validateAiProposal,
  type AiGenerateRequest,
  type AiProposal,
} from "./ai-contract";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) await s.close();
});
const proposal = (): AiProposal => ({
  summary: "从一个小步骤开始",
  projectName: "摄影作品集",
  outcome: "发布第一组作品",
  assumptions: [],
  question: null,
  nextAction: "挑选10张照片",
  tasks: [
    {
      key: "s1",
      title: "挑选10张照片",
      criteria: "放进同一文件夹",
      estimatedMinutes: 15,
      dependsOn: [],
    },
    {
      key: "s2",
      title: "整理作品主题",
      criteria: "为照片写一句主题",
      estimatedMinutes: null,
      dependsOn: ["s1"],
    },
  ],
  reward: { title: "摄影出游", condition: "发布作品后" },
  suggestedTaskId: null,
});
const input = (): AiGenerateRequest => ({
  id: randomUUID(),
  mode: "decompose",
  input: "我想做摄影作品集",
  constraints: "每周两小时",
  context: {
    date: "2026-10-25",
    timeZone: "Asia/Hong_Kong",
    project: null,
    tasks: [],
    source: null,
  },
});
function setup(generate?: AiOptions["generate"], timeoutMs?: number) {
  const token = "test-token-" + randomUUID(),
    owner = randomUUID();
  const server = createServer({
    databasePath: ":memory:",
    devices: [
      {
        ownerId: owner,
        deviceId: randomUUID(),
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
    ai: {
      ...(generate ? { generate } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  });
  servers.push(server);
  return { server, headers: { authorization: "Bearer " + token } };
}
async function untilReady(
  server: ReturnType<typeof createServer>,
  headers: Record<string, string>,
  id: string,
) {
  for (let i = 0; i < 50; i++) {
    const r = await server.inject({ url: "/v1/ai/runs/" + id, headers });
    if (r.json().status !== "running") return r.json();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Run did not terminate");
}
it("rejects invented fields, cycles, duplicate keys, impossible existing-task suggestions", () => {
  expect(() => validateAiProposal({ ...proposal(), approved: true })).toThrow();
  const cycle = proposal();
  cycle.tasks[0]!.dependsOn = ["s2"];
  expect(() => validateAiProposal(cycle)).toThrow("AI_DEPENDENCY_CYCLE");
  const unknown = proposal();
  unknown.tasks[1]!.dependsOn = ["s9"];
  expect(() => validateAiProposal(unknown)).toThrow("AI_UNKNOWN_DEPENDENCY");
  const p = proposal();
  p.suggestedTaskId = randomUUID();
  expect(() => validateAiProposal(p, input().context)).toThrow(
    "AI_UNREADY_SUGGESTION",
  );
});
it("reports disabled configuration and requires authentication", async () => {
  const { server, headers } = setup();
  expect((await server.inject("/v1/ai/status")).statusCode).toBe(401);
  expect(
    (await server.inject({ url: "/v1/ai/status", headers })).json().enabled,
  ).toBe(false);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: input(),
      })
    ).statusCode,
  ).toBe(503);
});
it("persists one generation per owner and request ID; rejects changed input and another owner", async () => {
  const generate = vi.fn(async () => ({
    proposal: proposal(),
    model: "fixture",
  }));
  const { server, headers } = setup(generate),
    request = input();
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: request,
      })
    ).statusCode,
  ).toBe(202);
  expect((await untilReady(server, headers, request.id)).status).toBe("ready");
  await server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers,
    payload: request,
  });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: { ...request, input: "另一个目标" },
      })
    ).statusCode,
  ).toBe(409);
  const other = await server.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: "other@example.com",
      password: "a sufficiently long password",
      displayName: "Other",
      deviceId: randomUUID(),
    },
  });
  expect(other.statusCode).toBe(201);
  expect(
    (
      await server.inject({
        url: "/v1/ai/runs/" + request.id,
        headers: { authorization: "Bearer " + other.json().token },
      })
    ).statusCode,
  ).toBe(404);
});
it("rejects client identity injection and malformed context before invoking the provider", async () => {
  const generate = vi.fn(async () => ({
    proposal: proposal(),
    model: "fixture",
  }));
  const { server, headers } = setup(generate);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: { ...input(), ownerId: "someone" },
      })
    ).statusCode,
  ).toBe(400);
  const request = input();
  request.context.date = "2026-02-31";
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: request,
      })
    ).statusCode,
  ).toBe(400);
  expect(generate).not.toHaveBeenCalled();
});
it("preserves cancellation when a provider finishes later", async () => {
  let finish!: (value: { proposal: AiProposal; model: string }) => void;
  const { server, headers } = setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = input();
  await server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers,
    payload: request,
  });
  const stopped = await server.inject({
    method: "POST",
    url: "/v1/ai/runs/" + request.id + "/cancel",
    headers,
    payload: {},
  });
  expect(stopped.json().status).toBe("cancelled");
  finish({ proposal: proposal(), model: "fixture" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(
    (await server.inject({ url: "/v1/ai/runs/" + request.id, headers })).json()
      .status,
  ).toBe("cancelled");
});
it("stops a non-cooperative provider at the run deadline", async () => {
  const { server, headers } = setup(async () => new Promise(() => {}), 10),
    request = input();
  await server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers,
    payload: request,
  });
  expect((await untilReady(server, headers, request.id)).error.code).toBe(
    "AI_TIMEOUT",
  );
});
it("restores interrupted persisted runs as failures without claiming task creation", async () => {
  const db = new DatabaseSync(":memory:");
  const service = new AiService(db);
  const request = input(),
    now = new Date().toISOString();
  db.prepare("INSERT INTO ai_runs VALUES(?,?,?,?)").run(
    "owner",
    request.id,
    JSON.stringify(request),
    JSON.stringify({
      id: request.id,
      status: "running",
      createdAt: now,
      updatedAt: now,
    }),
  );
  const recovered = new AiService(db);
  expect(recovered.get("owner", request.id)?.error?.code).toBe(
    "AI_INTERRUPTED",
  );
  await service.close();
  await recovered.close();
  db.close();
});
it("bounds format repair and executes only scoped read tools", async () => {
  const bodies: Record<string, unknown>[] = [];
  const p = proposal();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      bodies.push(JSON.parse(String(options.body)));
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "list_ready_tasks", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
        );
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify(p) } },
          ],
        }),
      );
    }),
  );
  const request = input();
  request.mode = "resume";
  const result = await modelGenerator({
    apiKey: "fixture-only",
    model: "fixture",
  })(request, new AbortController().signal);
  expect(result.proposal.tasks).toHaveLength(2);
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[1])).toContain("tool_call_id");
  expect(JSON.stringify(bodies)).not.toContain("fixture-only");
});
it("fails after one unsuccessful repair and never returns partial output", async () => {
  const call = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"approved":true}' },
            },
          ],
        }),
      ),
  );
  vi.stubGlobal("fetch", call);
  await expect(
    modelGenerator({ apiKey: "fixture-only" })(
      input(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("AI_INVALID_OUTPUT");
  expect(call).toHaveBeenCalledTimes(2);
});

it("caps persisted runs per owner while allowing generation replay", async () => {
  const db = new DatabaseSync(":memory:");
  const service = new AiService(db, {
    maxRunsPerOwnerPerDay: 1,
    generate: async () => ({ proposal: proposal(), model: "fixture" }),
  });
  const request = input();
  service.create("owner", request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(service.get("owner", request.id)?.status).toBe("ready");
  expect(service.create("owner", request).id).toBe(request.id);
  expect(() => service.create("owner", input())).toThrow("AI_DAILY_LIMIT");
  await service.close();
  db.close();
});
