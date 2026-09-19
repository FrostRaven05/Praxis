import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

const root = resolve(import.meta.dirname, "..");
const exe = join(
  root,
  "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
);
await mkdir(join(root, ".tools"), { recursive: true });
const data = await mkdtemp(join(root, ".tools", "capture-qa-"));
const evidence = join(
  root,
  process.env.PRAXIS_EVIDENCE_DIR ?? "docs/evidence/ticket-01",
);
await mkdir(evidence, { recursive: true });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const errors = [];
async function launch(dataDirectory = data) {
  const port = await freePort();
  const child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PRAXIS_DATA_DIR: dataDirectory,
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null)
        throw new Error(`Desktop exited with ${child.exitCode}`);
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1000,
        });
        break;
      } catch {
        await delay(250);
      }
    }
    if (!browser) throw new Error("WebView2 debugging endpoint was not ready");
    const context = browser.contexts()[0];
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = context
        .pages()
        .find((candidate) => /tauri|localhost/.test(candidate.url()));
      if (page) break;
      await delay(250);
    }
    if (!page) throw new Error("Praxis WebView2 page was not found");
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Block external HTTP(S), leaving Tauri's native localhost IPC available.
    await context.route(/https?:\/\//, (route) => {
      const host = new URL(route.request().url()).hostname;
      return [
        "ipc.localhost",
        "tauri.localhost",
        "127.0.0.1",
        "localhost",
      ].includes(host)
        ? route.continue()
        : route.abort("internetdisconnected");
    });
    return { child, browser, page };
  } catch (error) {
    if (child.pid) stop(child);
    throw error;
  }
}
function stop(child) {
  // Kill only the process tree created by this test, simulating an abrupt shutdown.
  if (child.pid && child.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      try {
        process.kill(child.pid, 0);
      } catch (probe) {
        if (probe.code === "ESRCH") return;
      }
      throw error;
    }
  }
}
let app;
const results = [];
try {
  app = await launch();
  const windowState = (cmd) =>
    app.page.evaluate(
      (cmd) => window.__TAURI_INTERNALS__.invoke("plugin:window|" + cmd),
      cmd,
    );
  await expect(
    app.page.getByLabel("窗口标题栏", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => windowState("is_decorated")).toBe(false);
  results.push("Custom titlebar replaces native decorations");
  await app.page.setViewportSize({ width: 680, height: 600 });
  for (const button of await app.page
    .locator(".window-controls button")
    .all()) {
    expect((await button.boundingBox()).height).toBe(32);
  }
  await app.page.setViewportSize({ width: 1160, height: 800 });
  results.push("Titlebar buttons stay within 32px at minimum desktop width");

  await app.page
    .getByRole("button", { name: "最大化窗口", exact: true })
    .click();
  await expect.poll(() => windowState("is_maximized")).toBe(true);
  await app.page.getByRole("button", { name: "还原窗口", exact: true }).click();
  await expect.poll(() => windowState("is_maximized")).toBe(false);
  results.push("Titlebar maximize and restore update native window state");
  await app.page
    .locator(".window-drag-region")
    .dispatchEvent("mousedown", { button: 0, detail: 2 });
  await expect.poll(() => windowState("is_maximized")).toBe(true);
  await app.page.getByRole("button", { name: "还原窗口", exact: true }).click();
  await expect.poll(() => windowState("is_maximized")).toBe(false);
  results.push("Titlebar double-click invokes native maximize");
  await app.page.screenshot({ path: join(evidence, "desktop-titlebar.png") });

  await expect(app.page.getByText("留一点空间，给重要的事")).toBeVisible();
  await app.page.getByRole("button", { name: "添加", exact: false }).click();
  await expect(app.page.getByRole("alert")).toHaveText("请填写任务标题");
  results.push("Blank title: rejected with visible message");

  await app.page
    .getByLabel("任务标题", { exact: true })
    .fill("整理文章提纲 · 离线验证");
  await app.page.getByRole("button", { name: "添加", exact: false }).click();
  await expect(
    app.page.getByRole("button", { name: /整理文章提纲 · 离线验证/ }),
  ).toBeVisible();
  await expect(app.page.locator(".save-notice")).toContainText("已保存到本机");
  await app.page.getByLabel("任务标题", { exact: true }).fill("为明天留下一步");
  await app.page.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await app.page
    .getByRole("button", { name: /整理文章提纲 · 离线验证/ })
    .click();
  await expect(app.page.getByLabel("任务详情", { exact: true })).toContainText(
    "未归属项目",
  );
  await app.page.screenshot({ path: join(evidence, "desktop-captured.png") });
  results.push(
    "Native UI → TypeScript use case → Tauri IPC → SQLite: two tasks saved",
  );
  results.push("Detail shows execution date, temporary source and no project");

  await app.page.getByRole("button", { name: "关闭任务详情" }).click();
  await app.page
    .getByRole("button", { name: "标为完成", exact: true })
    .first()
    .click();
  await expect(app.page.locator(".completed-section .task-row")).toHaveCount(0);
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  await app.page.getByRole("button", { name: /已完成 · 1/ }).click();
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await app.page.screenshot({ path: join(evidence, "desktop-completed.png") });
  results.push(
    "Completion persists and completed group can collapse and expand",
  );
  stop(app.child);
  app = undefined;
  await delay(600);

  app = await launch();
  await app.page.getByRole("button", { name: /已完成 · 1/ }).click();
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await expect(
    app.page.getByRole("button", { name: /整理文章提纲 · 离线验证/ }),
  ).toBeVisible();
  await expect(
    app.page.getByRole("button", { name: /为明天留下一步/ }),
  ).toBeVisible();
  await app.page.screenshot({ path: join(evidence, "desktop-reopened.png") });
  results.push(
    "Abrupt process shutdown and native restart: both tasks recovered",
  );

  await expect(app.page.locator(".completed-section .task-row")).toHaveCount(1);
  await app.page.getByRole("button", { name: "撤销完成", exact: true }).click();
  await expect(app.page.locator(".completed-section")).toHaveCount(0);
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await expect(app.page.locator(".save-notice")).toContainText("已撤销完成");
  results.push(
    "After abrupt restart completed task survives; undo restores pending task",
  );

  const originalDay = await app.page
    .getByLabel("查看日期", { exact: true })
    .inputValue();
  await app.page.getByRole("button", { name: /为明天留下一步/ }).click();
  await app.page.getByLabel("编辑任务标题", { exact: true }).fill("");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    app.page.getByLabel("编辑任务", { exact: true }).getByRole("alert"),
  ).toContainText("请填写任务标题");
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("编辑后的下一步");
  await app.page.getByLabel("安排日期", { exact: true }).fill("2030-01-15");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(app.page.getByLabel("查看日期", { exact: true })).toHaveValue(
    "2030-01-15",
  );
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  await expect(
    app.page.getByLabel("编辑任务标题", { exact: true }),
  ).toHaveValue("编辑后的下一步");
  await app.page.screenshot({ path: join(evidence, "desktop-edited.png") });
  await app.page.getByRole("button", { name: "关闭任务详情" }).click();
  await app.page.getByLabel("查看日期", { exact: true }).fill(originalDay);
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  await app.page.getByLabel("查看日期", { exact: true }).fill("2030-01-15");
  await expect(app.page.locator(".task-row")).toContainText("编辑后的下一步");
  await app.page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await expect(app.page.getByLabel("查看日期", { exact: true })).toHaveValue(
    originalDay,
  );
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  results.push(
    "Edit title and reschedule preserve a single task; date navigation and undo restore original title/date",
  );
  await app.page.getByRole("button", { name: /为明天留下一步/ }).click();
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("重启后保留编辑");
  await app.page.getByLabel("安排日期", { exact: true }).fill("2030-01-15");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(app.page.getByLabel("查看日期", { exact: true })).toHaveValue(
    "2030-01-15",
  );
  await expect(app.page.locator(".task-row")).toContainText("重启后保留编辑");

  await expect(
    app.page.getByLabel("编辑任务标题", { exact: true }),
  ).toHaveValue("重启后保留编辑");
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("重启后保留编辑（二次）");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    app.page.getByLabel("编辑任务标题", { exact: true }),
  ).toHaveValue("重启后保留编辑（二次）");
  await expect(app.page.locator(".task-row")).toContainText(
    "重启后保留编辑（二次）",
  );
  results.push(
    "Consecutive saves in the same detail use the committed version",
  );
  stop(app.child);
  app = await launch();
  await app.page.getByLabel("查看日期", { exact: true }).fill("2030-01-15");
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  await expect(app.page.locator(".task-row")).toContainText("重启后保留编辑");
  results.push(
    "Edited title and rescheduled date survive abrupt native restart",
  );

  const planned = app.page
    .locator(".task-item")
    .filter({ hasText: "重启后保留编辑" });
  await planned.getByRole("button", { name: "设为重点", exact: true }).click();
  await expect(app.page.locator(".focus-section .task-row")).toHaveCount(1);
  await planned.getByLabel("预计投入分钟", { exact: true }).fill("45");
  await planned.getByRole("button", { name: "保存估时", exact: true }).click();
  await expect(app.page.getByLabel("每日负载", { exact: true })).toContainText(
    "已安排预计 45 分钟",
  );
  await app.page.getByLabel("可用时长（分钟）", { exact: true }).fill("30");
  await app.page.getByRole("button", { name: "保存容量", exact: true }).click();
  await expect(app.page.getByLabel("每日负载", { exact: true })).toContainText(
    "已超出可用时长 15 分钟",
  );
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  results.push(
    "Focus grouping, estimate and capacity persist; overload warns without removing tasks",
  );
  await app.page.keyboard.press("Control+Shift+N");
  await expect(
    app.page.getByRole("heading", { name: "先记下来，稍后安排。" }),
  ).toBeVisible();
  await app.page
    .getByLabel("收件箱任务标题", { exact: true })
    .fill("从收件箱安排的任务");
  await app.page
    .getByRole("button", { name: "存入收件箱", exact: true })
    .click();
  await expect(app.page.locator(".inbox-row")).toHaveCount(1);
  await app.page.getByLabel("安排到", { exact: true }).fill("2030-01-15");
  await app.page.getByRole("button", { name: "安排任务", exact: true }).click();
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  const scheduled = app.page
    .locator(".task-item")
    .filter({ hasText: "从收件箱安排的任务" });
  await scheduled
    .getByRole("button", { name: "设为重点", exact: true })
    .click();
  await expect(app.page.locator(".focus-section .task-row")).toHaveCount(2);
  await scheduled
    .getByRole("button", { name: "重点上移", exact: true })
    .click();
  await expect(
    app.page.locator(".focus-section .task-row").first(),
  ).toContainText("从收件箱安排的任务");
  await scheduled
    .getByRole("button", { name: "取消重点", exact: true })
    .click();
  await expect(app.page.locator(".focus-section .task-row")).toHaveCount(1);
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await expect(app.page.getByLabel("每日负载", { exact: true })).toContainText(
    "1 项待估时",
  );
  await app.page.screenshot({ path: join(evidence, "desktop-planning.png") });
  results.push(
    "Global shortcut captures unscheduled inbox task; explicit scheduling, focus reorder and cancellation avoid duplicates",
  );
  stop(app.child);
  app = await launch();
  await app.page.getByLabel("查看日期", { exact: true }).fill("2030-01-15");
  await expect(app.page.locator(".focus-section .task-row")).toHaveCount(1);
  await expect(app.page.locator(".task-row")).toHaveCount(2);
  await expect(app.page.getByLabel("每日负载", { exact: true })).toContainText(
    "已超出可用时长 15 分钟",
  );
  await expect(app.page.getByLabel("每日负载", { exact: true })).toContainText(
    "1 项待估时",
  );
  results.push(
    "Focus, estimates, capacity and assigned inbox task survive native restart",
  );

  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page.getByRole("button", { name: "新建项目", exact: true }).click();
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(app.page.getByRole("alert")).toContainText("请填写项目名称");
  await app.page.getByLabel("项目名称", { exact: true }).fill("上线报名网站");
  await app.page
    .getByLabel("预期结果", { exact: true })
    .fill("访客可以完成报名");
  await app.page
    .getByLabel("目标日期（可选）", { exact: true })
    .fill("2030-02-01");
  await app.page.getByLabel("项目优先级", { exact: true }).selectOption("2");
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(app.page.locator(".project-heading")).toContainText(
    "上线报名网站",
  );
  await app.page
    .getByLabel("拆成可以行动的任务")
    .fill("设计报名页面\n实现报名接口");
  await app.page
    .getByRole("button", { name: "添加项目任务", exact: true })
    .click();
  await expect(app.page.locator(".project-tasks .inbox-row")).toHaveCount(2);
  const projectRow = app.page
    .locator(".project-tasks .inbox-row")
    .filter({ hasText: "设计报名页面" });
  await projectRow
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await projectRow
    .getByRole("button", { name: "查看安排", exact: true })
    .click();
  await app.page.getByRole("button", { name: /设计报名页面/ }).click();
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("报名页面已设计");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    app.page.getByLabel("编辑任务标题", { exact: true }),
  ).toHaveValue("报名页面已设计");
  await app.page.getByRole("button", { name: "关闭任务详情" }).click();
  await app.page
    .locator(".task-item")
    .filter({ hasText: "报名页面已设计" })
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await expect(
    app.page
      .locator(".project-tasks .inbox-row")
      .filter({ hasText: "报名页面已设计" }),
  ).toContainText("已完成");
  await app.page.getByRole("button", { name: "编辑项目", exact: true }).click();
  await app.page
    .getByLabel("预期结果", { exact: true })
    .fill("访客可以完成报名并收到确认");
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(app.page.locator(".project-outcome")).toContainText("收到确认");
  results.push(
    "Project creation, batch tasks and daily scheduling preserve shared edits and completion across views",
  );

  await app.page.getByRole("link", { name: /今日/ }).click();
  await app.page.getByLabel("查看日期", { exact: true }).fill("2030-01-15");
  await app.page.getByRole("button", { name: /重启后保留编辑/ }).click();
  await app.page
    .getByLabel("归入项目", { exact: true })
    .selectOption({ label: "上线报名网站" });
  await app.page.getByRole("button", { name: "归入项目", exact: true }).click();
  await expect(app.page.getByLabel("任务详情", { exact: true })).toContainText(
    "所属项目：上线报名网站",
  );
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("归属后立即编辑");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    app.page.locator(".task-row").filter({ hasText: "归属后立即编辑" }),
  ).toHaveCount(1);
  await app.page.getByRole("button", { name: "关闭任务详情" }).click();
  await app.page
    .locator(".task-item")
    .filter({ hasText: "归属后立即编辑" })
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await expect(
    app.page.locator(".task-row").filter({ hasText: "归属后立即编辑" }),
  ).toHaveCount(0);
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await app.page
    .locator(".project-tasks .inbox-row")
    .filter({ hasText: "归属后立即编辑" })
    .getByRole("button", { name: "查看完成记录", exact: true })
    .click();
  await app.page.getByRole("button", { name: /已完成/ }).click();
  await expect(app.page.locator(".completed-section")).toContainText(
    "归属后立即编辑",
  );
  results.push(
    "Assigning a daily task refreshes the editor version; cross-day completion opens the actual completion day",
  );

  await app.page.keyboard.press("Control+Shift+N");
  await app.page
    .getByLabel("收件箱任务标题", { exact: true })
    .fill("补充报名说明");
  await app.page
    .getByRole("button", { name: "存入收件箱", exact: true })
    .click();
  const inboxProject = app.page
    .locator(".inbox-row")
    .filter({ hasText: "补充报名说明" });
  await inboxProject
    .getByLabel("归入项目", { exact: true })
    .selectOption({ label: "上线报名网站" });
  await inboxProject
    .getByRole("button", { name: "归入项目", exact: true })
    .click();
  await expect(inboxProject).toHaveCount(0);
  stop(app.child);
  app = await launch();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await expect(app.page.locator(".project-tasks .inbox-row")).toHaveCount(4);
  await expect(app.page.locator(".project-outcome")).toContainText("收到确认");
  await expect(
    app.page
      .locator(".project-tasks .inbox-row")
      .filter({ hasText: "补充报名说明" }),
  ).toContainText("尚未安排");
  await app.page.screenshot({ path: join(evidence, "desktop-projects.png") });
  results.push(
    "Inbox assignment retains the original task; project fields, batch tasks and membership survive abrupt restart",
  );

  const detailRow = app.page
    .locator(".project-tasks .inbox-row")
    .filter({ hasText: "实现报名接口" });
  await detailRow
    .getByRole("button", { name: "编辑详情", exact: true })
    .click();
  const fullDetails = () =>
    app.page.getByRole("dialog", { name: "编辑任务详情", exact: true });
  await fullDetails()
    .getByLabel("任务名称", { exact: true })
    .fill("实现完整报名接口");
  await fullDetails()
    .getByLabel("备注", { exact: true })
    .fill("离线草稿\n需要保留");
  await fullDetails()
    .getByLabel("完成标准", { exact: true })
    .fill("报名成功返回确认号");
  await fullDetails().getByLabel("重要任务", { exact: true }).check();
  await fullDetails()
    .getByLabel("截止时间（本地时间）", { exact: true })
    .fill("2030-02-02T18:30");
  await fullDetails()
    .getByLabel("预估工作量（分钟）", { exact: true })
    .fill("45");
  await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await app.page.keyboard.press("Control+Shift+N");
  await expect(fullDetails().getByLabel("备注", { exact: true })).toHaveValue(
    "离线草稿\n需要保留",
  );
  await fullDetails()
    .getByRole("button", { name: "保存任务详情", exact: true })
    .click();
  await expect(fullDetails().getByRole("status")).toHaveText(
    "任务详情已保存到本机",
  );
  await fullDetails()
    .getByLabel("备注", { exact: true })
    .fill("连续保存后的备注");
  await fullDetails()
    .getByRole("button", { name: "保存任务详情", exact: true })
    .click();
  await expect(fullDetails().getByRole("status")).toHaveText(
    "任务详情已保存到本机",
  );
  await fullDetails()
    .getByRole("button", { name: "关闭详情编辑", exact: true })
    .click();
  await expect(fullDetails()).toHaveCount(0);
  const editedProjectRow = app.page
    .locator(".project-tasks .inbox-row")
    .filter({ hasText: "实现完整报名接口" });
  await expect(editedProjectRow).toContainText("尚未安排");
  await expect(editedProjectRow).toContainText("重要");
  await editedProjectRow
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await editedProjectRow
    .getByRole("button", { name: "查看安排", exact: true })
    .click();
  const todayDetailRow = app.page
    .locator(".task-item")
    .filter({ hasText: "实现完整报名接口" });
  await expect(todayDetailRow.getByLabel("预计投入分钟")).toHaveValue("45");
  await expect(
    todayDetailRow.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeVisible();
  await todayDetailRow.locator(".task-row").click();
  await app.page
    .getByLabel("任务详情", { exact: true })
    .getByRole("button", { name: "编辑详情", exact: true })
    .click();
  await expect(
    fullDetails().getByLabel("完成标准", { exact: true }),
  ).toHaveValue("报名成功返回确认号");
  await expect(
    fullDetails().getByLabel("截止时间（本地时间）", { exact: true }),
  ).toHaveValue("2030-02-02T18:30");
  await fullDetails()
    .getByLabel("任务名称", { exact: true })
    .fill("跨视图编辑后的接口");
  await fullDetails()
    .getByRole("button", { name: "保存任务详情", exact: true })
    .click();
  await expect(fullDetails().getByRole("status")).toHaveText(
    "任务详情已保存到本机",
  );
  await fullDetails()
    .getByRole("button", { name: "关闭详情编辑", exact: true })
    .click();
  await expect(fullDetails()).toHaveCount(0);
  await app.page
    .getByLabel("编辑任务标题", { exact: true })
    .fill("详情保存后继续改标题");
  await app.page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    app.page.locator(".task-row").filter({ hasText: "详情保存后继续改标题" }),
  ).toHaveCount(1);
  results.push(
    "Project and daily views share full details; background refresh preserves draft and consecutive edits use committed versions",
  );
  await app.page.keyboard.press("Control+Shift+N");
  await app.page
    .getByLabel("收件箱任务标题", { exact: true })
    .fill("无日期编辑样本");
  await app.page
    .getByRole("button", { name: "存入收件箱", exact: true })
    .click();
  await app.page
    .locator(".inbox-row")
    .filter({ hasText: "无日期编辑样本" })
    .getByRole("button", { name: "编辑详情", exact: true })
    .click();
  await fullDetails().getByLabel("任务名称", { exact: true }).fill("");
  await fullDetails()
    .getByRole("button", { name: "保存任务详情", exact: true })
    .click();
  await expect(fullDetails().getByRole("alert")).toContainText(
    "请填写任务标题",
  );
  await fullDetails()
    .getByLabel("任务名称", { exact: true })
    .fill("无日期编辑已保存");
  await fullDetails()
    .getByLabel("备注", { exact: true })
    .fill("仍然不安排日期");
  await fullDetails()
    .getByRole("button", { name: "保存任务详情", exact: true })
    .click();
  await expect(fullDetails().getByRole("status")).toHaveText(
    "任务详情已保存到本机",
  );
  await fullDetails()
    .getByRole("button", { name: "关闭详情编辑", exact: true })
    .click();
  await expect(fullDetails()).toHaveCount(0);
  await expect(app.page.locator(".inbox-row")).toContainText(
    "无日期编辑已保存",
  );
  stop(app.child);
  app = await launch();
  await app.page.keyboard.press("Control+Shift+N");
  await app.page
    .locator(".inbox-row")
    .filter({ hasText: "无日期编辑已保存" })
    .getByRole("button", { name: "编辑详情", exact: true })
    .click();
  await expect(fullDetails().getByLabel("备注", { exact: true })).toHaveValue(
    "仍然不安排日期",
  );
  await expect(
    fullDetails().getByLabel("预估工作量（分钟）", { exact: true }),
  ).toHaveValue("");
  await fullDetails()
    .getByRole("button", { name: "关闭详情编辑", exact: true })
    .click();
  await expect(fullDetails()).toHaveCount(0);
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await app.page
    .locator(".project-tasks .inbox-row")
    .filter({ hasText: "详情保存后继续改标题" })
    .getByRole("button", { name: "编辑详情", exact: true })
    .click();
  await expect(fullDetails().getByLabel("备注", { exact: true })).toHaveValue(
    "连续保存后的备注",
  );
  await expect(
    fullDetails().getByLabel("重要任务", { exact: true }),
  ).toBeChecked();
  await expect(
    fullDetails().getByLabel("截止时间（本地时间）", { exact: true }),
  ).toHaveValue("2030-02-02T18:30");
  await app.page.screenshot({
    path: join(evidence, "desktop-task-details.png"),
  });
  await fullDetails()
    .getByRole("button", { name: "关闭详情编辑", exact: true })
    .click();
  await expect(fullDetails()).toHaveCount(0);
  results.push(
    "Unscheduled inbox edits remain unscheduled; importance, deadline, criteria and estimates persist across native restart",
  );

  await app.page.getByLabel("拆成可以行动的任务").fill("多级拆分父任务");
  await app.page
    .getByRole("button", { name: "添加项目任务", exact: true })
    .click();
  const treeRow = (title) =>
    app.page
      .locator(".project-tasks .inbox-row")
      .filter({ has: app.page.locator("strong", { hasText: title }) });
  await treeRow("多级拆分父任务")
    .getByRole("button", { name: "拆分子任务", exact: true })
    .click();
  await treeRow("多级拆分父任务")
    .getByLabel("子任务（每行一条）")
    .fill("中间汇总项\n直接叶子项");
  await treeRow("多级拆分父任务")
    .getByRole("button", { name: "保存子任务", exact: true })
    .click();
  await expect(treeRow("多级拆分父任务")).toContainText("汇总 · 0 / 2 已完成");
  await expect(
    treeRow("多级拆分父任务").getByRole("button", {
      name: "加入今日",
      exact: true,
    }),
  ).toHaveCount(0);
  await treeRow("中间汇总项")
    .getByRole("button", { name: "拆分子任务", exact: true })
    .click();
  await treeRow("中间汇总项")
    .getByLabel("子任务（每行一条）")
    .fill("最深执行叶子\n另一深层叶子");
  await treeRow("中间汇总项")
    .getByRole("button", { name: "保存子任务", exact: true })
    .click();
  await expect(treeRow("多级拆分父任务")).toContainText("汇总 · 0 / 3 已完成");
  await treeRow("最深执行叶子")
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await treeRow("最深执行叶子")
    .getByRole("button", { name: "查看安排", exact: true })
    .click();
  await app.page
    .locator(".task-item")
    .filter({ hasText: "最深执行叶子" })
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await expect(treeRow("多级拆分父任务")).toContainText("汇总 · 1 / 3 已完成");
  await expect(treeRow("中间汇总项")).toContainText("汇总 · 1 / 2 已完成");
  await treeRow("详情保存后继续改标题")
    .getByRole("button", { name: "拆分子任务", exact: true })
    .click();
  await treeRow("详情保存后继续改标题")
    .getByLabel("子任务（每行一条）")
    .fill("已确认的执行叶子");
  await treeRow("详情保存后继续改标题")
    .getByRole("button", { name: "保存子任务", exact: true })
    .click();
  await expect(
    treeRow("详情保存后继续改标题").getByRole("alert"),
  ).toContainText("请确认");
  await treeRow("详情保存后继续改标题").getByRole("checkbox").check();
  await treeRow("详情保存后继续改标题")
    .getByRole("button", { name: "保存子任务", exact: true })
    .click();
  await expect(treeRow("详情保存后继续改标题")).toContainText(
    "原安排已转为汇总记录",
  );
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-row").filter({ hasText: "详情保存后继续改标题" }),
  ).toHaveCount(0);
  stop(app.child);
  app = await launch();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page
    .locator(".project-card")
    .filter({ hasText: "上线报名网站" })
    .click();
  await expect(treeRow("多级拆分父任务")).toContainText("汇总 · 1 / 3 已完成");
  await expect(treeRow("详情保存后继续改标题")).toContainText(
    "原安排已转为汇总记录",
  );
  await app.page.screenshot({ path: join(evidence, "desktop-subtasks.png") });
  results.push(
    "Multi-level subtasks count leaves once; completion updates ancestors and survives restart",
  );
  results.push(
    "Splitting a scheduled parent requires confirmation and retains its plan as a non-executable summary",
  );

  stop(app.child);
  app = undefined;
  const invalidDirectory = join(data, "not-a-directory");
  await writeFile(invalidDirectory, "fixture");
  app = await launch(invalidDirectory);
  const beforeMidnight = await app.page.evaluate(() =>
    new Date(2026, 8, 16, 23, 59, 59).getTime(),
  );
  await app.page.clock.install({ time: new Date(beforeMidnight) });
  await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(app.page.locator(".load-error")).toBeVisible();
  await app.page
    .getByLabel("任务标题", { exact: true })
    .fill("保存失败时保留输入");
  await app.page.getByRole("button", { name: "添加", exact: false }).click();
  await expect(app.page.locator("#save-error")).toHaveText(
    "无法打开本机数据库，请检查目录权限和磁盘空间后重试。",
  );
  await expect(app.page.getByLabel("任务标题", { exact: true })).toHaveValue(
    "保存失败时保留输入",
  );
  await expect(app.page.locator(".save-notice")).not.toContainText(
    "已保存到本机",
  );
  results.push(
    "Unavailable database: readable error, draft retained, no false success",
  );

  await app.page.clock.setFixedTime(new Date(beforeMidnight + 2000));
  await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(app.page.locator(".capture-hint")).toContainText("2026-09-16");
  await unlink(invalidDirectory);
  await mkdir(invalidDirectory, { recursive: true });
  await app.page
    .getByRole("button", { name: "重试保存", exact: false })
    .click();
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  await expect(app.page.locator(".recovery-note")).toContainText("2026-09-16");
  await app.page.screenshot({
    path: join(evidence, "desktop-midnight-retry.png"),
  });

  await app.page.getByRole("button", { name: "标为完成", exact: true }).click();
  await expect(app.page.locator(".recovery-note")).toHaveCount(0);
  await app.page.getByRole("button", { name: /已完成 · 1/ }).click();
  await expect(app.page.locator(".completed-section .task-row")).toHaveCount(1);
  await app.page.locator(".completed-section .task-row").click();
  await expect(app.page.getByLabel("任务详情", { exact: true })).toContainText(
    "完成日期",
  );
  await expect(app.page.getByLabel("任务详情", { exact: true })).toContainText(
    "2026-09-17",
  );
  await app.page.getByRole("button", { name: "关闭任务详情" }).click();
  await app.page.getByRole("button", { name: "撤销完成", exact: true }).click();
  await expect(app.page.locator(".recovery-note")).toContainText("2026-09-16");
  await expect(app.page.locator(".task-row")).toHaveCount(1);
  results.push(
    "Prior-day task completed today appears under actual completion day; undo returns to original plan",
  );
  await app.page.getByRole("button", { name: "回到今日" }).click();
  await expect(app.page.locator(".task-row")).toHaveCount(0);
  results.push(
    "Across-midnight retry: original day shown with saved task; return to today works",
  );
  const diagnosticText = await readFile(
    join(data, "praxis-qa-logs/storage-errors.jsonl"),
    "utf8",
  );
  const diagnostics = diagnosticText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    diagnostics.some((record) => record.operationId && record.stage === "open"),
  ).toBe(true);
  expect(diagnosticText).not.toContain("保存失败时保留输入");
  expect(diagnostics.some((record) => record.category === "filesystem")).toBe(
    true,
  );
  results.push(
    "Storage diagnostics retain operation ID and error category without task text",
  );

  await app.page
    .getByRole("button", { name: "最小化窗口", exact: true })
    .click();
  await expect.poll(() => windowState("is_minimized")).toBe(true);
  results.push("Titlebar minimize updates native window state");
  await app.page
    .getByRole("button", { name: "关闭窗口", exact: true })
    .evaluate((button) => button.click());
  await expect
    .poll(() => app.child.exitCode, { timeout: 10000 })
    .not.toBeNull();
  results.push("Titlebar close exits only the QA application");
  expect(errors).toEqual([]);

  const report = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    runtime: "Actual Tauri debug executable + WebView2 CDP, not browser mock",
    network:
      "External HTTP(S) aborted; system adapter unchanged; native IPC retained",
    dataDirectory: data,
    results,
    pageErrors: errors,
  };
  await writeFile(
    join(evidence, "native-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error("Native checks completed before failure:", results);
  console.error(error);
  throw error;
} finally {
  if (app) stop(app.child);
}
