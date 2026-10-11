import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { chooseDate } from "./native-date-controls.mjs";

const root = resolve(import.meta.dirname, "..");
const evidence = join(root, "docs/evidence/task-autosave");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/autosave-qa-"));
const exe = resolve(
  root,
  process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
);
const errors = [],
  checks = [];
let child, browser, page;
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
async function interceptReply(taskId, notes, mode) {
  await page.evaluate(
    ({ taskId, notes, mode }) => {
      const callbacks = window.__TAURI_INTERNALS__.callbacks;
      const original = callbacks.set;
      let nextResolve = null;
      window.__autosaveQA = {
        replies: 0,
        restore: () => {
          callbacks.set = original;
        },
      };
      callbacks.set = function (id, callback) {
        const record = { reject: null };
        if (nextResolve) {
          nextResolve.reject = callback;
          nextResolve = null;
        } else nextResolve = record;
        return original.call(this, id, (data) => {
          if (data?.taskId === taskId && data.notes === notes) {
            window.__autosaveQA.replies++;
            if (window.__autosaveQA.replies === 1) {
              if (mode === "slow") {
                setTimeout(() => callback(data), 1200);
                return;
              }
              if (mode === "lostAck") {
                record.reject("QA acknowledgement interrupted");
                return;
              }
            }
          }
          callback(data);
        });
      };
    },
    { taskId, notes, mode },
  );
}
try {
  await start();
  await ipc("productivity_command", {
    command: {
      operationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        type: "zone",
        timeZone: "Asia/Hong_Kong",
        expectedVersion: null,
        expectedTemplates: [],
      },
    },
  });
  await page.getByLabel("任务标题", { exact: true }).fill("Lorem autosave");
  await page.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(page.locator(".task-item")).toHaveCount(1);
  const date = await page
    .getByRole("button", { name: "查看日期", exact: true })
    .getAttribute("aria-description");
  const [task] = await ipc("list_day", { date });
  const read = () => ipc("task_details", { taskId: task.taskId });
  await page.locator(".task-row").first().click();
  const title = () => page.getByLabel("编辑任务标题", { exact: true });
  const notes = () => page.locator("#panel-notes");
  const criteria = () => page.getByLabel("完成标准", { exact: true });
  const footer = () => page.locator(".task-panel-footer");
  await expect(title()).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  await title().evaluate((e) => (e.dataset.identity = "stable"));
  await title().fill("Lorem live title");
  await expect.poll(async () => (await read()).title).toBe("Lorem live title");
  await expect(title()).toBeFocused();
  await expect(title()).toHaveAttribute("data-identity", "stable");
  await notes().fill("Lorem notes");
  await criteria().fill("Lorem completion criteria");
  await expect
    .poll(async () => (await read()).completionCriteria)
    .toBe("Lorem completion criteria");
  await expect.poll(async () => (await read()).notes).toBe("Lorem notes");
  await expect(criteria()).toBeFocused();
  await page.getByRole("button", { name: "30 分钟", exact: true }).click();
  await expect.poll(async () => (await read()).estimatedMinutes).toBe(30);
  await page.getByLabel("重要任务", { exact: true }).check();
  await expect.poll(async () => (await read()).important).toBe(true);
  await expect(footer()).toContainText("已自动保存");
  checks.push(
    "Title, description, criteria, estimate and importance persist automatically; focus and editor identity stay stable.",
  );

  await page.getByLabel("预估工作量（分钟）", { exact: true }).fill("2000");
  await expect(
    page.locator('.task-panel-feedback[role="alert"]'),
  ).toBeVisible();
  expect((await read()).estimatedMinutes).toBe(30);
  await page.getByLabel("预估工作量（分钟）", { exact: true }).fill("45");
  await expect.poll(async () => (await read()).estimatedMinutes).toBe(45);
  await title().fill("");
  await expect(
    page.locator('.task-panel-feedback[role="alert"]'),
  ).toContainText("请填写任务标题");
  expect((await read()).title).toBe("Lorem live title");
  await title().fill("Lorem valid again");
  await expect.poll(async () => (await read()).title).toBe("Lorem valid again");
  checks.push(
    "Invalid minutes and empty titles preserve stored values; correcting input resumes autosave.",
  );

  await interceptReply(task.taskId, "Lorem first queued draft", "slow");
  await notes().fill("Lorem first queued draft");
  await expect(footer()).toContainText("正在保存");
  await expect(notes()).toBeEnabled();
  await notes().fill("Lorem newest queued draft");
  await title().fill("Lorem queued title");
  await criteria().fill("Lorem queued criteria");
  await expect
    .poll(async () => (await read()).notes)
    .toBe("Lorem newest queued draft");
  await expect
    .poll(async () => (await read()).title)
    .toBe("Lorem queued title");
  await expect
    .poll(async () => (await read()).completionCriteria)
    .toBe("Lorem queued criteria");
  await expect(footer()).toContainText("已自动保存");
  await page.evaluate(() => window.__autosaveQA.restore());
  checks.push(
    "Input during a delayed write is queued with committed versions; writes remain serial.",
  );

  await title().dispatchEvent("compositionstart");
  await title().fill("中文输入中的标题");
  await delay(700);
  expect((await read()).title).toBe("Lorem queued title");
  await title().dispatchEvent("compositionend");
  await expect.poll(async () => (await read()).title).toBe("中文输入中的标题");
  checks.push("IME composition does not persist unfinished Chinese input.");

  const versionBeforeRetry = (await read()).version;
  await interceptReply(task.taskId, "Lorem acknowledged retry", "lostAck");
  await notes().fill("Lorem acknowledged retry");
  await expect(
    page.locator('.task-panel-feedback[role="alert"]'),
  ).toContainText("QA acknowledgement interrupted");
  await expect(notes()).toHaveValue("Lorem acknowledged retry");
  await delay(700);
  expect(await page.evaluate(() => window.__autosaveQA.replies)).toBe(1);
  await page.getByRole("button", { name: "重试自动保存", exact: true }).click();
  await expect(footer()).toContainText("已自动保存");
  expect(await page.evaluate(() => window.__autosaveQA.replies)).toBe(2);
  await page.evaluate(() => window.__autosaveQA.restore());
  expect((await read()).version).toBe(versionBeforeRetry + 1);
  expect((await read()).notes).toBe("Lorem acknowledged retry");
  checks.push(
    "Unacknowledged writes stop retrying automatically, preserve input and retry the same operation without duplicate changes.",
  );

  await chooseDate(page, "截止时间（本地时间）", date + "T18:30");
  await expect.poll(async () => (await read()).deadline).not.toBe(null);
  await page
    .getByRole("button", { name: "清除截止时间（本地时间）", exact: true })
    .click();
  await expect.poll(async () => (await read()).deadline).toBe(null);
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看日期", exact: true }),
  ).not.toHaveAttribute("aria-description", date);
  await expect(title()).toHaveValue("中文输入中的标题");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看日期", exact: true }),
  ).toHaveAttribute("aria-description", date);
  await expect(footer()).toContainText("已自动保存");
  expect(
    (await ipc("list_day", { date })).filter(
      (row) => row.taskId === task.taskId,
    ),
  ).toHaveLength(1);
  checks.push(
    "Date and deadline changes apply automatically; rescheduling retains one task and a stable inspector.",
  );

  await title().fill("Lorem flushed on close");
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await expect(page.locator(".task-detail")).toHaveCount(0);
  expect((await read()).title).toBe("Lorem flushed on close");
  await page.locator(".task-row").first().click();
  await expect(title()).toHaveValue("Lorem flushed on close");
  await page.screenshot({
    path: join(evidence, "autosave.png"),
    fullPage: true,
  });
  checks.push(
    "Closing the inspector immediately flushes pending edits, which survive reopening.",
  );

  await notes().fill("Lorem flushed before window close");
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect.poll(() => child.exitCode, { timeout: 10000 }).not.toBe(null);
  await browser.close();
  browser = undefined;
  await start();
  expect((await read()).notes).toBe("Lorem flushed before window close");
  checks.push(
    "Closing the native window flushes pending edits; restarting restores them from SQLite.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  if (page && !page.isClosed())
    await page.screenshot({
      path: join(evidence, "failed.png"),
      fullPage: true,
    });
  throw e;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
}
