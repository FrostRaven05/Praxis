import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const release = resolve(".tools/releases/user-usability/Praxis.exe");
const evidence = resolve("docs/evidence/user-usability-acceptance");
const dir = await mkdtemp(resolve(".tools/usability-acceptance-"));
await mkdir(evidence, { recursive: true });
const child = spawn(release, [], {
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PRAXIS_DATA_DIR: join(dir, "client"),
    WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port=9288 --remote-debugging-address=127.0.0.1",
  },
});
const checks = [],
  errors = [];
let browser, p;
const snapshot = () =>
  p.evaluate(() => window.__TAURI_INTERNALS__.invoke("productivity_snapshot"));
const findTask = async (title) =>
  (await snapshot()).tasks.find((t) => t.title === title);
const shot = (name) => p.screenshot({ path: join(evidence, name + ".png") });
const sidebar = () =>
  p.getByRole("navigation", { name: "主导航", exact: true });
const goToday = () =>
  sidebar().getByRole("link", { name: "今日与近期", exact: true }).click();
const goInbox = () =>
  sidebar()
    .getByRole("button", { name: /^收件箱/ })
    .click();
const goSearch = () =>
  sidebar().getByRole("button", { name: "搜索", exact: true }).click();
const dialog = () => p.getByRole("dialog", { name: "任务属性", exact: true });
const closeEditor = () =>
  dialog().getByRole("button", { name: "关闭任务编辑", exact: true }).click();
