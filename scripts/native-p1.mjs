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
const data = await mkdtemp(join(root, ".tools", "p1-qa-"));
const evidence = join(
  root,
  process.env.PRAXIS_EVIDENCE_DIR ?? "docs/evidence/p1",
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
  const snapshot = () => ipc("productivity_snapshot");
  const uuid = () => crypto.randomUUID();
  const cmd = (action) =>
    ipc("productivity_command", {
      command: {
        operationId: uuid(),
        occurredAt: new Date().toISOString(),
        action,
      },
    });
  const tab = (name) => page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日与近期", exact: true }),
  ).toBeVisible();
  await page.getByLabel("工作空间时区", { exact: true }).fill("Asia/Hong_Kong");
  await tab("预览时区影响");
  await tab("确认工作空间时区");
  await expect(page.getByLabel("所选日期")).toBeVisible();
  const today = await page.getByLabel("所选日期").inputValue();
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  await tab("时区与标签");
  await page.getByLabel("标签名称").fill("外出");
  await tab("保存标签");
  await expect.poll(async () => (await snapshot()).labels.length).toBe(1);
  await tab("快速任务");
  let dialog = page.getByRole("dialog", { name: "任务属性" });
  await dialog.getByLabel("任务标题", { exact: true }).fill("电话跟进中文");
  await dialog
    .getByLabel("任务标题", { exact: true })
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect((await snapshot()).tasks.length).toBe(0);
  await dialog.getByLabel("计划类型", { exact: true }).selectOption("date");
  await dialog.getByLabel("计划", { exact: true }).fill(tomorrow);
  await dialog.getByLabel("真实截止类型", { exact: true }).selectOption("date");
  await dialog.getByLabel("真实截止", { exact: true }).fill(today);
  await dialog.getByLabel("跟进类型", { exact: true }).selectOption("date");
  await dialog.getByLabel("跟进", { exact: true }).fill(today);
  await dialog.getByLabel("优先级", { exact: true }).selectOption("1");
  await dialog.getByLabel("外出", { exact: true }).check();
  await dialog.getByLabel("等待对象").fill("供应商");
  await dialog.getByLabel("等待说明").fill("报价尚未回复");
  await expect(dialog).toContainText("计划晚于真实截止");
  await dialog.getByRole("button", { name: "预览属性", exact: true }).click();
  await expect(dialog).toContainText("保存预览");
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let s = await snapshot();
  const task = s.tasks[0];
  expect(task.plan.date).toBe(tomorrow);
  expect(task.deadline.date).toBe(today);
  expect(task.priority).toBe(1);
  await tab("今日");
  await page.getByLabel("主要推进结果").fill("完成报价比较");
  await page.getByLabel("收尾备注").fill("等待回复后接续");
  await page.getByText("选择重点（0）", { exact: true }).click();
  await page.getByRole("checkbox", { name: /电话跟进中文/ }).check();
  await tab("保存每日结果");
  await expect(page.locator(".work-row")).toHaveCount(1);
  await expect(page.locator(".work-row")).toContainText("当日重点");
  await expect(page.locator(".work-row")).toContainText("当日截止");
  expect((await snapshot()).tasks[0].plan.date).toBe(tomorrow);
  await page
    .getByLabel("电话跟进中文 状态", { exact: true })
    .selectOption("waiting");
  await tab("确认执行");
  await expect(page.locator(".work-row")).toContainText("供应商");
  await page.screenshot({ path: join(evidence, "today.png") });
  results.push(
    "Native quick-input preview, IME guard, independent dates/conflict, tags, daily result/focus deduplication and waiting",
  );
  await tab("近期");
  await expect(page.locator(".work-row")).toHaveCount(2);
  await expect(page.locator(".work-view")).not.toContainText("真实逾期");
  await tab("时区与标签");
  s = await snapshot();
  await page.getByLabel("编辑标签").selectOption(s.labels[0].id);
  await page.getByLabel("标签名称").fill("电话");
  await tab("保存标签");
  await expect.poll(async () => (await snapshot()).labels[0].name).toBe("电话");
  await page
    .getByLabel("工作空间时区", { exact: true })
    .fill("America/Los_Angeles");
  await tab("预览时区影响");
  await expect(page.locator(".work-view")).toContainText("日期型值保持原文字");
  await tab("确认工作空间时区");
  expect((await snapshot()).tasks[0].deadline.date).toBe(today);
  const p = uuid();
  await ipc("save_project", {
    command: {
      operationId: uuid(),
      occurredAt: new Date().toISOString(),
      projectId: p,
      expectedVersion: null,
      name: "P1验收项目",
      outcome: "交付",
      targetDate: null,
      priority: 0,
    },
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "今日与近期", exact: true })
    .waitFor();
  await tab("项目与分区");
  await page.getByLabel("选择项目").selectOption(p);
  await page.getByText("管理分区", { exact: true }).click();
  await page.getByLabel("分区名称").fill("准备");
  await tab("保存分区");
  await expect.poll(async () => (await snapshot()).sections.length).toBe(1);
  await tab("全部任务");
  await tab("电话跟进中文");
  dialog = page.getByRole("dialog", { name: "任务属性" });
  await dialog.getByText("移动、分区与父子关系", { exact: true }).click();
  await dialog.getByLabel("目标项目").selectOption(p);
  s = await snapshot();
  await dialog
    .getByLabel("分区", { exact: true })
    .selectOption(s.sections[0].id);
  await dialog.getByRole("button", { name: "预览移动" }).click();
  await tab("确认执行");
  s = await snapshot();
  expect(s.tasks[0].projectId).toBe(p);
  expect(s.tasks[0].sectionId).toBe(s.sections[0].id);
  await tab("项目与分区");
  await page.getByLabel("选择项目").selectOption(p);
  await page.getByText("项目状态与归档", { exact: true }).click();
  await page.getByLabel("项目生命周期").selectOption("cancelled");
  await page.getByRole("checkbox", { name: "归档", exact: true }).check();
  await page.getByRole("checkbox", { name: "结束项目时取消剩余任务" }).check();
  await tab("预览项目变更");
  await expect(page.getByRole("dialog", { name: "确认影响" })).toContainText(
    "电话跟进中文",
  );
  await tab("确认执行");
  s = await snapshot();
  expect(s.projects[0].status).toBe("cancelled");
  expect(s.projects[0].archivedAt).toBeTruthy();
  expect(s.tasks[0].status).toBe("cancelled");
  await expect(
    page
      .getByRole("navigation", { name: "项目列表" })
      .getByRole("button", { name: "P1验收项目" }),
  ).toHaveCount(0);
  await page
    .getByLabel("电话跟进中文 状态", { exact: true })
    .selectOption("todo");
  await expect(page.getByRole("dialog", { name: "确认影响" })).toContainText(
    "重开项目",
  );
  await tab("确认执行");
  s = await snapshot();
  expect(s.projects[0].status).toBe("active");
  expect(s.projects[0].archivedAt).toBeNull();
  results.push(
    "Native reusable label rename, zone preview, section assignment, project cancel/archive and atomic reopen",
  );
  await tab("全部任务");
  await tab("电话跟进中文");
  dialog = page.getByRole("dialog", { name: "任务属性" });
  await dialog.getByRole("button", { name: "拆分子任务" }).click();
  await dialog.getByLabel("子任务（每行一条）").fill("比价\n确认交付");
  await dialog.getByRole("button", { name: "保存子任务" }).click();
  await expect(dialog).toHaveCount(0);
  s = await snapshot();
  expect(s.tasks).toHaveLength(3);
  expect(s.tasks.filter((t) => t.parentId === task.id)).toHaveLength(2);
  await page
    .getByLabel("电话跟进中文 状态", { exact: true })
    .selectOption("completed");
  await expect(page.getByRole("dialog", { name: "确认影响" })).toContainText(
    "比价",
  );
  await expect(page.getByRole("dialog", { name: "确认影响" })).toContainText(
    "确认交付",
  );
  await tab("确认执行");
  s = await snapshot();
  expect(s.tasks.every((t) => t.status === "completed")).toBe(true);
  await page.getByLabel("比价 状态", { exact: true }).selectOption("todo");
  await expect(page.getByRole("dialog", { name: "确认影响" })).toContainText(
    "电话跟进中文",
  );
  await tab("确认执行");
  results.push(
    "Native subtree split, explicit batch completion preview, child reopen reopens parent",
  );
  await expect(
    page.getByRole("button", { name: "全部任务", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 680, height: 600 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".work-title").first()).toHaveCSS(
    "color",
    "rgb(236, 236, 236)",
  );
  expect(
    await page
      .locator(".work-view")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
  ).toBe(true);
  await page.screenshot({ path: join(evidence, "compact-dark.png") });
  const before = await snapshot();
  stop(app.child);
  await app.browser.close();
  app = await launch();
  page = app.page;
  await expect.poll(async () => (await snapshot()).tasks.length).toBe(3);
  s = await snapshot();
  expect(s.tasks).toEqual(before.tasks);
  expect(s.days).toEqual(before.days);
  expect(s.settings).toEqual(before.settings);
  expect(errors).toEqual([]);
  results.push(
    "Abrupt native restart preserves identities, dates, day notes, sections and zone; compact/dark screenshot; no page errors",
  );
  await writeFile(
    join(evidence, "native-p1.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        dataDirectory: data,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  if (app?.page)
    await app.page
      .screenshot({ path: join(evidence, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (app) {
    stop(app.child);
    await app.browser.close().catch(() => {});
  }
}
