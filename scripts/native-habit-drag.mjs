import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID as uuid } from "node:crypto";
import net from "node:net";
import { chooseViewDate } from "./native-date-controls.mjs";

const root = resolve(import.meta.dirname, "..");
const exe = resolve(
  root,
  process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
);
const evidence = join(root, "docs/evidence/habit-drag");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/habit-drag-qa-"));
let browser, child, page;
const errors = [],
  checks = [];
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
const command = (extra) => ({
  operationId: uuid(),
  occurredAt: new Date().toISOString(),
  ...extra,
});

try {
  await start();
  await ipc("productivity_command", {
    command: command({
      action: {
        type: "zone",
        timeZone: "Asia/Hong_Kong",
        expectedVersion: null,
        expectedTemplates: [],
      },
    }),
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const plans = [uuid(), uuid()],
    tasks = [uuid(), uuid()],
    habits = [uuid(), uuid()];
  for (const i of [0, 1]) {
    await ipc("capture_task", {
      command: command({
        taskId: tasks[i],
        planId: plans[i],
        title: `Lorem ordinary ${i + 1}`,
        executionDate: today,
        timeZone: "Asia/Hong_Kong",
      }),
    });
  }
  for (const i of [0, 1]) {
    await ipc("habit_command", {
      command: command({
        action: {
          type: "create",
          id: habits[i],
          name: `Lorem habit ${i + 1}`,
          startDate: today,
          frequency: "daily",
          weekdays: [],
          weeklyTarget: 7,
          triggerContext: "",
          normalVersion: "",
          minimumVersion: "",
          notes: "",
          projectId: null,
        },
      }),
    });
  }
  await page.reload();
  const habit = (i) =>
    page.locator(`.day-period [data-habit-id="${habits[i]}"]`);
  const task = (i) => page.locator(`[data-plan-id="${plans[i]}"]`);
  const period = (key) => page.locator(`.day-period[data-period="${key}"]`);
  const placement = async (i, date = today) =>
    (await ipc("habit_snapshot", { date })).habits.find(
      (r) => r.habit.id === habits[i],
    ).placement;
  const order = async (key) =>
    period(key)
      .locator(".task-item")
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            row.getAttribute("data-habit-id") ??
            row.getAttribute("data-plan-id"),
        ),
      );
  const waitIdle = () =>
    expect(
      page.getByRole("button", {
        name: "拖动排序：Lorem habit 1",
        exact: true,
      }),
    ).toBeEnabled();
  await expect(period("morning").locator(".task-item")).toHaveCount(4);
  await habit(0).dragTo(period("afternoon"), {
    targetPosition: { x: 150, y: 80 },
  });
  await expect(
    period("afternoon").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  expect((await placement(0)).dayPeriod).toBe("afternoon");
  await task(0).dragTo(habit(0), { targetPosition: { x: 150, y: 5 } });
  await expect.poll(() => order("afternoon")).toEqual([plans[0], habits[0]]);
  await waitIdle();
  await habit(1).dragTo(habit(0), {
    targetPosition: { x: 150, y: (await habit(0).boundingBox()).height - 4 },
  });
  await expect
    .poll(() => order("afternoon"))
    .toEqual([plans[0], habits[0], habits[1]]);
  await waitIdle();
  await habit(0).dragTo(task(0), { targetPosition: { x: 150, y: 5 } });
  await expect
    .poll(() => order("afternoon"))
    .toEqual([habits[0], plans[0], habits[1]]);
  await waitIdle();
  await task(0).dragTo(habit(1), {
    targetPosition: { x: 150, y: (await habit(1).boundingBox()).height - 4 },
  });
  await expect
    .poll(() => order("afternoon"))
    .toEqual([habits[0], habits[1], plans[0]]);
  await waitIdle();
  const h1 = () =>
    page.getByRole("button", { name: "拖动排序：Lorem habit 1", exact: true });
  await h1().press("ArrowRight");
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  await h1().press("ArrowLeft");
  await expect
    .poll(() => order("afternoon"))
    .toEqual([habits[1], plans[0], habits[0]]);
  await waitIdle();
  await h1().press("ArrowUp");
  await expect
    .poll(() => order("afternoon"))
    .toEqual([habits[1], habits[0], plans[0]]);
  await waitIdle();
  await h1().press("ArrowRight");
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  checks.push(
    "Physical dragging moves habits into empty periods and mixes both kinds of row before/after each other; keyboard arrows share the same persistent ordering.",
  );

  await chooseViewDate(page, tomorrow);
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "完成习惯：Lorem habit 1", exact: true }),
  ).toBeDisabled();
  await expect(h1()).toBeEnabled();
  await habit(0).dragTo(period("morning"), {
    targetPosition: { x: 150, y: 80 },
  });
  await expect(
    period("morning").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  expect((await placement(0, tomorrow)).dayPeriod).toBe("morning");
  await chooseViewDate(page, today);
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  const before = await placement(0);
  await ipc("update_plan", {
    command: command({
      date: today,
      changes: [],
      habitChanges: [
        {
          habitId: habits[0],
          expectedVersion: before.version,
          dayPeriod: "evening",
          dayRank: 2,
        },
      ],
    }),
  });
  await h1().press("ArrowLeft");
  await expect(
    period("afternoon").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  await expect(page.locator('.today-content [role="alert"]')).toHaveCount(0);
  await h1().press("ArrowRight");
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  checks.push(
    "Each date saves its own override, future occurrences inherit the recent period, and stale placement versions recover automatically without a blocking alert or changing habit checks.",
  );

  await page
    .getByRole("button", { name: "完成习惯：Lorem habit 1", exact: true })
    .click();
  await expect(habit(0)).toHaveCount(0);
  await page.locator(".completed-heading").click();
  await expect(
    page.locator(
      `.completed-section [data-habit-id="${habits[0]}"] .task-drag-handle`,
    ),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "撤销完成：Lorem habit 1", exact: true })
    .click();
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  await waitIdle();
  expect(
    (await ipc("habit_snapshot", { date: today })).habits.find(
      (r) => r.habit.id === habits[0],
    ).week.done,
  ).toBe(0);
  const positions = [await placement(0), await placement(1)];
  await page.screenshot({
    path: join(evidence, "mixed-day.png"),
    fullPage: true,
  });
  await browser.close();
  browser = null;
  child.kill();
  await delay(500);
  await start();
  await expect(
    period("evening").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  expect([await placement(0), await placement(1)]).toEqual(positions);
  await chooseViewDate(page, tomorrow);
  await expect(
    period("morning").locator(`[data-habit-id="${habits[0]}"]`),
  ).toBeVisible();
  checks.push(
    "Completing and undoing preserve the assigned period; native restart restores both today's mixed ordering and tomorrow's independent arrangement.",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
}
