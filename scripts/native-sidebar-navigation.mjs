import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID as uuid } from "node:crypto";
import net from "node:net";

const root = resolve(import.meta.dirname, "..");
const evidence = join(root, "docs/evidence/sidebar-cleanup");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/sidebar-qa-"));
const server = net.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const child = spawn(
  resolve(
    root,
    process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
  ),
  [],
  {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PRAXIS_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  },
);
let browser;
const errors = [],
  checks = {};
try {
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
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  const ipc = (name, args = {}) =>
    page.evaluate(
      ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
      { name, args },
    );
  await page.locator(".day-period").first().waitFor();
  const projectId = uuid();
  const command = (action) => ({
    operationId: uuid(),
    occurredAt: new Date().toISOString(),
    action,
  });
  await ipc("productivity_command", {
    command: command({
      type: "zone",
      timeZone: "Asia/Hong_Kong",
      expectedVersion: null,
      expectedTemplates: [],
    }),
  });
  await ipc("save_project", {
    command: {
      operationId: uuid(),
      occurredAt: new Date().toISOString(),
      projectId,
      expectedVersion: null,
      name: "Lorem project",
      outcome: "Lorem ipsum dolor sit amet.",
      targetDate: null,
      priority: 0,
    },
  });
  await ipc("add_project_tasks", {
    command: {
      operationId: uuid(),
      occurredAt: new Date().toISOString(),
      projectId,
      tasks: [{ taskId: uuid(), title: "Lorem task" }],
    },
  });
  const names = [];
  for (let i = 0; i < 12; i++) {
    const name = `Lorem saved filter ${i} with a very long name for desktop navigation`;
    names.push(name);
    await ipc("view_command", {
      command: command({
        type: "save",
        id: uuid(),
        expectedVersion: null,
        name,
        followed: true,
        query: {
          text: "",
          entityType: "task",
          projectId,
          status: null,
          includeArchived: false,
          groups: [],
          sort: "title",
          groupBy: "type",
        },
      }),
    });
  }
  await page.reload();
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1160, height: 800 });
  const project = page
    .getByRole("navigation", { name: "项目列表", exact: true })
    .getByRole("button", { name: "Lorem project", exact: true });
  await project.waitFor();
  checks.projectVisibleWithoutScrolling = await project.evaluate((e) => {
    const item = e.getBoundingClientRect(),
      sidebar = e.closest(".sidebar").getBoundingClientRect();
    return item.top >= sidebar.top && item.bottom <= sidebar.bottom;
  });
  await expect(page.getByRole("button", { name: /筛选视图/ })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "关注的工作视图" }),
  ).toHaveCount(0);
  checks.savedViewSidebarRemoved = true;
  await expect(
    page.getByRole("button", { name: "搜索工作空间", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "随手记", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("本地工作空间", { exact: true })).toHaveCount(0);
  const sync = page.getByTestId("lan-sync-status");
  await expect(sync).toBeVisible();
  await expect(sync).toHaveAttribute("aria-label", /同步：.*待上传.*冲突/);
  expect(await sync.innerText()).toBe("");
  expect((await sync.boundingBox()).width).toBeLessThanOrEqual(44);
  // Without conflicts the sync icon is a status indicator and opens no popup.
  await sync.click();
  await expect(
    page.getByRole("dialog", { name: "工作空间同步" }),
  ).toHaveCount(0);
  checks.sidebarSimplifiedAndSyncIconWorks = true;
  await page.screenshot({
    path: join(evidence, "sidebar.png"),
    fullPage: true,
  });
  await page.locator(".timeline-more > summary").click();
  await page.getByRole("button", { name: "搜索与筛选", exact: true }).click();
  await expect(page.locator(".search-views")).toBeVisible();
  await expect(page.getByLabel("视图名称", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("载入视图", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /保存.*视图/ })).toHaveCount(0);
  await page.locator(".search-views form select").first().selectOption("task");
  await page.getByLabel("搜索文字").fill("Lorem task");
  await page
    .getByRole("button", { name: "搜索 / 应用筛选", exact: true })
    .click();
  await expect(page.locator(".search-views article")).toHaveCount(1);
  await expect(page.locator(".search-views article")).toContainText(
    "Lorem task",
  );
  await page.getByRole("button", { name: "新搜索", exact: true }).click();
  await expect(page.getByLabel("搜索文字")).toHaveValue("");
  checks.temporaryFiltersWorkWithoutSavedViews = true;
  await page
    .locator(".search-views form select")
    .first()
    .selectOption("project");
  await page
    .getByRole("button", { name: "搜索 / 应用筛选", exact: true })
    .click();
  await page.getByRole("button", { name: "打开项目", exact: true }).click();
  await expect(page.locator(".work-view h1, .projects-view")).toBeVisible();
  await delay(100);
  checks.searchProjectOpensOriginalViews =
    (await page
      .getByRole("tablist", { name: "项目视图", exact: true })
      .count()) > 0;
  await project.click();
  await expect(
    page.getByRole("tablist", { name: "项目视图", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tree-task")).toContainText("Lorem task");
  await page.getByRole("tab", { name: "看板", exact: true }).click();
  await expect(page.locator(".kanban-card")).toContainText("Lorem task");
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await expect(page.locator(".gantt-view")).toBeVisible();
  await page.getByRole("tab", { name: "任务视图", exact: true }).click();
  await expect(page.locator(".tree-task")).toContainText("Lorem task");
  checks.projectListBoardGanttWork = true;
  await page.locator(".sidebar").evaluate((e) => {
    e.scrollTop = 0;
  });
  await page.screenshot({
    path: join(evidence, "project.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "今日与近期", exact: true }).click();
  await expect(page.locator(".day-period")).toHaveCount(3);
  await page.setViewportSize({ width: 1920, height: 1000 });
  expect((await page.locator(".date-strip-row").boundingBox()).width).toBe(560);
  await page.screenshot({ path: join(evidence, "today.png"), fullPage: true });
  expect((await ipc("view_snapshot")).views).toHaveLength(12);
  checks.savedViewsPreserved = true;
  await page.setViewportSize({ width: 390, height: 950 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.locator(".timeline-more > summary").click();
  await page.getByRole("button", { name: "搜索与筛选", exact: true }).click();
  await expect(page.locator(".search-views")).toBeVisible();
  await expect(page.getByRole("button", { name: /筛选视图/ })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  checks.narrowViewportNavigationWorks = true;
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
  expect(checks.projectVisibleWithoutScrolling).toBe(true);
  expect(checks.savedViewSidebarRemoved).toBe(true);
  expect(checks.searchProjectOpensOriginalViews).toBe(true);
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill();
}
