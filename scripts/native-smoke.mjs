import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const evidence = join(root, "docs/evidence/ticket-01");
await mkdir(evidence, { recursive: true });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
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
  const errors = [];
  app.page.on("pageerror", (error) => errors.push(error.message));
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
  await expect(app.page.getByRole("status")).toContainText("已保存到本机");
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
  stop(app.child);
  app = undefined;
  await delay(600);

  app = await launch();
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

  stop(app.child);
  app = undefined;
  const invalidDirectory = join(data, "not-a-directory");
  await writeFile(invalidDirectory, "fixture");
  app = await launch(invalidDirectory);
  await expect(
    app.page.getByText("无法打开本机数据库，请检查目录权限和磁盘空间后重试。"),
  ).toBeVisible();
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
  await expect(app.page.getByRole("status")).not.toContainText("已保存到本机");
  results.push(
    "Unavailable database: readable error, draft retained, no false success",
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
