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
const data = await mkdtemp(join(root, ".tools", "p0-qa-"));
const evidence = join(
  root,
  process.env.PRAXIS_EVIDENCE_DIR ?? "docs/evidence/p0",
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
    console.error("Launch error", error);
    if (child.pid) {
      try {
        stop(child);
      } catch (stopError) {
        console.error("Cleanup error", stopError.message);
      }
    }
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
  let page = app.page;
  const ipc = (name, args = {}) =>
    page.evaluate(
      ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
      { name, args },
    );
  await page.getByRole("button", { name: "随手记", exact: false }).click();
  await page.getByLabel("原始文字", { exact: true }).fill("写初稿\n校对");
  await page
    .getByLabel("原始文字", { exact: true })
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect((await ipc("content_snapshot")).captures).toHaveLength(0);
  await page.getByRole("button", { name: "保存到本机", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "澄清原文", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "澄清原文", exact: true }).click();
  const editor = page.getByRole("region", { name: "澄清原文", exact: true });
  await editor.getByRole("button", { name: "每行一条任务" }).click();
  await editor.getByRole("button", { name: "增加记录" }).click();
  const output = editor.locator(".content-output").nth(2);
  await output.getByLabel("标题", { exact: true }).fill("发布证据");
  await output.getByLabel("正文", { exact: true }).fill("只存一份正文");
  await editor.getByLabel("目标项目").selectOption("new");
  await editor.getByLabel("新项目名称").fill("P0验收项目");
  await editor.getByRole("button", { name: "预览输出" }).click();
  await expect(editor).toContainText("2 条任务、1 条记录");
  await editor.getByRole("button", { name: "确认创建" }).click();
  await expect(editor).toHaveCount(0);
  let state = await ipc("content_snapshot");
  expect(state.tasks).toHaveLength(2);
  expect(state.records).toHaveLength(1);
  results.push(
    "Native raw capture, IME guard, mixed resolution preview, project and provenance",
  );
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑记录和关联", exact: true })
    .click();
  await page
    .getByLabel("记录正文", { exact: true })
    .fill("编辑后必须保留的正文");
  await page.getByText("关联项目和任务", { exact: false }).click();
  await page.getByLabel("写初稿", { exact: true }).check();
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await page.getByRole("button", { name: "待澄清原文", exact: true }).click();
  await page.getByRole("button", { name: "预览撤销" }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("输出已被编辑或关联");
  await page.getByLabel("仅恢复原文，保留所有输出", { exact: false }).check();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(
    page.getByText("之前的输出已保留", { exact: false }),
  ).toBeVisible();
  state = await ipc("content_snapshot");
  expect(state.records[0].body).toBe("编辑后必须保留的正文");
  results.push(
    "Edited output blocks destructive undo; explicit keep restores capture without data loss",
  );
  await page
    .getByRole("navigation", { name: "项目列表", exact: true })
    .getByRole("button", { name: "P0验收项目", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑恢复卡与下一步" }).click();
  const task = state.tasks.find((t) => t.title === "写初稿");
  await page.getByLabel("主下一步", { exact: true }).selectOption(task.id);
  await page.getByLabel("项目完成标准", { exact: true }).fill("文章发布并校对");
  await page.getByLabel("上次上下文", { exact: true }).fill("材料已整理");
  await page.getByLabel("重新开始提示", { exact: true }).fill("从第一段继续写");
  await page.getByRole("button", { name: "保存项目上下文" }).click();
  await expect(page.getByText("当前下一步：", { exact: false })).toBeVisible();
  await page
    .getByRole("region", { name: "项目上下文", exact: true })
    .getByRole("button", { name: "写初稿", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByText("关联记录", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("编辑后必须保留的正文");
  await page.getByRole("button", { name: "关闭详情编辑" }).click();
  const row = page.locator(`[data-task-id="${task.id}"]`);
  await row
    .getByRole("button", { name: "更多操作：写初稿", exact: true })
    .click();
  await page.getByRole("button", { name: "加入今日", exact: true }).click();
  await page.getByRole("link", { name: /每日安排/ }).click();
  // Complete through the existing Today UI, proving the shared task path.
  const dayRow = page.locator("li").filter({ hasText: "写初稿" }).first();
  await dayRow.getByRole("button", { name: /完成/ }).first().click();
  await page
    .getByRole("navigation", { name: "项目列表", exact: true })
    .getByRole("button", { name: "P0验收项目", exact: true })
    .click();
  await expect(
    page.getByText("原下一步已失效，请重新指定。", { exact: true }),
  ).toBeVisible();
  results.push(
    "Project next action opens details; completing same task in Today clears reference",
  );
  const beforeBackup = await ipc("content_snapshot");
  const parent = beforeBackup.tasks.find(t => t.title === "校对");
  const childId = crypto.randomUUID();
  await ipc("add_subtasks", { command: { operationId: crypto.randomUUID(), parentTaskId: parent.id, expectedVersion: parent.version, confirmSummaryPlan: false, tasks: [{ taskId: childId, title: "核对引用" }], occurredAt: new Date().toISOString() } });
  await page.screenshot({
    path: join(evidence, "project-context.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "立即备份" }).click();
  await expect(
    page.getByText("本机备份已保存：", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "选择恢复", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "确认恢复到新文件" }).click();
  await expect(
    page.getByText("恢复副本已验证：", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, "backup-restore.png"),
    fullPage: true,
  });
  stop(app.child);
  await app.browser.close();
  app = await launch();
  page = app.page;
  await page
    .getByRole("navigation", { name: "项目列表", exact: true })
    .getByRole("button", { name: "P0验收项目", exact: true })
    .click();
  await expect(
    page.getByText("上次停在：材料已整理", { exact: true }),
  ).toBeVisible();
  const restored = await ipc("content_snapshot");
  expect(restored.tasks.find((t) => t.id === task.id).status).toBe("completed");
  expect(restored.records[0].body).toBe("编辑后必须保留的正文");
  const restoredProjectTasks = await ipc("project_tasks", { projectId: task.projectId });
  expect(restoredProjectTasks.find(t => t.taskId === childId).parentTaskId).toBe(parent.id);
  results.push(
    "Backup restore switches to verified copy after forced restart; task, record and context survive",
  );
  await page.setViewportSize({ width: 680, height: 600 });
  await page.screenshot({
    path: join(evidence, "compact-context.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "随手记", exact: false }).click();
  await page
    .getByLabel("原始文字", { exact: true })
    .fill("独立记录不必变成任务");
  await page.getByLabel("保存类型", { exact: false }).selectOption("record");
  await expect(page.getByLabel("原始文字", { exact: true })).toHaveValue(
    "独立记录不必变成任务",
  );
  await page.getByRole("button", { name: "保存到本机", exact: true }).click();
  await expect
    .poll(async () => (await ipc("content_snapshot")).records.length)
    .toBe(2);
  await page.getByLabel("保存类型", { exact: false }).selectOption("task");
  await page.getByLabel("原始文字", { exact: true }).fill("独立杂事");
  await page.getByRole("button", { name: "保存到本机", exact: true }).click();
  await expect(page.getByLabel("原始文字", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "独立任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "独立杂事", exact: true }),
  ).toBeVisible();
  results.push(
    "Capture type switching preserves text; independent record and task remain separate",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "独立杂事", exact: true })).toHaveCSS("color", "rgb(236, 236, 236)");
  await page.screenshot({
    path: join(evidence, "independent-dark.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "native-p0.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        runtime: "Tauri + WebView2 native SQLite",
        dataDirectory: data,
        results,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ results, pageErrors: errors }, null, 2));
} catch (e) {
  if (app) {
    await app.page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
    console.error((await app.page.locator("body").innerText()).slice(-10000));
  }
  console.error(results);
  throw e;
} finally {
  if (app) stop(app.child);
}
