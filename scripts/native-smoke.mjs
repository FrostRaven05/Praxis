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
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
}
let app;
const results = [];
try {
  app = await launch();

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
} finally {
  if (app) stop(app.child);
}
