import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID as uuid } from "node:crypto";
import net from "node:net";
import { chooseViewDate } from "./native-date-controls.mjs";

const root = resolve(import.meta.dirname, "..");
const exe = resolve(
  root,
  process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
);
const evidence = join(root, "docs/evidence/readonly-habits");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/readonly-habits-qa-"));
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
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const project = uuid(),
    habits = [uuid(), uuid()],
    suggested = uuid();
  await ipc("save_project", {
    command: command({
      projectId: project,
      expectedVersion: null,
      name: "Lorem related project",
      outcome: "",
      targetDate: null,
      priority: 0,
    }),
  });
  for (const i of [0, 1])
    await ipc("habit_command", {
      command: command({
        action: {
          type: "create",
          id: habits[i],
          name: `Lorem habit ${i + 1}`,
          startDate: today,
          frequency: "daily",
          weekdays: [],
          weeklyTarget: 7,
          triggerContext: "早餐后",
          normalVersion: "阅读 20 页",
          minimumVersion: "阅读 1 页",
          notes: "Lorem description\n第二行说明",
          projectId: project,
        },
      }),
    });
  await ipc("productivity_command", {
    command: command({
      action: {
        type: "task",
        id: suggested,
        expectedVersion: null,
        title: "Lorem suggested task",
        notes: "Lorem immutable suggestion",
        projectId: null,
        plan: null,
        deadline: { kind: "date", date: today },
        followUp: null,
        priority: 4,
        waitingFor: "",
        waitingNote: "",
        labels: [],
      },
    }),
  });
  await page.reload();
  const beforeTasks = (await ipc("productivity_snapshot")).tasks;
  const beforeHabits = (await ipc("habit_snapshot", { date: today })).habits;
  await page.locator(".timeline-attention > summary").click();
  const suggestions = page.locator(".task-suggestions");
  await expect(suggestions).toContainText("Lorem suggested task");
  await expect(suggestions).toContainText("当日截止");
  await expect(
    suggestions.locator(
      'button,input,select,textarea,form,[contenteditable="true"],.work-row,.work-badges,.work-times',
    ),
  ).toHaveCount(0);
  await suggestions.locator(".task-suggestion-title").click();
  await expect(page.locator(".task-detail,dialog[open]")).toHaveCount(0);
  expect((await ipc("productivity_snapshot")).tasks).toEqual(beforeTasks);
  checks.push(
    "Suggestions show only a title and one reason, with no editor, status control, modal or task mutation.",
  );
  const habitButton = (i) =>
    page.locator(`.day-period [data-habit-id="${habits[i]}"] .task-row`);
  const panel = page.getByRole("complementary", {
    name: "习惯详情",
    exact: true,
  });
  await habitButton(0).click();
  await expect(panel).toBeVisible();
  for (const text of [
    "只读",
    "Lorem habit 1",
    "Lorem description",
    "第二行说明",
    "早餐后",
    "阅读 20 页",
    "阅读 1 页",
    "Lorem related project",
    `${today} · 上午`,
    "每天",
  ])
    await expect(panel).toContainText(text);
  await expect(
    panel.locator('input,textarea,select,form,[contenteditable="true"]'),
  ).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(1);
  await expect(page.locator(".task-detail")).toHaveCount(1);
  await expect(habitButton(0)).toHaveAttribute("aria-expanded", "true");
  const mainBounds = await page.locator(".unified-timeline").boundingBox(),
    bounds = await panel.boundingBox();
  expect(mainBounds.x + mainBounds.width).toBeLessThanOrEqual(bounds.x + 1);
  await expect(panel.locator(".habit-detail-fields")).toHaveCSS(
    "display",
    "block",
  );
  const fields = await panel
    .locator(".habit-detail-fields .task-panel-field")
    .all();
  let previousBottom = 0;
  for (const field of fields) {
    const box = await field.boundingBox();
    expect(box.width).toBeGreaterThan(bounds.width - 4);
    expect(box.y).toBeGreaterThanOrEqual(previousBottom);
    expect((await field.locator("dt").boundingBox()).height).toBeLessThan(30);
    previousBottom = box.y + box.height;
  }
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await habitButton(1).click();
  await expect(
    panel.getByRole("heading", { name: "Lorem habit 2", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-detail")).toHaveCount(1);
  expect((await ipc("habit_snapshot", { date: today })).habits).toEqual(
    beforeHabits,
  );
  await page.screenshot({
    path: join(evidence, "readonly-habit-panel.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭习惯详情", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await habitButton(0).press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  checks.push(
    "Habit titles open one readonly right inspector; switching, closing and Escape perform no writes.",
  );
  await page
    .getByLabel("任务标题", { exact: true })
    .fill("Lorem ordinary task");
  await page.getByLabel("任务标题", { exact: true }).press("Enter");
  const taskRow = page
    .locator(".task-item[data-plan-id] .task-row")
    .filter({ hasText: "Lorem ordinary task" });
  await habitButton(0).click();
  await taskRow.click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "任务详情", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("编辑任务标题", { exact: true })).toBeEnabled();
  await habitButton(0).click();
  await expect(
    page.getByRole("complementary", { name: "任务详情", exact: true }),
  ).toHaveCount(0);
  await expect(panel).toBeVisible();
  await page
    .getByRole("button", { name: "完成习惯：Lorem habit 1", exact: true })
    .click();
  await expect(panel.locator(".habit-detail-status")).toHaveText("已完成");
  await page.locator(".completed-heading").click();
  await page
    .locator(`.completed-section [data-habit-id="${habits[0]}"] .task-row`)
    .click();
  await expect(panel).toHaveCount(0);
  await page
    .locator(`.completed-section [data-habit-id="${habits[0]}"] .task-row`)
    .click();
  await expect(panel.locator(".habit-detail-status")).toHaveText("已完成");
  await page
    .getByRole("button", { name: "撤销完成：Lorem habit 1", exact: true })
    .click();
  await expect(panel.locator(".habit-detail-status")).toHaveText("待完成");
  await page
    .getByRole("button", { name: "拖动排序：Lorem habit 1", exact: true })
    .press("ArrowRight");
  await expect(panel).toContainText(`${today} · 下午`);
  await chooseViewDate(page, tomorrow);
  await expect(panel).toHaveCount(0);
  await expect(habitButton(0)).toBeEnabled();
  await habitButton(0).click();
  await expect(panel).toContainText(`${tomorrow} · 下午`);
  await page.getByRole("button", { name: "近期", exact: true }).click();
  await expect(panel).toHaveCount(0);
  checks.push(
    "Task editing and habit inspection are mutually exclusive; the inspector refreshes after check-in, undo and dragging, and closes on date or view changes.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
}
