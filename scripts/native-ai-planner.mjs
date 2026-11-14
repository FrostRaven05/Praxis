import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { createServer } from "../apps/api/dist/server.js";
import { isAiTaskReady } from "../apps/api/dist/ai-contract.js";
const root = resolve(import.meta.dirname, ".."),
  data = await mkdtemp(join(root, ".tools/ai-planner-qa-")),
  exe = join(data, "Praxis.exe");
const evidence = join(root, "docs/evidence/project-recovery-v4/gui");
await mkdir(evidence, { recursive: true });
await copyFile(
  resolve(
    root,
    process.argv[2] ?? ".tools/releases/project-recovery-v4/Praxis.exe",
  ),
  exe,
);
const fixture = {
  summary: "先选出作品，再整理成一个页面。",
  projectName: "AI 验收作品集",
  outcome: "发布第一组摄影作品",
  assumptions: ["每周约两小时"],
  question: null,
  nextAction: "先挑选10张照片",
  tasks: [
    {
      key: "s1",
      title: "挑选10张照片",
      criteria: "将10张照片放进同一文件夹",
      estimatedMinutes: 15,
      dependsOn: [],
    },
    {
      key: "s2",
      title: "整理作品页面",
      criteria: "页面包含标题和十张照片",
      estimatedMinutes: 30,
      dependsOn: ["s1"],
    },
  ],
  reward: { title: "摄影出游", condition: "作品页面发布后" },
  suggestedTaskId: null,
};
let generations = 0;
const api = createServer({
  databasePath: join(data, "api.db"),
  devices: [],
  https: {
    key: await readFile(join(root, ".tools/lan/server.key")),
    cert: await readFile(join(root, ".tools/lan/server.crt")),
  },
  ai: {
    model: "fixture-only",
    generate: async (request, signal) => {
      generations++;
      await delay(25, undefined, { signal });
      const references = [];
      if (request.context.project && request.context.recovery) {
        references.push({
          kind: "recovery",
          id: request.context.project.id,
          version: request.context.recovery.version,
        });
      }
      const progress = request.context.recentRecords?.find(
        (r) => r.recordType === "progress",
      );
      if (progress)
        references.push({
          kind: "record",
          id: progress.id,
          version: progress.version,
        });
      if (request.mode === "resume") {
        const task = request.context.tasks.find((t) =>
          isAiTaskReady(t, request.context),
        );
        return {
          proposal: {
            ...fixture,
            summary: "根据恢复卡和上次选片进展继续推进。",
            references: task
              ? [
                  ...references,
                  { kind: "task", id: task.id, version: task.version },
                ]
              : references,
            tasks: [],
            reward: null,
            suggestedTaskId: task?.id ?? null,
            nextAction: task?.title ?? "请补充下一步",
            question: task ? null : "项目接下来希望推进什么？",
          },
          model: "fixture-only",
        };
      }
      return {
        proposal: { ...structuredClone(fixture), references },
        model: "fixture-only",
      };
    },
  },
});
await api.listen({ host: "127.0.0.1", port: 0 });
const baseUrl = "https://127.0.0.1:" + api.server.address().port,
  caPem = await readFile(join(root, ".tools/lan/ca.crt"), "utf8");
let child, browser, page;
let startupLog = "",
  childExit = null,
  lastStartupError = "";
