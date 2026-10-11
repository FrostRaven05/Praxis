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
const evidence = join(root, "docs/evidence/daily-rollover-habits");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/daily-qa-"));
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

const shift = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
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
  const yesterday = shift(today, -1);
  const lateTask = uuid(),
    latePlan = uuid(),
    independentTask = uuid(),
    suggestedTask = uuid();
  await ipc("capture_task", {
    command: command({
      taskId: lateTask,
      planId: latePlan,
      title: "Lorem carried evening task",
      executionDate: yesterday,
      timeZone: "Asia/Hong_Kong",
      occurredAt: `${yesterday}T03:00:00Z`,
    }),
  });
  await ipc("update_plan", {
    command: command({
      date: yesterday,
      changes: [
        {
          taskId: lateTask,
          planId: latePlan,
          expectedVersion: 0,
          isFocus: false,
          estimatedMinutes: 30,
          focusRank: 0,
          dayPeriod: "evening",
          dayRank: 1,
        },
      ],
    }),
  });
  for (const [id, title, plan, deadline] of [
    [
      independentTask,
      "Lorem carried timed task",
      {
        kind: "instant",
        atUtc: `${yesterday}T07:30:00Z`,
        displayTimezone: "Asia/Hong_Kong",
      },
      { kind: "date", date: yesterday },
    ],
    [
      suggestedTask,
      "Lorem suggested task",
      null,
      { kind: "date", date: today },
    ],
  ]) {
    await ipc("productivity_command", {
      command: command({
        action: {
          type: "task",
          id,
          expectedVersion: null,
          title,
          notes: "Lorem retained notes",
          projectId: null,
          plan,
          deadline,
          followUp: null,
          priority: 4,
          waitingFor: "",
          waitingNote: "",
          labels: [],
        },
      }),
    });
  }
  const daily = uuid(),
    weekday = uuid(),
    weekly = uuid();
  const weekdayNumber =
    ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  for (const [id, name, frequency, weekdays, target] of [
    [daily, "Lorem daily habit", "daily", [], 7],
    [weekday, "Lorem weekday habit", "weekdays", [weekdayNumber], 1],
    [weekly, "Lorem weekly habit", "weekly", [], 1],
  ]) {
    await ipc("habit_command", {
      command: command({
        action: {
          type: "create",
          id,
          name,
          startDate: yesterday,
          frequency,
          weekdays,
          weeklyTarget: target,
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
  await expect(
    page.locator('.day-period[data-period="evening"]'),
  ).toContainText("Lorem carried evening task");
  await expect(
    page.locator('.day-period[data-period="afternoon"]'),
  ).toContainText("Lorem carried timed task");
  await expect(page.locator(".timeline-attention > summary")).toContainText(
    "建议任务",
  );
  await expect(
    page.getByText(/待重排|每日结果与习惯|当天习惯/, { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.locator(".work-daily, .timeline-support, .timeline-reschedule"),
  ).toHaveCount(0);
  await page.locator(".timeline-attention > summary").click();
  await expect(page.locator(".timeline-attention")).toContainText(
    "Lorem suggested task",
  );
  await expect(
    page.locator('.day-period[data-period="morning"] .habit-task'),
  ).toHaveCount(3);
  const habitToggle = await page
    .locator(".habit-task .completion-toggle")
    .first()
    .boundingBox();
  const taskToggle = await page
    .locator(`[data-plan-id="${latePlan}"] .completion-toggle`)
    .boundingBox();
  expect(Math.abs(habitToggle.x - taskToggle.x)).toBeLessThan(1);
  const snapshot = await ipc("productivity_snapshot");
  const timed = snapshot.tasks.find((t) => t.id === independentTask);
  expect(timed.plan.atUtc).toBe(`${today}T07:30:00Z`);
  expect(timed.deadline.date).toBe(yesterday);
  const todayRows = await ipc("list_day", { date: today });
  expect(todayRows.find((t) => t.taskId === lateTask).planId).toBe(latePlan);
  expect(
    (await ipc("list_day", { date: yesterday })).filter(
      (t) => t.taskId === lateTask,
    ),
  ).toHaveLength(0);
  const version = todayRows.find((t) => t.taskId === lateTask).version;
  await page.reload();
  await expect(
    page.locator('.day-period[data-period="morning"] .habit-task'),
  ).toHaveCount(3);
  expect(
    (await ipc("list_day", { date: today })).find((t) => t.taskId === lateTask)
      .version,
  ).toBe(version);
  checks.push(
    "Unfinished old plans move to today's original periods with stable identity, unchanged deadlines and no duplicate versions; suggestions replace Need Attention and support sections are absent.",
  );

  await page
    .getByRole("button", { name: "完成习惯：Lorem daily habit", exact: true })
    .click();
  await expect(
    page.locator(`.day-period [data-habit-id="${daily}"]`),
  ).toHaveCount(0);
  await expect(page.locator(".completed-heading")).toContainText("已完成 · 1");
  await page.locator(".completed-heading").click();
  await expect(
    page.locator(`.completed-section [data-habit-id="${daily}"]`),
  ).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (await ipc("habit_snapshot", { date: today })).habits.find(
          (r) => r.habit.id === daily,
        ).entry?.status,
    )
    .toBe("done");
  const completedVersion = (
    await ipc("habit_snapshot", { date: today })
  ).habits.find((r) => r.habit.id === daily).entry.version;
  await page.reload();
  await expect(page.locator(".completed-heading")).toContainText("已完成 · 1");
  await page.locator(".completed-heading").click();
  await page
    .getByRole("button", { name: "撤销完成：Lorem daily habit", exact: true })
    .click();
  await expect(
    page.locator(`.day-period [data-habit-id="${daily}"]`),
  ).toHaveCount(1);
  expect(
    (await ipc("habit_snapshot", { date: today })).habits.find(
      (r) => r.habit.id === daily,
    ).entry.version,
  ).toBe(completedVersion + 1);
  await page
    .getByRole("button", { name: "完成习惯：Lorem weekly habit", exact: true })
    .click();
  await expect(
    page.locator(`.day-period [data-habit-id="${weekly}"]`),
  ).toHaveCount(0);
  checks.push(
    "Habit rows share the daily task list; completing and undoing persist native habit check-ins across reloads, including weekly targets.",
  );

  await page.getByRole("button", { name: "下一周", exact: true }).click();
  await expect(
    page.locator(`.day-period [data-habit-id="${daily}"]`),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: "完成习惯：Lorem daily habit",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "回到今天", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "完成习惯：Lorem daily habit",
      exact: true,
    }),
  ).toBeEnabled();
  await chooseViewDate(page, yesterday);
  await expect(
    page.locator(`.day-period [data-habit-id="${daily}"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`.day-period [data-habit-id="${weekday}"]`),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "回到今天", exact: true }).click();
  await expect(
    page.locator(`.day-period [data-habit-id="${weekday}"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`.day-period [data-habit-id="${weekly}"]`),
  ).toHaveCount(0);
  checks.push(
    "Calendar browsing follows daily and weekday schedules, suppresses fulfilled weekly targets and prevents future check-ins.",
  );
  await page.screenshot({
    path: join(evidence, "daily-tasks.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 950 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.screenshot({
    path: join(evidence, "daily-tasks-390.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await browser.close();
  browser = null;
  child.kill();
  await delay(500);
  await start();
  await expect(
    page.locator(`.day-period [data-habit-id="${daily}"]`),
  ).toHaveCount(1);
  await expect(page.locator(".completed-heading")).toContainText("已完成 · 1");
  await expect(
    page.locator('.day-period[data-period="evening"]'),
  ).toContainText("Lorem carried evening task");
  checks.push(
    "Native restart preserves the postponed plans and independent daily habit completion history.",
  );
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
}
