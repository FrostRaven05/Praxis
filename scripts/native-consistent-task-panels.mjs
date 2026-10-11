import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID as uuid } from "node:crypto";
import net from "node:net";

const root = resolve(import.meta.dirname, "..");
const exe = resolve(
  root,
  process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
);
const evidence = join(root, "docs/evidence/consistent-task-panels");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/panels-qa-"));
let browser, child, page;
const errors = [],
  checks = [];
async function start() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PRAXIS_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null)
      throw new Error(`Desktop exited: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await delay(250);
    }
  }
  if (!browser) throw new Error("Desktop did not start");
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator(".day-period").first().waitFor();
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.emulateMedia({ colorScheme: "light" });
}
const ipc = (name, args = {}) =>
  page.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
const command = (extra) => ({
  operationId: uuid(),
  occurredAt: new Date().toISOString(),
  ...extra,
});
async function interceptReply(taskId, notes, mode) {
  await page.evaluate(
    ({ taskId, notes, mode }) => {
      const callbacks = window.__TAURI_INTERNALS__.callbacks,
        original = callbacks.set;
      let nextResolve = null;
      window.__panelsQA = {
        replies: 0,
        restore: () => {
          callbacks.set = original;
        },
      };
      callbacks.set = function (id, callback) {
        const record = { reject: null };
        if (nextResolve) {
          nextResolve.reject = callback;
          nextResolve = null;
        } else nextResolve = record;
        return original.call(this, id, (result) => {
          if (result?.taskId === taskId && result.notes === notes) {
            window.__panelsQA.replies++;
            if (window.__panelsQA.replies === 1) {
              if (mode === "slow") {
                setTimeout(() => callback(result), 1200);
                return;
              }
              if (mode === "lostAck") {
                record.reject("QA save acknowledgement interrupted");
                return;
              }
            }
          }
          callback(result);
        });
      };
    },
    { taskId, notes, mode },
  );
}
const restoreReplies = () => page.evaluate(() => window.__panelsQA.restore());
async function expectInlineDateNavigation() {
  await expect(page.locator(".date-strip-row")).toHaveCount(1);
  const tabs = await page.locator(".timeline-switcher").boundingBox();
  const dates = await page.locator(".date-strip-row").boundingBox();
  expect(dates.width).toBe(560);
  expect(
    Math.abs(tabs.y + tabs.height / 2 - dates.y - dates.height / 2),
  ).toBeLessThan(1);
  expect(dates.x).toBeGreaterThan(tabs.x + tabs.width);
}
try {
  await start();
  await ipc("productivity_command", {
    command: command({
      action: {
        type: "zone",
        timeZone: "Asia/Hong_Kong",
        expectedVersion: null,
        expectedTemplates: [],
      },
    }),
  });
  const retainedCaptureId = uuid(),
    retainedRecordId = uuid();
  await ipc("content_command", {
    command: command({
      action: {
        type: "capture",
        id: retainedCaptureId,
        rawText: "Lorem retained capture",
      },
    }),
  });
  await ipc("content_command", {
    command: command({
      action: {
        type: "record",
        id: retainedRecordId,
        expectedVersion: null,
        title: "Lorem retained record",
        body: "Lorem retained body",
        recordType: "note",
        links: [],
      },
    }),
  });
  const projectId = uuid(),
    projectTaskId = uuid(),
    secondTaskId = uuid();
  await ipc("save_project", {
    command: command({
      projectId,
      expectedVersion: null,
      name: "Lorem panels",
      outcome: "Lorem ipsum dolor sit amet.",
      targetDate: null,
      priority: 0,
    }),
  });
  await ipc("add_project_tasks", {
    command: command({
      projectId,
      tasks: [
        { taskId: projectTaskId, title: "Lorem project task" },
        { taskId: secondTaskId, title: "Lorem second project task" },
      ],
    }),
  });
  await page.reload();
  await page.getByLabel("任务标题", { exact: true }).fill("Lorem today card");
  await page.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(page.locator(".task-item")).toHaveCount(1);
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1050 });
    await expectInlineDateNavigation();
    expect((await page.locator(".date-strip-row").boundingBox()).width).toBe(
      560,
    );
    await expect(page.locator(".day-period")).toHaveCount(3);
    for (const card of await page
      .locator(".day-period, .date-strip, .timeline-switcher button")
      .all()) {
      expect(
        await card.evaluate((e) =>
          parseFloat(getComputedStyle(e).borderRadius),
        ),
      ).toBeGreaterThanOrEqual(12);
    }
    await page.getByRole("button", { name: "近期", exact: true }).click();
    await expectInlineDateNavigation();
    expect((await page.locator(".date-strip-row").boundingBox()).width).toBe(
      560,
    );
    await page.getByRole("button", { name: "今日", exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({
    path: join(evidence, "today-cards.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 950 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.screenshot({
    path: join(evidence, "today-cards-390.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  checks.push(
    "Today/Upcoming tabs and date cards share one row at 1440px and 1920px; the date strip stays 560px and small windows do not overflow.",
  );

  await page
    .getByRole("button", { name: /收件箱/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "收件箱", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "待澄清原文", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "记录", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "内容类型", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("原始文字", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, "simple-inbox.png"),
    fullPage: true,
  });
  await page
    .getByLabel("收件箱任务标题", { exact: true })
    .fill("Lorem inbox task");
  await page.getByLabel("收件箱任务标题", { exact: true }).press("Enter");
  await page
    .locator(".inbox-task-title")
    .filter({ hasText: "Lorem inbox task" })
    .click();
  const inboxTask = (await ipc("list_inbox")).find(
    (t) => t.title === "Lorem inbox task",
  );
  const readInbox = () => ipc("task_details", { taskId: inboxTask.taskId });
  const title = () => page.getByLabel("编辑任务标题", { exact: true });
  const notes = () => page.locator("#panel-notes");
  const footer = () => page.locator(".inbox-task-panel .task-panel-footer");
  await expect(title()).toBeEnabled();
  expect(
    (await page.locator(".inbox-task-title").first().boundingBox()).width,
  ).toBeGreaterThan(300);
  expect(
    (await page.locator(".inbox-toolbar h1").boundingBox()).height,
  ).toBeLessThan(60);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  await title().evaluate((e) => (e.dataset.identity = "stable"));
  await title().fill("Lorem inbox live");
  await expect
    .poll(async () => (await readInbox()).title)
    .toBe("Lorem inbox live");
  await expect(title()).toBeFocused();
  await expect(title()).toHaveAttribute("data-identity", "stable");
  await notes().fill("Lorem inbox notes");
  await page
    .getByLabel("完成标准", { exact: true })
    .fill("Lorem inbox criteria");
  await page.getByRole("button", { name: "15 分钟", exact: true }).click();
  await page.getByLabel("重要任务", { exact: true }).check();
  await expect.poll(async () => (await readInbox()).important).toBe(true);
  await expect.poll(async () => (await readInbox()).estimatedMinutes).toBe(15);
  await expect(footer()).toContainText("已自动保存");
  expect(
    (await ipc("list_inbox")).filter((t) => t.taskId === inboxTask.taskId),
  ).toHaveLength(1);
  checks.push(
    "Inbox edits persist automatically without assigning a date or remounting the editor.",
  );
  await interceptReply(inboxTask.taskId, "Lorem inbox slow", "slow");
  await notes().fill("Lorem inbox slow");
  await expect(footer()).toContainText("正在保存");
  await expect(
    page
      .getByRole("navigation", { name: "项目列表", exact: true })
      .getByRole("button", { name: "Lorem panels", exact: true }),
  ).toBeDisabled();
  await expect(notes()).toBeEnabled();
  await notes().fill("Lorem inbox newest");
  await title().fill("Lorem inbox newest title");
  await expect
    .poll(async () => (await readInbox()).notes)
    .toBe("Lorem inbox newest");
  await expect
    .poll(async () => (await readInbox()).title)
    .toBe("Lorem inbox newest title");
  await expect(footer()).toContainText("已自动保存");
  await restoreReplies();
  await expect(
    page
      .getByRole("navigation", { name: "项目列表", exact: true })
      .getByRole("button", { name: "Lorem panels", exact: true }),
  ).toBeEnabled();
  await title().fill("");
  await expect(
    page.locator('.task-panel-feedback[role="alert"]'),
  ).toContainText("请填写任务标题");
  await title().fill("Lorem inbox recovered");
  await expect
    .poll(async () => (await readInbox()).title)
    .toBe("Lorem inbox recovered");
  await title().dispatchEvent("compositionstart");
  await title().fill("收件箱中文实时保存");
  await delay(700);
  expect((await readInbox()).title).toBe("Lorem inbox recovered");
  await title().dispatchEvent("compositionend");
  await expect
    .poll(async () => (await readInbox()).title)
    .toBe("收件箱中文实时保存");
  await expect(footer()).toContainText("已自动保存");
  await page.screenshot({
    path: join(evidence, "inbox-autosave.png"),
    fullPage: true,
  });
  checks.push(
    "Inbox queues input during writes, pauses IME composition and resumes after correcting invalid titles.",
  );
  await notes().fill("Lorem inbox flushed");
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await expect(page.locator(".inbox-task-panel")).toHaveCount(0);
  expect((await readInbox()).notes).toBe("Lorem inbox flushed");
  const retainedContent = await ipc("content_snapshot");
  expect(
    retainedContent.captures.find((capture) => capture.id === retainedCaptureId)
      .rawText,
  ).toBe("Lorem retained capture");
  expect(
    retainedContent.records.find((record) => record.id === retainedRecordId)
      .body,
  ).toBe("Lorem retained body");
  checks.push(
    "Inbox opens directly to tasks with capture/record controls removed; existing capture and record data survive reopening unchanged.",
  );
  await page
    .locator(".inbox-task-title")
    .filter({ hasText: "收件箱中文实时保存" })
    .click();
  await expect(title()).toBeEnabled();
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await expect(page.locator(".inbox-task-panel")).toHaveCount(0);
  await expect(page.locator(".day-period")).toHaveCount(3);
  await expect(page.locator(".task-item")).toContainText("收件箱中文实时保存");
  expect(
    (await ipc("list_inbox")).some((t) => t.taskId === inboxTask.taskId),
  ).toBe(false);
  checks.push(
    "Closing inbox details flushes pending edits; choosing a date schedules the same task immediately.",
  );

  await page
    .getByRole("navigation", { name: "项目列表", exact: true })
    .getByRole("button", { name: "Lorem panels", exact: true })
    .click();
  const taskButton = () => page.locator(".project-task-title").first();
  await taskButton().click();
  const panel = () =>
    page.getByRole("complementary", { name: "项目任务详情", exact: true });
  const ptitle = () => panel().getByLabel("编辑任务标题", { exact: true });
  const pnotes = () => panel().getByLabel("任务描述", { exact: true });
  const pfooter = () => panel().locator(".task-panel-footer");
  const readProject = () => ipc("task_details", { taskId: projectTaskId });
  await expect(ptitle()).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel()).toHaveCount(1);
  const mainBounds = await page.locator(".projects-view").boundingBox();
  const panelBounds = await panel().boundingBox();
  expect(mainBounds.x + mainBounds.width).toBeLessThanOrEqual(
    panelBounds.x + 1,
  );
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".projects-view").closest("[inert]") !== null,
    ),
  ).toBe(false);
  await page.screenshot({
    path: join(evidence, "project-list-panel.png"),
    fullPage: true,
  });
  await expect(
    panel().getByRole("button", { name: "保存任务详情", exact: true }),
  ).toHaveCount(0);
  await ptitle().evaluate((e) => (e.dataset.identity = "stable"));
  await ptitle().fill("Lorem project live");
  await expect
    .poll(async () => (await readProject()).title)
    .toBe("Lorem project live");
  await expect(ptitle()).toBeFocused();
  await expect(ptitle()).toHaveAttribute("data-identity", "stable");
  await expect(taskButton()).toContainText("Lorem project live");
  await interceptReply(projectTaskId, "Lorem project slow", "slow");
  await pnotes().fill("Lorem project slow");
  await expect(pfooter()).toContainText("正在保存");
  await expect(pnotes()).toBeEnabled();
  await pnotes().fill("Lorem project newest");
  await ptitle().fill("Lorem project newest title");
  await expect
    .poll(async () => (await readProject()).title)
    .toBe("Lorem project newest title");
  await expect
    .poll(async () => (await readProject()).notes)
    .toBe("Lorem project newest");
  await expect(pfooter()).toContainText("已自动保存");
  await restoreReplies();
  const beforeRetry = (await readProject()).version;
  await interceptReply(projectTaskId, "Lorem project retry", "lostAck");
  await pnotes().fill("Lorem project retry");
  await expect(panel().getByRole("alert")).toContainText(
    "QA save acknowledgement interrupted",
  );
  await delay(700);
  expect(await page.evaluate(() => window.__panelsQA.replies)).toBe(1);
  await panel()
    .getByRole("button", { name: "重试自动保存", exact: true })
    .click();
  await expect(pfooter()).toContainText("已自动保存");
  expect(await page.evaluate(() => window.__panelsQA.replies)).toBe(2);
  await restoreReplies();
  expect((await readProject()).version).toBe(beforeRetry + 1);
  checks.push(
    "Project details refresh the task list live, keep input enabled while saving and recover unacknowledged writes without duplicate versions.",
  );
  await panel()
    .getByLabel("完成标准", { exact: true })
    .fill("Lorem project flushed");
  await panel()
    .getByRole("button", { name: "关闭任务详情", exact: true })
    .click();
  await expect(panel()).toHaveCount(0);
  expect((await readProject()).completionCriteria).toBe(
    "Lorem project flushed",
  );
  await page.getByRole("tab", { name: "看板", exact: true }).click();
  await page.locator(".kanban-task-title").first().click();
  await panel().getByLabel("重要任务", { exact: true }).check();
  await expect.poll(async () => (await readProject()).important).toBe(true);
  await expect(pfooter()).toContainText("已自动保存");
  await page.screenshot({
    path: join(evidence, "project-autosave.png"),
    fullPage: true,
  });
  checks.push(
    "Project list and board share the same autosave behavior, task identity and values; closing details flushes edits.",
  );
  await page
    .locator(".kanban-task-title")
    .filter({ hasText: "Lorem second project task" })
    .click();
  await expect(ptitle()).toHaveValue("Lorem second project task");
  await expect(panel()).toHaveCount(1);
  await pnotes().fill("Lorem second task saved");
  await expect
    .poll(
      async () => (await ipc("task_details", { taskId: secondTaskId })).notes,
    )
    .toBe("Lorem second task saved");
  await expect(pfooter()).toContainText("已自动保存");
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await expect(panel()).toHaveCount(1);
  await expect(pnotes()).toHaveValue("Lorem second task saved");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.getByRole("tab", { name: "看板", exact: true }).click();
  await page
    .locator(".kanban-task-title")
    .filter({ hasText: "Lorem project newest title" })
    .click();
  await expect(ptitle()).toHaveValue("Lorem project newest title");
  const selectedCard = page.locator(".kanban-card").filter({
    has: page
      .locator(".kanban-task-title")
      .filter({ hasText: "Lorem project newest title" }),
  });
  await selectedCard
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await expect(panel().locator(".task-status-pill").first()).toHaveText(
    "已完成",
  );
  await expect(ptitle()).toBeEnabled();
  await pnotes().fill("Lorem after completion");
  await expect
    .poll(async () => (await readProject()).notes)
    .toBe("Lorem after completion");
  await expect(pfooter()).toContainText("已自动保存");
  checks.push(
    "A single non-modal side panel switches tasks and persists across list, board and Gantt; background status changes refresh its version safely.",
  );
  await pnotes().fill("Lorem project window close");
  await ipc("plugin:window|close", { label: "main" });
  await expect.poll(() => child.exitCode, { timeout: 10000 }).not.toBe(null);
  await browser.close();
  browser = undefined;
  await start();
  expect((await readProject()).notes).toBe("Lorem project window close");
  expect((await readInbox()).notes).toBe("Lorem inbox flushed");
  checks.push(
    "Native window close flushes project edits; reopening restores inbox and project details from SQLite.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  if (page && !page.isClosed())
    await page.screenshot({
      path: join(evidence, "failed.png"),
      fullPage: true,
    });
  throw e;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
}