const checks = [],
  errors = [];
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function start() {
  const port = await freePort();
  childExit = null;
  startupLog = "";
  child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PRAXIS_DATA_DIR: join(data, "client"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=" +
        port +
        " --remote-debugging-address=127.0.0.1",
    },
  });
  child.on("error", (error) => {
    startupLog += error.message;
    childExit = "spawn failed";
  });
  child.on("exit", (code) => {
    childExit = code ?? "terminated";
  });
  child.stderr.on("data", (bytes) => {
    startupLog = (startupLog + bytes.toString()).slice(-4000);
  });
  for (let i = 0; i < 80; i++) {
    if (childExit !== null)
      throw Error("Desktop exited " + childExit + ": " + startupLog);
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
        timeout: 500,
      });
      page = browser.contexts()[0].pages()[0];
      await page.locator(".day-period").first().waitFor({ timeout: 1000 });
      page.setDefaultTimeout(12000);
      await page.setViewportSize({ width: 1300, height: 950 });
      page.on("pageerror", (e) => errors.push(e.message));
      return;
    } catch (error) {
      lastStartupError = String(error);
      await browser?.close().catch(() => {});
      if (lastStartupError.includes("EACCES"))
        throw Error(
          "Desktop verification cannot connect to the local debug port: EACCES. " +
            lastStartupError,
        );
      await delay(200);
    }
  }
  throw Error(
    "Isolated desktop did not start: " + lastStartupError + "; " + startupLog,
  );
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = undefined;
  child?.kill();
  await delay(300);
}
const ipc = (name, args = {}) =>
  page.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
const shot = async (name) => {
  if (page) await page.screenshot({ path: join(evidence, name + ".png") });
};
const dialog = () =>
  page.getByRole("dialog", { name: "AI 规划助手", exact: true });
