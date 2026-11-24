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
it("supports personal new_project two-level breakdown with leaf dependencies and rejects invalid hierarchy or estimates", async () => {
  const twoLevel: AiProposal = {
    ...proposal(),
    projectName: "个人作品集网站",
    outcome: "上线包含十个案例的作品集",
    suggestedTaskId: null,
    nextAction: "筛选十个代表项目",
    tasks: [
      {
        key: "s1",
        title: "第一阶段：准备内容",
        criteria: "十个案例素材整理完毕",
        estimatedMinutes: null,
        dependsOn: [],
        parentKey: null,
        notes: "先整理核心案例",
        deadline: null,
      },
      {
        key: "s2",
        title: "筛选十个代表项目",
        criteria: "列出十个项目标题和截图",
        estimatedMinutes: null,
        dependsOn: [],
        parentKey: "s1",
        notes: "",
        deadline: null,
      },
      {
        key: "s3",
        title: "撰写每个项目的简介",
        criteria: "十篇简介保存为文档",
        estimatedMinutes: null,
        dependsOn: ["s2"],
        parentKey: "s1",
        notes: "",
        deadline: null,
      },
      {
        key: "s4",
        title: "第二阶段：上线部署",
        criteria: "公开链接可访问",
        estimatedMinutes: null,
        dependsOn: ["s3"],
        parentKey: null,
        notes: "",
        deadline: "2026-12-20",
      },
    ],
  };
  const s = setup(twoLevel);
  const input: AiGenerateRequest = {
    id: randomUUID(),
    mode: "decompose",
    input: "年底前上线个人作品集网站",
    constraints: "新建个人项目并拆成两级任务与依赖",
    context: {
      date: "2026-11-12",
      timeZone: "Asia/Hong_Kong",
      project: null,
      source: null,
      tasks: [],
      personal: { scope: "new_project", readAt: "2026-11-12T04:00:00Z" },
    },
  };
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
  expect(run.proposal.projectName).toBe("个人作品集网站");
  expect(run.proposal.tasks).toHaveLength(4);
  expect(run.proposal.tasks[1]).toMatchObject({ parentKey: "s1", dependsOn: [] });
  expect(run.proposal.tasks[3]).toMatchObject({ parentKey: null, dependsOn: ["s3"] });

  // Rejects new_project with resume mode
  expect(
    (
      await s.server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers: s.headers,
        payload: { ...input, id: randomUUID(), mode: "resume" },
      })
    ).statusCode,
  ).toBe(400);

  // Rejects 3-level nesting
  expect(() =>
    validateAiProposal({
      ...twoLevel,
      tasks: [
        ...twoLevel.tasks,
        {
          key: "s5",
          title: "三级子任务",
          criteria: "结果",
          estimatedMinutes: null,
          dependsOn: [],
          parentKey: "s2",
        },
      ],
    }),
  ).toThrow("AI_INVALID_HIERARCHY");

  // Rejects dependency targeting a parent phase with subtasks
  expect(() =>
    validateAiProposal({
      ...twoLevel,
      tasks: twoLevel.tasks.map((t) =>
        t.key === "s4" ? { ...t, dependsOn: ["s1"] } : t,
      ),
    }),
  ).toThrow("AI_INVALID_DEPENDENCIES");

  // Rejects non-null estimatedMinutes in personal mode
  const withEstimate = setup({
    ...twoLevel,
    tasks: twoLevel.tasks.map((t, idx) =>
      idx === 1 ? { ...t, estimatedMinutes: 30 } : t,
    ),
  });
  const req2 = { ...input, id: randomUUID() };
  await withEstimate.server.inject({
    method: "POST",
    url: "/v1/ai/runs",
    headers: withEstimate.headers,
    payload: req2,
  });
  expect((await terminal(withEstimate, req2.id)).status).toBe("failed");
});
