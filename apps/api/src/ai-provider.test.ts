import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { aiEnvironment, AiService, modelGenerator } from "./ai";
import type { AiGenerateRequest, AiProposal } from "./ai-contract";

afterEach(() => vi.unstubAllGlobals());
const proposal = (): AiProposal => ({
  summary: "先完成一个小步骤",
  projectName: "摄影作品集",
  outcome: "发布作品",
  assumptions: [],
  question: null,
  nextAction: "挑选十张照片",
  tasks: [
    {
      key: "s1",
      title: "挑选十张照片",
      criteria: "十张照片放进同一文件夹",
      estimatedMinutes: 15,
      dependsOn: [],
    },
  ],
  reward: null,
  suggestedTaskId: null,
});
const request = (): AiGenerateRequest => ({
  id: randomUUID(),
  mode: "decompose",
  input: "制作摄影作品集",
  constraints: "每周两小时",
  context: {
    date: "2026-10-25",
    timeZone: "Asia/Shanghai",
    project: null,
    tasks: [],
    source: null,
  },
});
const reply = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
  );

it("uses the existing DeepSeek key with provider-appropriate defaults and empty compose overrides", () => {
  const options = aiEnvironment({
    DEEPSEEK_API_KEY: " fixture-deepseek ",
    PRAXIS_AI_API_KEY: "",
    PRAXIS_AI_BASE_URL: " ",
    PRAXIS_AI_MODEL: "",
  });
  expect(options).toEqual({
    apiKey: "fixture-deepseek",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
  });
  expect(aiEnvironment({})).toEqual({});
  expect(aiEnvironment({ DEEPSEEK_API_KEY: " " })).toEqual({});
});
it("keeps an explicitly configured Praxis provider separate from a machine DeepSeek key", () => {
  expect(
    aiEnvironment({
      PRAXIS_AI_API_KEY: "explicit-openai",
      DEEPSEEK_API_KEY: "fixture-deepseek",
    }),
  ).toEqual({
    apiKey: "explicit-openai",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  });
  expect(
    aiEnvironment({
      PRAXIS_AI_API_KEY: "explicit-deepseek",
      PRAXIS_AI_BASE_URL: "https://api.deepseek.com/v1",
    }),
  ).toMatchObject({
    provider: "deepseek",
    model: "deepseek-flash",
  });
});
it("supports explicit model and endpoint overrides without guessing from model names", () => {
  expect(
    aiEnvironment({
      DEEPSEEK_API_KEY: "fixture",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      DEEPSEEK_MODEL: "chosen-model",
    }),
  ).toMatchObject({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "chosen-model",
  });
  expect(
    aiEnvironment({
      PRAXIS_AI_API_KEY: "fixture",
      PRAXIS_AI_PROVIDER: "deepseek",
      PRAXIS_AI_BASE_URL: "http://127.0.0.1:4319",
      PRAXIS_AI_MODEL: "test-model",
    }),
  ).toMatchObject({
    provider: "deepseek",
    model: "test-model",
  });
  expect(() =>
    aiEnvironment({
      DEEPSEEK_API_KEY: "fixture",
      PRAXIS_AI_PROVIDER: "invalid",
    }),
  ).toThrow("Invalid AI provider");
});
it.each(["explicit", "endpoint"] as const)(
  "uses DeepSeek JSON output and disabled thinking (%s)",
  async (mode) => {
    let body: Record<string, any> = {},
      endpoint = "";
    const fetchMock = vi.fn(async (url: unknown, options: RequestInit) => {
      endpoint = String(url);
      body = JSON.parse(String(options.body));
      expect((options.headers as Record<string, string>).Authorization).toBe(
        "Bearer fixture-only",
      );
      return reply(proposal());
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await modelGenerator({
      apiKey: "fixture-only",
      ...(mode === "explicit"
        ? { provider: "deepseek" as const }
        : { baseUrl: "https://api.deepseek.com/v1" }),
    })(request(), new AbortController().signal);
    expect(endpoint).toBe(
      mode === "explicit"
        ? "https://api.deepseek.com/chat/completions"
        : "https://api.deepseek.com/v1/chat/completions",
    );
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe("deepseek-flash");
    expect(body.messages[0].content).toContain("JSON Schema");
    expect(JSON.stringify(body)).not.toContain("fixture-only");
    expect(result.proposal.tasks).toHaveLength(1);
  },
);
it("keeps OpenAI strict structured output as a separate protocol", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body).not.toHaveProperty("thinking");
      return reply(proposal());
    }),
  );
  await modelGenerator({ apiKey: "fixture-only" })(
    request(),
    new AbortController().signal,
  );
});
it("performs scoped DeepSeek tool turns without beta strict flags and suggests an existing ready task", async () => {
  const input = request();
  input.mode = "resume";
  const readyId = randomUUID(),
    blockedId = randomUUID();
  input.context.project = {
    id: randomUUID(),
    name: "作品集",
    outcome: "发布作品",
    version: 1,
    planVersion: 0,
  };
  input.context.tasks = [
    {
      id: readyId,
      title: "选照片",
      status: "todo",
      version: 1,
      dependencies: [],
      estimatedMinutes: 15,
    },
    {
      id: blockedId,
      title: "发布",
      status: "todo",
      version: 1,
      dependencies: [readyId],
      estimatedMinutes: 30,
    },
  ];
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      bodies.push(body);
      expect(
        body.tools.every((t: any) => !Object.hasOwn(t.function, "strict")),
      ).toBe(true);
      if (bodies.length <= 2)
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-" + bodies.length,
                      type: "function",
                      function: {
                        name:
                          bodies.length === 1
                            ? "read_project"
                            : "list_ready_tasks",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      const toolResults = body.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => JSON.parse(m.content));
      expect(toolResults[0].project.id).toBe(input.context.project!.id);
      expect(toolResults[1].tasks.map((t: any) => t.id)).toEqual([readyId]);
      return reply({ ...proposal(), tasks: [], suggestedTaskId: readyId });
    }),
  );
  const result = await modelGenerator({
    apiKey: "fixture",
    provider: "deepseek",
  })(input, new AbortController().signal);
  expect(bodies[0]!.tool_choice).toEqual({
    type: "function",
    function: { name: "read_project" },
  });
  expect(bodies[1]).not.toHaveProperty("tool_choice");
  expect(result.proposal.suggestedTaskId).toBe(readyId);
});
it("rejects invented fields even with DeepSeek JSON mode and stops after one repair", async () => {
  const fetchMock = vi.fn(async () => reply({ ...proposal(), approved: true }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    modelGenerator({ apiKey: "fixture", provider: "deepseek" })(
      request(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("AI_INVALID_OUTPUT");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("reports provider DNS or network errors as upstream failures without exposing credentials", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  await expect(
    modelGenerator({ apiKey: "fixture-secret", provider: "deepseek" })(
      request(),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "AI_UPSTREAM", message: "AI_UPSTREAM" });
});
it("reports the same default model as the configured provider", async () => {
  const db = new DatabaseSync(":memory:");
  const service = new AiService(db, {
    apiKey: "fixture",
    provider: "deepseek",
  });
  expect(service.status()).toMatchObject({
    enabled: true,
    model: "deepseek-flash",
  });
  await service.close();
  db.close();
});
