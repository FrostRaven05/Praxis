import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server";
import type { AiGenerateRequest, AiProposal } from "./ai-contract";
import { validateAiProposal } from "./ai-contract";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
const ready = randomUUID();
const request = (): AiGenerateRequest => ({
  id: randomUUID(),
  mode: "resume",
  input: "解释一个已有下一步",
  constraints: "只读",
  context: {
    date: "2026-11-12",
    timeZone: "Asia/Hong_Kong",
    project: null,
    source: null,
    personal: { scope: "todos", readAt: "2026-11-12T04:00:00Z" },
    tasks: [
      {
        id: ready,
        title: "已有任务",
        status: "todo",
        version: 1,
        dependencies: [],
        estimatedMinutes: null,
      },
    ],
  },
});
const proposal = (): AiProposal => ({
  summary: "已有任务可继续",
  projectName: "",
  outcome: "",
  assumptions: [],
  question: null,
  nextAction: "继续已有任务",
  tasks: [],
  reward: null,
  suggestedTaskId: ready,
  references: [],
});
function setup(result = proposal()) {
  const token = randomUUID(),
    otherToken = randomUUID();
  let calls = 0;
  const server = createServer({
    databasePath: ":memory:",
    devices: [token, otherToken].map((token) => ({
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
    })),
    ai: {
      generate: async () => {
        calls++;
        return { proposal: result, model: "fixture" };
      },
    },
  });
  servers.push(server);
  return {
    server,
    headers: { authorization: "Bearer " + token },
    other: { authorization: "Bearer " + otherToken },
    calls: () => calls,
  };
}
async function terminal(s: ReturnType<typeof setup>, id: string) {
  for (let i = 0; i < 40; i++) {
    const run = (
      await s.server.inject({ url: "/v1/ai/runs/" + id, headers: s.headers })
    ).json();
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("no terminal result");
}
it("accepts authenticated personal todo context only for readonly resume, replays its run and isolates another account", async () => {
  const s = setup(),
    input = request();
  expect(
    (
      await s.server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers: s.headers,
        payload: input,
      })
    ).statusCode,
  ).toBe(202);
  const run = await terminal(s, input.id);
  expect(run.status).toBe("ready");
  expect(run.proposal.suggestedTaskId).toBe(ready);
  expect(run.proposal.tasks).toEqual([]);
  expect(
    (
      await s.server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers: s.headers,
        payload: input,
      })
    ).statusCode,
  ).toBe(202);
  expect(s.calls()).toBe(1);
  expect(
    (
      await s.server.inject({
        url: "/v1/ai/runs/" + input.id,
        headers: s.other,
      })
    ).statusCode,
  ).toBe(404);
  const invalid = { ...request(), mode: "decompose" };
  expect(
    (
      await s.server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers: s.headers,
        payload: invalid,
      })
    ).statusCode,
  ).toBe(400);
});
it("rejects new-task or reward content in a personal readonly model result", async () => {
  const p = proposal();
  p.tasks = [
    {
      key: "s1",
      title: "模型越界新增",
      criteria: "结果",
      estimatedMinutes: null,
      dependsOn: [],
    },
  ];
  const s = setup(p),
    input = request();
  await s.server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers: s.headers,
    payload: input,
  });
  expect((await terminal(s, input.id)).status).toBe("failed");
});
it("accepts optional personal task notes/date while old proposal shapes still work and invalid dates fail", async () => {
  const s = setup({
      ...proposal(),
      suggestedTaskId: null,
      tasks: [
        {
          key: "s1",
          title: "新行动",
          criteria: "明确结果",
          notes: "说明",
          deadline: "2026-12-01",
          estimatedMinutes: null,
          dependsOn: [],
        },
      ],
    }),
    input = request();
  input.mode = "decompose";
  input.context.project = {
    id: randomUUID(),
    name: "目标",
    outcome: "",
    version: 1,
    planVersion: 0,
  };
  input.context.personal!.scope = "project";
  await s.server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers: s.headers,
    payload: input,
  });
  expect((await terminal(s, input.id)).proposal.tasks[0]).toMatchObject({
    notes: "说明",
    deadline: "2026-12-01",
  });
  expect(() =>
    validateAiProposal({
      ...proposal(),
      suggestedTaskId: null,
      tasks: [
        {
          key: "s1",
          title: "日期",
          criteria: "结果",
          estimatedMinutes: null,
          dependsOn: [],
          deadline: "2026-02-30",
        },
      ],
    }),
  ).toThrow("AI_INVALID_TASK");
});