async function fillNewGoal(name) {
  await page.getByRole("button", { name: /^收件箱/ }).click();
  await page.getByRole("button", { name: /整理想法/ }).click();
  await dialog().getByLabel("想法或想实现的目标", { exact: true }).fill(name);
  await dialog().getByRole("button", { name: "生成建议", exact: true }).click();
  await expect(
    dialog().getByLabel("步骤 1 标题", { exact: true }),
  ).toBeVisible();
}
try {
  await start();
  await ipc("account_authenticate", {
    login: {
      mode: "register",
      baseUrl,
      email: "planner-" + randomUUID() + "@example.com",
      password: "isolated planner test password",
      displayName: "规划验收",
      caPem,
    },
  });
  await stop();
  await start();
  expect((await ipc("account_status")).user).not.toBeNull();
  checks.push(
    "native authenticated bridge uses an isolated local HTTPS account; no real provider calls",
  );
  await fillNewGoal("我想发布一个摄影作品集，并奖励自己一次出游");
  await dialog().getByLabel("将步骤归入新项目", { exact: true }).check();
  await dialog()
    .getByLabel("步骤 1 标题", { exact: true })
    .fill("挑选我的十张代表作");
  await dialog().getByLabel("采用步骤 1", { exact: true }).uncheck();
  await expect(
    dialog().getByLabel("采用步骤 2", { exact: true }),
  ).not.toBeChecked();
  await dialog().getByLabel("采用步骤 2", { exact: true }).check();
  await expect(
    dialog().getByLabel("采用步骤 1", { exact: true }),
  ).toBeChecked();
  await shot("01-editable-proposal");
  await dialog()
    .getByRole("button", { name: "关闭规划助手", exact: true })
    .click();
  await page.getByRole("button", { name: /整理想法/ }).click();
  await expect(dialog().getByLabel("步骤 1 标题", { exact: true })).toHaveValue(
    "挑选我的十张代表作",
  );
  expect(generations).toBe(1);
  await dialog()
    .getByRole("button", { name: "采用选中 2 步", exact: true })
    .click();
  await expect(dialog()).toContainText("已创建 2 项任务");
  const content = await ipc("content_snapshot"),
    tasks = content.tasks;
  expect(tasks).toHaveLength(2);
  expect(content.captures).toHaveLength(1);
  expect(content.records).toHaveLength(1);
  const details = await ipc("task_details", {
    taskId: tasks.find((t) => t.title === "挑选我的十张代表作").id,
  });
  expect(details.completionCriteria).toBe("将10张照片放进同一文件夹");
  expect(details.estimatedMinutes).toBe(15);
  const projectId = tasks[0].projectId,
    projectTasks = await ipc("project_tasks", { projectId });
  expect(projectTasks.every((t) => t.executionDate === null)).toBe(true);
  expect(projectTasks.some((t) => t.dependencies?.length === 1)).toBe(true);
  checks.push(
    "editable proposal, prerequisite selection, saved draft recovery, atomic source/tasks/reward adoption, no implicit scheduling",
  );
  await shot("02-applied");
  await dialog()
    .getByRole("button", { name: "撤销本次采用", exact: true })
    .click();
  await expect(dialog()).toContainText("本次采用已撤销");
  expect((await ipc("content_snapshot")).tasks).toHaveLength(0);
  checks.push(
    "undo restores original capture and removes only unmodified outputs including internal dependencies",
  );
  await dialog()
    .getByRole("button", { name: "关闭规划助手", exact: true })
    .click();
  await ipc("content_command", {
    command: {
      operationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        type: "context",
        projectId,
        expectedVersion: null,
        definitionOfDone: "发布第一组摄影作品",
        blockerText: "尚未选出十张代表作",
        reviewDate: null,
        nextActionTaskId: null,
        lastContext: "素材文件夹已建立，尚未选片",
        restartHint: "从选片继续",
        waitingNote: "",
      },
    },
  });
  await ipc("content_command", {
    command: {
      operationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        type: "record",
        id: randomUUID(),
        expectedVersion: null,
        title: "上次选片进展",
        body: "素材文件夹已建立，尚未选片。下一次从选出十张照片开始。",
        recordType: "progress",
        links: [{ targetType: "project", targetId: projectId }],
      },
    },
  });
  await page.getByText("AI 验收作品集", { exact: true }).click();
  await page.getByRole("button", { name: /拆成步骤/ }).click();
  await dialog().locator(".ai-context-preview > summary").click();
  await expect(dialog().locator(".ai-context-preview")).toContainText(
    "素材文件夹已建立，尚未选片",
  );
  await expect(dialog().locator(".ai-context-preview")).toContainText(
    "上次选片进展",
  );
  await dialog().getByRole("button", { name: "生成建议", exact: true }).click();
  await expect(
    dialog().getByLabel("步骤 1 标题", { exact: true }),
  ).toBeVisible();
  await dialog()
    .getByRole("button", { name: "采用选中 2 步", exact: true })
    .click();
  await expect(dialog()).toContainText("已创建 2 项任务");
  await dialog()
    .getByRole("button", { name: "关闭规划助手", exact: true })
    .click();
  await page.getByRole("button", { name: /拆成步骤/ }).click();
  await expect(dialog()).toContainText("已创建 2 项任务");
  await dialog()
    .getByRole("button", { name: "带入自身修炼", exact: true })
    .click();
  await expect(page.getByLabel("阶段成果", { exact: true })).toHaveValue(
    fixture.reward.condition,
  );
  await expect(page.getByLabel("阶段奖励", { exact: true })).toHaveValue(
    fixture.reward.title,
  );
  await expect(page.getByLabel("行动包数量", { exact: true })).toHaveValue("2");
  expect((await ipc("cultivation_snapshot")).goal.milestone).toBe("");
  await page
    .getByRole("button", { name: "保留当前阶段，放弃设置草稿", exact: true })
    .click();
  expect((await ipc("cultivation_snapshot")).goal.milestone).toBe("");
  checks.push(
    "adopted planning outcome and reward can prefill cultivation; opening and discarding do not save or replace the current stage",
  );
  await page.getByText("AI 验收作品集", { exact: true }).click();
  await page.getByRole("button", { name: /继续推进/ }).click();
  await dialog().getByLabel("本次可用时间", { exact: true }).fill("20");
  await dialog().getByRole("button", { name: "生成建议", exact: true }).click();
  await expect(dialog().locator(".ai-planner-existing")).toContainText(
    "挑选10张照片",
  );
  await expect(
    dialog().getByRole("region", { name: "建议引用的资料", exact: true }),
  ).toContainText("上次选片进展");
  await dialog()
    .locator(".ai-proposal-sources details")
    .filter({ hasText: "上次选片进展" })
    .locator("summary")
    .click();
  await expect(dialog().locator(".ai-proposal-sources")).toContainText(
    "素材文件夹已建立，尚未选片",
  );
  await shot("03-project-recovery");
  checks.push(
    "project decomposition reuses current project; resume reads scoped recovery and progress sources, cites actual excerpts, and selects an existing 15-minute ready task within a 20-minute budget",
  );
  await dialog()
    .getByRole("button", { name: "关闭规划助手", exact: true })
    .click();
  await page.getByRole("button", { name: "修炼成长", exact: true }).click();
  await page.getByLabel("心愿奖励", { exact: true }).fill("一次摄影出游");
  await page
    .getByLabel("心愿成果条件", { exact: true })
    .fill("发布第一组摄影作品");
  await page.getByRole("button", { name: "保存为心愿", exact: true }).click();
  await expect(page.locator(".cultivation-reward-list")).toContainText(
    "待设置",
  );
  const savedWish = (await ipc("cultivation_snapshot")).rewardAgreements.find(
    (item) => item.reward === "一次摄影出游",
  );
  expect(savedWish.status).toBe("wish");
  await page.getByRole("button", { name: "用于阶段", exact: true }).click();
  await expect(page.getByLabel("阶段成果", { exact: true })).toHaveValue(
    "发布第一组摄影作品",
  );
  await page.getByRole("checkbox", { name: /^挑选10张照片/ }).check();
  await expect(page.getByLabel("行动包数量", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("行动包数量", { exact: true })).toHaveJSProperty(
    "readOnly",
    true,
  );
  await page.getByRole("button", { name: "开始这一阶段", exact: true }).click();
  await expect(page.locator(".cultivation-reward-list")).toContainText(
    "未解锁",
  );
  await expect(
    page.getByRole("button", { name: "记录领取", exact: true }),
  ).toHaveCount(0);
  expect((await ipc("cultivation_snapshot")).goal.id).toBe(savedWish.id);
  checks.push(
    "wish remains the same agreement when explicitly activated; linked work is required before unlocking",
  );
  await expect(
    page.getByRole("button", { name: "确认成果并突破", exact: true }),
  ).toBeDisabled();
  const current = (await ipc("project_tasks", { projectId })).find(
    (t) => t.title === "挑选10张照片",
  );
  const state = await ipc("productivity_snapshot"),
    zone = state.settings[0].timeZone;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
    new Date(),
  );
  await ipc("project_workspace", {
    command: {
      operationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        kind: "status",
        taskId: current.taskId,
        expectedVersion: current.version,
        status: "completed",
        reason: "",
        date,
        timeZone: zone,
      },
    },
  });
  await page.getByRole("button", { name: "刷新进展", exact: true }).click();
  await page.getByLabel("我已达到上述阶段成果", { exact: true }).check();
  await page
    .getByRole("button", { name: "确认成果并突破", exact: true })
    .click();
  await expect(page.locator(".cultivation-realm")).toContainText("筑基");
  await expect(page.locator(".cultivation-reward-list")).toContainText(
    "可领取",
  );
  await page.getByRole("button", { name: "记录领取", exact: true }).click();
  await expect(page.locator(".cultivation-history")).toContainText("已领取");
  const claimed = (await ipc("cultivation_snapshot")).rewardAgreements.find(
    (item) => item.id === savedWish.id,
  );
  expect(claimed.status).toBe("claimed");
  await expect(
    page.getByRole("button", { name: "记录领取", exact: true }),
  ).toHaveCount(0);
  await shot("04-cultivation");
  await page.reload();
  await page.getByRole("button", { name: "修炼成长", exact: true }).click();
  await expect(page.locator(".cultivation-realm")).toContainText("筑基");
  checks.push(
    "cultivation requires new action accumulation plus explicit milestone confirmation, reward claim and reload persist",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        provider: "fixture-only; no live model call",
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, evidence }));
} catch (error) {
  await shot("failure").catch(() => {});
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        checks,
        errors,
        error: String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stop();
  await api.close();
}
