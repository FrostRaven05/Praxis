import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  isAiTaskReady,
  validateAiProposal,
  type AiGenerateRequest,
  type AiProposal,
} from "./ai-contract";
import { modelGenerator } from "./ai";
import { createServer } from "./server";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) await server.close();
});
function input(): AiGenerateRequest {
  return {
    id: randomUUID(),
    mode: "resume",
    input: "继续制作作品集",
    constraints: "",
    context: {
      date: "2026-10-25",
      timeZone: "Asia/Hong_Kong",
      project: {
        id: randomUUID(),
        name: "摄影作品集",
        outcome: "发布第一组作品",
        version: 2,
        planVersion: 4,
      },
      source: null,
      tasks: [
        {
          id: randomUUID(),
          title: "挑选照片",
          status: "todo",
          version: 3,
          parentId: null,
          dependencies: [],
          estimatedMinutes: 15,
          completionCriteria: "十张照片放入文件夹",
          statusReason: "",
          plannedStart: null,
          plannedEnd: null,
          executionDate: null,
        },
      ],
      recovery: {
        version: 2,
        updatedAt: "2026-10-25T00:00:00Z",
        definitionOfDone: "发布作品",
        blockerText: "尚待反馈",
        lastContext: "已经选出五张照片",
        restartHint: "继续补选五张",
        waitingNote: "",
        reviewDate: "2026-10-26",
        nextActionTaskId: null,
        nextActionCleared: false,
      },
      recentRecords: [
        {
          id: randomUUID(),
          version: 4,
          title: "选片进展",
          recordType: "progress",
          bodyExcerpt: "已选出五张照片",
          updatedAt: "2026-10-25T01:00:00Z",
          truncated: false,
        },
      ],
      truncated: false,
      availableMinutes: 20,
    },
  };
}
function proposal(request: AiGenerateRequest): AiProposal {
  return {
    summary: "上次选出五张照片，可以继续补选。",
    projectName: "",
    outcome: "",
    assumptions: [],
    question: null,
    nextAction: "继续挑选照片",
    tasks: [],
    reward: null,
    suggestedTaskId: request.context.tasks[0]!.id,
    references: [
      {
        kind: "recovery",
        id: request.context.project!.id,
        version: request.context.recovery!.version,
      },
      { kind: "record", id: request.context.recentRecords![0]!.id, version: 4 },
      { kind: "task", id: request.context.tasks[0]!.id, version: 3 },
    ],
  };
}
function setup() {
  const token = randomUUID(),
    generate = vi.fn(async (request: AiGenerateRequest) => ({
      proposal: proposal(request),
      model: "fixture",
    }));
  const server = createServer({
    databasePath: ":memory:",
    devices: [
      {
        ownerId: randomUUID(),
        deviceId: randomUUID(),
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
    ai: { generate },
  });
  servers.push(server);
  return { server, generate, headers: { authorization: "Bearer " + token } };
}
it("checks real estimate and explicit available time without pretending unknown estimates fit", () => {
  const request = input(),
    task = request.context.tasks[0]!;
  expect(isAiTaskReady(task, request.context)).toBe(true);
  task.estimatedMinutes = 30;
  expect(isAiTaskReady(task, request.context)).toBe(false);
  task.estimatedMinutes = null;
  expect(isAiTaskReady(task, request.context)).toBe(false);
  request.context.availableMinutes = null;
  expect(isAiTaskReady(task, request.context)).toBe(true);
});
it.each(["plannedStart", "executionDate"] as const)(
  "does not bring future %s into immediate next actions",
  (field) => {
    const request = input(),
      task = request.context.tasks[0]!;
    task[field] = "2026-10-26";
    expect(isAiTaskReady(task, request.context)).toBe(false);
    expect(() =>
      validateAiProposal(proposal(request), request.context),
    ).toThrow("AI_UNREADY_SUGGESTION");
    task[field] = "2026-10-25";
    expect(isAiTaskReady(task, request.context)).toBe(true);
  },
);
it("resolves every evidence reference to an authorized source version and rejects fabricated or duplicate references", () => {
  const request = input(),
    value = proposal(request);
  expect(validateAiProposal(value, request.context).references).toHaveLength(3);
  for (const changed of [
    { kind: "record", id: randomUUID(), version: 4 },
    { kind: "record", id: request.context.recentRecords![0]!.id, version: 999 },
    { kind: "recovery", id: request.context.project!.id, version: 99 },
  ])
    expect(() =>
      validateAiProposal({ ...value, references: [changed] }, request.context),
    ).toThrow("AI_INVALID_REFERENCE");
  expect(() =>
    validateAiProposal(
      { ...value, references: [value.references![0], value.references![0]] },
      request.context,
    ),
  ).toThrow("AI_INVALID_REFERENCE");
  const { references: _, ...legacy } = value;
  expect(validateAiProposal(legacy, request.context).suggestedTaskId).toBe(
    value.suggestedTaskId,
  );
});
it("read tools return the frozen recovery card and excerpts and filter future or oversize work", async () => {
  const request = input(),
    ready = request.context.tasks[0]!;
  request.context.tasks.push(
    {
      ...ready,
      id: randomUUID(),
      title: "未来工作",
      executionDate: "2026-10-27",
    },
    { ...ready, id: randomUUID(), title: "过大工作", estimatedMinutes: 90 },
  );
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      bodies.push(body);
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "read",
                      type: "function",
                      function: { name: "read_project", arguments: "{}" },
                    },
                    {
                      id: "ready",
                      type: "function",
                      function: { name: "list_ready_tasks", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
        );
      const results = body.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => JSON.parse(m.content));
      expect(results[0].recovery.lastContext).toBe("已经选出五张照片");
      expect(results[0].recentRecords[0].id).toBe(
        request.context.recentRecords![0]!.id,
      );
      expect(results[1].tasks.map((t: any) => t.id)).toEqual([ready.id]);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(proposal(request)) },
            },
          ],
        }),
      );
    }),
  );
  const result = await modelGenerator({
    provider: "deepseek",
    apiKey: "fixture-only",
  })(request, new AbortController().signal);
  expect(result.proposal.references).toHaveLength(3);
  expect(JSON.stringify(bodies)).not.toContain("fixture-only");
});
it("accepts the new optional context through the authenticated run API", async () => {
  const { server, headers } = setup();
  const response = await server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers,
    payload: input(),
  });
  expect(response.statusCode).toBe(202);
});
it("rejects invalid calendar dates and context without its project before calling the model", async () => {
  const { server, headers, generate } = setup();
  const request = input();
  request.context.tasks[0]!.plannedStart = "2026-02-30";
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
  request.context.tasks[0]!.plannedStart = null;
  request.context.project = null;
  request.context.tasks = [];
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
it("applies an explicit UTF8 request budget before any provider call", async () => {
  const { server, headers, generate } = setup(),
    request = input();
  request.context.tasks = Array.from({ length: 100 }, () => ({
    ...request.context.tasks[0]!,
    id: randomUUID(),
    title: "",
  }));
  const overhead = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  const characters = Math.floor((120000 - overhead) / (3 * 100)) + 1;
  for (const task of request.context.tasks)
    task.title = "字".repeat(characters);
  expect(
    new TextEncoder().encode(JSON.stringify(request)).byteLength,
  ).toBeLessThan(131072);
  const response = await server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers,
    payload: request,
  });
  expect(response.statusCode).toBe(413);
  expect(response.json().error).toBe("AI_CONTEXT_TOO_LARGE");
  expect(generate).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps proposal wire compatibility for recovery protocol=%s",
  async (supportsRecovery) => {
    const request = input();
    if (!supportsRecovery) {
      delete request.context.recovery;
      delete request.context.recentRecords;
      delete request.context.truncated;
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        const schema = body.response_format.json_schema.schema;
        expect(Object.hasOwn(schema.properties, "references")).toBe(
          supportsRecovery,
        );
        const p: AiProposal = {
          summary: "继续已有行动",
          projectName: "",
          outcome: "",
          assumptions: [],
          question: null,
          nextAction: "挑选照片",
          tasks: [],
          reward: null,
          suggestedTaskId: request.context.tasks[0]!.id,
          references: [
            { kind: "task", id: request.context.tasks[0]!.id, version: 3 },
          ],
        };
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(p) },
              },
            ],
          }),
        );
      }),
    );
    const result = await modelGenerator({ apiKey: "fixture-only" })(
      request,
      new AbortController().signal,
    );
    expect(Object.hasOwn(result.proposal, "references")).toBe(supportsRecovery);
  },
);
