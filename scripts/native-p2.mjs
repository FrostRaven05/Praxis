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
const data = await mkdtemp(join(root, ".tools", "p2-qa-"));
const evidence = join(
  root,
  process.env.PRAXIS_EVIDENCE_DIR ?? "docs/evidence/p2",
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
  const tab = (name) => page.getByRole("button", { name, exact: true }).click();
  await page.getByLabel("工作空间时区", { exact: true }).fill("Asia/Hong_Kong");
  await tab("预览时区影响");
  await tab("确认工作空间时区");
  await expect(page.getByLabel("所选日期")).toBeVisible();
  const today = await page.getByLabel("所选日期").inputValue();
  await tab("快速任务");
  const dialog = page.getByRole("dialog", { name: "任务属性" });
  await dialog.getByLabel("任务标题", { exact: true }).fill("回收站中文测试");
  await dialog.getByRole("button", { name: "预览属性", exact: true }).click();
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const taskId = (await ipc("productivity_snapshot")).tasks[0].id;
  await tab("回收站");
  await expect(page.getByLabel("允许恢复的天数")).toHaveValue("30");
  await page.getByLabel("允许恢复的天数").fill("45");
  await tab("保存恢复窗口");
  await expect
    .poll(async () => (await ipc("trash_snapshot")).settings.recoveryDays)
    .toBe(45);
  await page.getByLabel("选择内容").selectOption(taskId);
  await tab("确认移入回收站");
  await expect(
    page.getByRole("button", { name: "恢复 回收站中文测试" }),
  ).toBeVisible();
  expect((await ipc("productivity_snapshot")).tasks).toHaveLength(0);
  await tab("恢复 回收站中文测试");
  await expect(page.getByText("回收站为空。", { exact: true })).toBeVisible();
  expect((await ipc("productivity_snapshot")).tasks[0].id).toBe(taskId);
  results.push(
    "T15: Native UI delete and restore preserves identity and excludes deleted task from workspace",
  );
  await tab("重复任务");
  await page.getByLabel("标题", { exact: true }).fill("每日复盘中文");
  await tab("保存规则");
  await expect(
    page.getByRole("heading", { name: "每日复盘中文" }),
  ).toBeVisible();
  await tab("补齐下一批（最多100项）");
  await expect
    .poll(async () => (await ipc("recurrence_snapshot")).templates[0].remaining)
    .toBe(0);
  const generated = (await ipc("productivity_snapshot")).tasks.filter(
    (t) => t.title === "每日复盘中文",
  );
  expect(generated.length).toBeGreaterThanOrEqual(30);
  await tab("全部任务");
  await expect(
    page.getByRole("button", { name: "每日复盘中文", exact: true }),
  ).toHaveCount(generated.length);
  results.push(
    "T18: Native UI creates rule and expands next 30 days; returning task list refreshes generated instances",
  );
  const tomorrowDate = new Date(today + "T12:00:00Z");
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  await tab("重复任务");
  await tab("修改未来规则…");
  const ruleDialog = page.getByRole("dialog", { name: "修改未来重复规则" });
  await ruleDialog.getByLabel("生效日期（明天起）").fill(tomorrow);
  await ruleDialog.getByLabel("未来标题").fill("未来复盘中文");
  await ruleDialog.getByRole("button", { name: "预览受影响任务" }).click();
  await expect(ruleDialog).toContainText("标题改为 未来复盘中文");
  await ruleDialog.getByRole("button", { name: "确认未来规则" }).click();
  await expect(ruleDialog).toHaveCount(0);
  expect(
    (await ipc("productivity_snapshot")).tasks.filter(
      (t) => t.title === "每日复盘中文",
    ),
  ).toHaveLength(1);
  await tab("时区与标签");
  await page.getByLabel("工作空间时区", { exact: true }).fill("Asia/Tokyo");
  await tab("预览时区影响");
  await expect(page.getByText(/个已生成未来实例保持原日期/)).toBeVisible();
  await tab("确认工作空间时区");
  await expect
    .poll(
      async () =>
        (await ipc("recurrence_snapshot")).templates[0].template.timeZone,
    )
    .toBe("Asia/Tokyo");
  results.push(
    "T19: Future rule preview preserves today's occurrence; workspace time-zone confirmation updates template atomically",
  );
  await tab("搜索与筛选");
  await page.getByRole("combobox", { name: /^类型/ }).selectOption("task");
  await page.getByLabel("搜索文字").fill("回收站中文测试");
  await tab("搜索 / 应用筛选");
  await expect(page.locator(".search-views article")).toHaveCount(1);
  await expect(page.getByLabel("视图名称")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "关注的工作视图" }),
  ).toHaveCount(0);
  results.push(
    "T16: Offline search supports temporary filters without saved-view controls",
  );
  await tab("习惯");
  await tab("创建习惯");
  await page.getByLabel("习惯名称").fill("读书中文");
  await page.getByLabel("触发情境").fill("早餐后");
  await page.getByLabel("最低版本").fill("一页");
  await tab("保存习惯");
  let habit = page
    .locator(".habit-card")
    .filter({ has: page.getByRole("heading", { name: "读书中文" }) });
  await expect(habit).toBeVisible();
  await habit.getByRole("button", { name: "完成", exact: true }).click();
  await expect(habit).toContainText("已完成");
  await habit.getByRole("button", { name: "撤销记录", exact: true }).click();
  await expect(habit).toContainText("未记录");
  await habit.getByRole("button", { name: "跳过", exact: true }).click();
  await expect(habit).toContainText("已跳过");
  await habit
    .getByRole("button", { name: "暂停、恢复或变更规则", exact: true })
    .click();
  await habit.getByLabel("执行状态").selectOption("true");
  await habit.getByRole("button", { name: "预览变更", exact: true }).click();
  await expect(habit).toContainText("暂停，不产生执行要求");
  await habit
    .getByRole("button", { name: "确认规则变更", exact: true })
    .click();
  await expect(habit).toContainText("生效的规则");
  results.push(
    "T21: Habit pause previews next-day effective rule and preserves current-day entry",
  );
  await tab("今日");
  await expect(page.locator(".habit-card")).toContainText("已跳过");
  const before = await ipc("habit_snapshot", { date: today });
  results.push(
    "T20: Native habit form, complete, undo, skip and Today summary use persistent date identity",
  );
  await tab("项目检查与周回顾");
  await tab("新建周回顾");
  await page
    .getByLabel("推进成果", { exact: true })
    .fill("本周完成中文原生验证");
  await page.getByLabel("阻塞", { exact: true }).fill("等待Android设备");
  await page.getByLabel("下周重点", { exact: true }).fill("继续双端验证");
  await expect(
    page.getByRole("button", { name: "今日", exact: true }),
  ).toBeDisabled();
  await tab("保存周回顾");
  await expect(page.getByText("已保存到本机", { exact: true })).toBeVisible();
  const reviewBefore = await ipc("review_snapshot");
  expect(reviewBefore.reviews).toHaveLength(1);
  expect((await ipc("productivity_snapshot")).tasks).toHaveLength(
    generated.length + 1,
  );
  results.push(
    "T17: Manual review saves an independent record without creating tasks; unsaved draft guards navigation",
  );
  await tab("今日");
  await page.setViewportSize({ width: 680, height: 600 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    page.getByRole("button", { name: "全部任务", exact: true }),
  ).toHaveCSS("color", "rgb(236, 236, 236)");
  expect(
    await page
      .locator(".work-view")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
  ).toBe(true);
  await page.locator(".habit-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "habits-dark.png") });
  stop(app.child);
  await app.browser.close();
  app = await launch();
  page = app.page;
  const after = await ipc("habit_snapshot", { date: today });
  expect(after.habits).toEqual(before.habits);
  expect((await ipc("review_snapshot")).reviews).toEqual(reviewBefore.reviews);
  expect((await ipc("productivity_snapshot")).tasks).toHaveLength(
    generated.length + 1,
  );
  expect(errors).toEqual([]);
  results.push(
    "Abrupt restart preserves restored tasks, generated occurrences and habit entries without page errors",
  );
  await writeFile(
    join(evidence, "native-p2.json"),
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
