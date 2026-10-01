import { checkProjectWorkspace } from "../scripts/native-project-workspace.mjs";
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
try {
  app = await launch();
  const page = app.page;
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("状态栏重复复现");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  for (const title of ["任务一", "任务二"]) {
    const input = page.getByLabel("项目任务标题", { exact: true });
    await input.fill(title);
    await input.press("Enter");
    await expect(page.locator(".project-tasks")).toContainText(title);
  }
  await expect(page.locator(".tree-task")).toHaveCount(2);
  await expect(page.locator(".lifecycle")).toHaveCount(1);
  for (const name of ["甘特图", "看板", "任务视图"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.locator(".lifecycle")).toHaveCount(1);
  }
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("第二个项目");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  for (const title of ["状态栏重复复现", "第二个项目", "状态栏重复复现"]) {
    await page.locator(".project-card").filter({ hasText: title }).click();
    console.log(title, await page.locator(".lifecycle").count());
    await expect(page.locator(".lifecycle")).toHaveCount(1);
  }
  console.log("PASS: one lifecycle after repeated view and project switches");
} finally {
  if (app) stop(app.child);
}