const closePanel = () =>
  p.getByRole("button", { name: "关闭任务详情", exact: true }).click();
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9288", {
        timeout: 500,
      });
      p = browser.contexts()[0].pages()[0];
      await sidebar()
        .getByRole("button", { name: "搜索", exact: true })
        .waitFor({ timeout: 1000 });
      break;
    } catch {
      await browser?.close().catch(() => {});
      await wait(200);
    }
  }
  if (!p) throw new Error("Isolated desktop did not start");
  p.setDefaultTimeout(10000);
  await p.setViewportSize({ width: 1160, height: 800 });
  p.on("pageerror", (e) => errors.push(String(e)));
  const today = await p.evaluate(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).format(new Date()),
  );
  const tomorrow = new Date(new Date(today + "T12:00:00Z").getTime() + 86400000)
    .toISOString()
    .slice(0, 10);

  await goSearch();
  await expect(p.getByLabel("搜索文字", { exact: true })).toBeVisible();
  await expect(
    p.getByRole("button", { name: "预览时区影响", exact: true }),
  ).toHaveCount(0);
  expect((await snapshot()).settings).toHaveLength(1);
  checks.push(
    "fresh workspace opens search directly with device timezone, no setup gate",
  );

  await goToday();
  await expect(
    p.getByRole("button", { name: "快速任务", exact: true }),
  ).toHaveCount(0);
  await p.getByLabel("任务标题", { exact: true }).focus();
  await shot("00-simple-capture");
  await p.getByLabel("任务标题", { exact: true }).fill("准备周报验收");
  await p.getByLabel("任务标题", { exact: true }).press("Enter");
  await p.locator(".task-title", { hasText: "准备周报验收" }).click();
  await p.getByRole("button", { name: "明天", exact: true }).click();
  await expect(
    p.getByRole("button", { name: tomorrow, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(p.locator("#task-title")).toHaveAttribute(
    "placeholder",
    `添加${tomorrow}任务，按回车保存`,
  );
  const dateHeight = await p
    .locator(".date-strip")
    .evaluate((e) => e.getBoundingClientRect().height);
  expect(dateHeight).toBeLessThanOrEqual(100);
  await shot("01-compact-date-inspector");
  await closePanel();
  checks.push(
    "one-click reschedule updates the selected date and input caption; compact date strip with inspector",
  );

  await p.getByLabel("任务标题", { exact: true }).fill("按日期回车新增");
  await p.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(
    p.locator(".task-title", { hasText: "按日期回车新增" }),
  ).toBeVisible();
  expect((await findTask("按日期回车新增")).plan.date).toBe(tomorrow);
  await expect(p.locator(".action-notice")).toContainText(tomorrow);
  checks.push(
    "single inline entry saves to the selected future date; duplicate Add button is removed",
  );

  await p
    .locator(".task-item", { hasText: "按日期回车新增" })
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await expect(p.locator(".action-notice")).toContainText("已完成");
  await expect(
    p.getByRole("button", { name: tomorrow, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await p
    .locator(".action-notice")
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(
    p.locator(".task-title", { hasText: "按日期回车新增" }),
  ).toBeVisible();
  expect((await findTask("按日期回车新增")).plan.date).toBe(tomorrow);
  checks.push(
    "completion stays on the browsed future date and can be undone directly",
  );

  await goInbox();
  await p.getByLabel("收件箱任务标题", { exact: true }).fill("无日期验收任务");
  await p.getByLabel("收件箱任务标题", { exact: true }).press("Enter");
  await expect(p.locator(".action-notice")).toContainText("已保存到收件箱");
  await expect(
    p.locator(".inbox-task-title", { hasText: "无日期验收任务" }),
  ).toBeVisible();
  checks.push(
    "Inbox inline entry saves an undated task and confirms the destination",
  );
  await shot("02a-inbox-action");

  await p
    .getByRole("button", { name: "完成任务：无日期验收任务", exact: true })
    .click();
  await expect(p.locator(".action-notice")).toContainText("已完成");
  expect((await findTask("无日期验收任务")).plan).toBeNull();
  await p
    .locator(".action-notice")
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(
    p.locator(".inbox-list > .inbox-row:not(.completed) .inbox-task-title", {
      hasText: "无日期验收任务",
    }),
  ).toBeVisible();
  expect((await findTask("无日期验收任务")).plan).toBeNull();
  await p.locator(".inbox-task-title", { hasText: "无日期验收任务" }).click();
  await p.getByRole("button", { name: "标为完成", exact: true }).click();
  await expect(p.locator(".action-notice")).toContainText("已完成");
  await shot("02-inbox-complete-undo");
  await p.locator(".completed-section > summary").click();
  await p
    .getByRole("button", { name: "撤销完成：无日期验收任务", exact: true })
    .click();
  await expect(
    p.locator(".inbox-task-title", { hasText: "无日期验收任务" }),
  ).toBeVisible();
  checks.push(
    "Inbox row and side panel complete undated tasks; toast and completed list undo restore them without assigning today",
  );

  await p.locator(".inbox-task-title", { hasText: "无日期验收任务" }).click();
  await p.getByRole("button", { name: "更多属性与结构…", exact: true }).click();
  await expect(dialog()).toBeVisible();
  await closeEditor();
  await expect(
    p.getByRole("heading", { name: "收件箱", exact: true }),
  ).toBeVisible();
  await expect(p.getByLabel("编辑任务标题", { exact: true })).toHaveValue(
    "无日期验收任务",
  );
  await p.getByRole("button", { name: "更多属性与结构…", exact: true }).click();
  await dialog().getByLabel("说明", { exact: true }).fill("保留来源页面验收");
  await dialog().getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog()).toBeHidden();
  await expect(
    p.getByRole("heading", { name: "收件箱", exact: true }),
  ).toBeVisible();
  await expect(p.locator(".task-panel-notes")).toHaveValue("保留来源页面验收");
  await shot("03-inbox-return-context");
  await closePanel();
  checks.push(
    "advanced editor cancel and save preserve Inbox and reload the original side panel",
  );

  await goSearch();
  await p.getByLabel("搜索文字", { exact: true }).fill("周报");
  await p.getByLabel("搜索文字", { exact: true }).press("Enter");
  const result = p
    .locator(".search-results")
    .getByRole("button", { name: "准备周报验收", exact: true });
  await expect(result).toBeVisible();
  const rect = await result.boundingBox();
  expect(rect.y + rect.height).toBeLessThan(800);
  await expect(p.locator(".search-scope select").first()).toBeHidden();
  await shot("04-search-first-screen");
  await result.click();
  await expect(dialog()).toBeVisible();
  await closeEditor();
  await expect(p.getByLabel("搜索文字", { exact: true })).toHaveValue("周报");
  await expect(result).toBeVisible();
  await result.click();
  await dialog()
    .getByLabel("任务标题", { exact: true })
    .fill("准备周报验收已更新");
  await dialog().getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(p.getByLabel("搜索文字", { exact: true })).toHaveValue("周报");
  await expect(
    p
      .locator(".search-results")
      .getByRole("button", { name: "准备周报验收已更新", exact: true }),
  ).toBeVisible();
  await expect(result).toHaveCount(0);
  await p.locator(".search-advanced > summary").click();
  await expect(p.locator(".search-scope select").first()).toBeVisible();
  checks.push(
    "fixed Search opens results in the first screen, filters expand on demand, closing a result preserves query and results",
  );

  await p.getByRole("button", { name: "新建项目", exact: true }).click();
  await p.getByLabel("项目名称", { exact: true }).fill("整改流程验收项目");
  await p.getByRole("button", { name: "保存项目", exact: true }).click();
  await p.getByLabel("项目任务标题", { exact: true }).fill("项目任务验收");
  await p.getByLabel("项目任务标题", { exact: true }).press("Enter");
  await p.locator(".project-task-title", { hasText: "项目任务验收" }).click();
  await p.getByRole("button", { name: "更多属性与结构…", exact: true }).click();
  await expect(dialog()).toBeVisible();
  await closeEditor();
  await expect(
    p.getByRole("heading", { name: "整改流程验收项目", exact: true }),
  ).toBeVisible();
  await expect(p.getByLabel("编辑任务标题", { exact: true })).toHaveValue(
    "项目任务验收",
  );
  await closePanel();
  checks.push(
    "create a project with only a name, add a task, and return from advanced editing to that project",
  );

  await p.getByRole("button", { name: "设置", exact: true }).click();
  await expect(p.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(p.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(p.getByLabel("账号服务地址", { exact: true })).toBeHidden();
  await shot("05-simple-login");
  await p.locator(".account-panel details > summary").click();
  await expect(p.getByLabel("账号服务地址", { exact: true })).toBeVisible();
  await expect(p.getByLabel("账号服务地址", { exact: true })).not.toHaveValue(
    "",
  );
  checks.push(
    "normal login exposes email and password; the configured service address remains available under Advanced",
  );
  await p.locator(".workspace-settings > summary").click();
  await expect(p.getByLabel("工作空间时区", { exact: true })).toBeVisible();
  await p.getByRole("button", { name: "预览时区影响", exact: true }).click();
  await expect(
    p.getByRole("button", { name: "确认工作空间时区", exact: true }),
  ).toBeVisible();
  await p.getByRole("button", { name: "放弃时区修改", exact: true }).click();
  checks.push(
    "timezone and labels remain available in Advanced Settings; changes retain impact preview and can be cancelled",
  );

  await p.reload();
  await goInbox();
  await expect(
    p.locator(".inbox-task-title", { hasText: "无日期验收任务" }),
  ).toBeVisible();
  expect((await findTask("无日期验收任务")).plan).toBeNull();
  expect((await findTask("按日期回车新增")).plan.date).toBe(tomorrow);
  checks.push("reload retains undated undone tasks and future-date tasks");
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (e) {
  errors.push(String(e));
  await p?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        release,
        isolated: true,
        workspace: join(dir, "client"),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  await browser?.close().catch(() => {});
  child.kill();
}
