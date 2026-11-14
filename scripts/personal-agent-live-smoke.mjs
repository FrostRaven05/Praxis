// Real provider; synthetic contexts in an isolated in-memory service. Never prints credentials.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { aiEnvironment } from "../apps/api/dist/ai.js";
import { createServer } from "../apps/api/dist/server.js";
const evidence = resolve("docs/evidence/p3-2026-11-12"),
  options = aiEnvironment(process.env);
await mkdir(evidence, { recursive: true });
const report = {
  executedAt: new Date().toISOString(),
  syntheticOnly: true,
  businessTaskWrites: false,
  configured: !!options.apiKey,
  provider: options.provider ?? null,
  model: options.model ?? null,
  cases: [],
  passed: false,
};
if (!options.apiKey) {
  report.error = "AI_NOT_CONFIGURED";
} else {
  const token = randomUUID(),
    readyId = randomUUID(),
    projectId = randomUUID();
  const server = createServer({
    databasePath: ":memory:",
    devices: [
      {
        ownerId: randomUUID(),
        deviceId: randomUUID(),
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
    ai: { ...options, timeoutMs: 45000 },
  });
  const headers = { authorization: "Bearer " + token };
  const context = {
    date: new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Hong_Kong",
    }),
    timeZone: "Asia/Hong_Kong",
    project: null,
    tasks: [],
    source: null,
    personal: { scope: "project", readAt: new Date().toISOString() },
  };
  const scenarios = [
    {
      name: "personal-flat-decompose",
      mode: "decompose",
      input: "为周末短途徒步准备一个简单出行清单，请拆成三至五个可执行行动。",
      constraints:
        "只要平铺行动，无依赖、估时或奖励。没有硬截止日期，不编造日期。",
      context: {
        ...context,
        project: {
          id: projectId,
          name: "周末短途徒步准备",
          outcome: "完成出发前准备",
          version: 1,
          planVersion: 0,
        },
      },
    },
    {
      name: "personal-todo-readonly",
      mode: "resume",
      input:
        "从我的现有任务中找一个可继续的下一步。优先已有任务，不创建或修改任务。",
      constraints: "仅解释已有可执行任务，不推荐阻塞任务。",
      context: {
        ...context,
        personal: {
          ...context.personal,
          scope: "todos",
          candidateTaskIds: [readyId],
        },
        tasks: [
          {
            id: readyId,
            title: "检查徒步装备清单",
            status: "todo",
            version: 1,
            parentId: null,
            dependencies: [],
            estimatedMinutes: null,
          },
          {
            id: randomUUID(),
            title: "等待同伴回复交通时间",
            status: "blocked",
            version: 1,
            parentId: null,
            dependencies: [],
            estimatedMinutes: null,
          },
        ],
      },
    },
  ];
  try {
    for (const scenario of scenarios) {
      const { name, ...input } = scenario,
        id = randomUUID(),
        started = Date.now();
      const created = await server.inject({
        method: "POST",
        url: "/v1/ai/runs",
        headers,
        payload: { ...input, id },
      });
      if (created.statusCode !== 202) {
        report.cases.push({
          name,
          passed: false,
          status: created.statusCode,
          error: "AI_CREATE_REJECTED",
        });
        break;
      }
      let run = created.json();
      while (run.status === "running" && Date.now() - started < 55000) {
        await delay(250);
        run = (
          await server.inject({ url: "/v1/ai/runs/" + id, headers })
        ).json();
      }
      const p = run.proposal;
      const passed =
        run.status === "ready" &&
        !!p &&
        (name === "personal-flat-decompose"
          ? p.tasks.length >= 1 &&
            p.tasks.length <= 8 &&
            p.tasks.every(
              (t) => !t.dependsOn.length && t.estimatedMinutes === null,
            ) &&
            p.reward === null
          : !p.tasks.length &&
            p.suggestedTaskId === readyId &&
            p.reward === null);
      report.cases.push({
        name,
        passed,
        status: run.status,
        model: run.model ?? null,
        steps: p?.tasks?.length ?? 0,
        notesAndDateSupported: !!p?.tasks?.every(
          (t) => typeof t.notes === "string" && Object.hasOwn(t, "deadline"),
        ),
        existingTaskMatched: p?.suggestedTaskId === readyId,
        error: run.error?.code ?? null,
        durationMs: Date.now() - started,
      });
      if (!passed) break;
    }
    report.passed =
      report.cases.length === 2 && report.cases.every((c) => c.passed);
  } catch {
    report.error = "AI_LIVE_CHECK_FAILED";
  } finally {
    await server.close();
  }
}
await writeFile(
  resolve(evidence, "live-model.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!report.passed) process.exitCode = 1;
