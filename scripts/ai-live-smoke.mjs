// Uses only synthetic examples. Reads credentials from the server environment and never prints them.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { aiEnvironment } from "../apps/api/dist/ai.js";
import { createServer } from "../apps/api/dist/server.js";

const options = aiEnvironment(process.env);
if (!options.apiKey) {
  console.error(
    "AI_NOT_CONFIGURED: set DEEPSEEK_API_KEY or PRAXIS_AI_API_KEY in the server environment.",
  );
  process.exitCode = 1;
} else {
  const token = randomUUID(),
    readyId = randomUUID();
  const server = createServer({
    databasePath: ":memory:",
    devices: [
      {
        ownerId: randomUUID(),
        deviceId: randomUUID(),
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
    ai: options,
  });
  const headers = { authorization: "Bearer " + token };
  const context = {
    date: new Date().toISOString().slice(0, 10),
    timeZone: "UTC",
    project: null,
    tasks: [],
    source: null,
  };
  const scenarios = [
    {
      name: "clarify",
      mode: "clarify",
      input: "我想开始学习摄影，发布第一组作品后奖励自己一次摄影出游。",
      constraints: "每周约两小时，先给出小范围可执行步骤。",
      context,
    },
    {
      name: "decompose",
      mode: "decompose",
      input: "用已有照片制作一个简单的摄影作品集。",
      constraints:
        "拆成三到五个步骤，每步有可观察的完成标准；不确定的估时填null。",
      context,
    },
    {
      name: "resume",
      mode: "resume",
      input:
        "我今天想继续推进作品集，请先读取已有任务并推荐一个已有可执行步骤。",
      constraints: "优先复用已有任务，不创建重复步骤。",
      context: {
        ...context,
        project: {
          id: randomUUID(),
          name: "摄影作品集",
          outcome: "发布一组十张照片",
          version: 1,
          planVersion: 1,
        },
        tasks: [
          {
            id: readyId,
            title: "挑选十张照片",
            status: "todo",
            version: 1,
            parentId: null,
            dependencies: [],
            estimatedMinutes: 15,
          },
          {
            id: randomUUID(),
            title: "发布作品页面",
            status: "todo",
            version: 1,
            parentId: null,
            dependencies: [readyId],
            estimatedMinutes: 30,
          },
        ],
      },
    },
  ];
  console.log(
    JSON.stringify({
      provider: options.provider,
      model: options.model,
      syntheticExamplesOnly: true,
      createsBusinessTasks: false,
    }),
  );
  try {
    for (const scenario of scenarios) {
      const { name, ...input } = scenario;
      const id = randomUUID(),
        startedAt = Date.now();
      const created = await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: { ...input, id },
      });
      if (created.statusCode !== 202)
        throw Error("AI_CREATE_REJECTED_" + created.statusCode);
      let run = created.json();
      while (run.status === "running" && Date.now() - startedAt < 50000) {
        await delay(200);
        run = (
          await server.inject({ url: "/v1/ai/runs/" + id, headers })
        ).json();
      }
      if (!["ready", "needs_input"].includes(run.status) || !run.proposal) {
        console.error(
          JSON.stringify({
            case: name,
            passed: false,
            status: run.status,
            code: run.error?.code ?? "AI_NO_RESULT",
          }),
        );
        process.exitCode = 1;
        break;
      }
      const passed =
        name !== "resume" || run.proposal.suggestedTaskId === readyId;
      console.log(
        JSON.stringify({
          case: name,
          passed,
          status: run.status,
          steps: run.proposal.tasks.length,
          existingTaskSuggested: !!run.proposal.suggestedTaskId,
          durationMs: Date.now() - startedAt,
        }),
      );
      if (!passed) {
        process.exitCode = 1;
        break;
      }
    }
  } catch {
    console.error(
      "AI_LIVE_CHECK_FAILED: no task writes were performed; credentials and response bodies are not logged.",
    );
    process.exitCode = 1;
  } finally {
    await server.close();
  }
}
