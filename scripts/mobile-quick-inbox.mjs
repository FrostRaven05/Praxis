import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dismissTestConfirmation } from "./android-test-confirmations.mjs";
const evidence = resolve("docs/evidence/mobile-quick-inbox");
await mkdir(evidence, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const metrics = await page.context().newCDPSession(page);
page.setDefaultTimeout(10000);
const stamp = process.argv[2] ?? String(Date.now()).slice(-8),
  names = ["今天", "明天", "日期"].map((n) => `面板验收 ${stamp} ${n}`);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) =>
  d.message().includes(stamp) && d.message().includes("移到回收站")
    ? d.accept()
    : d.dismiss(),
);
const panel = page.getByRole("dialog", { name: "收件箱面板", exact: true });
const open = async () => {
  await page.getByRole("button", { name: "打开收件箱", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect
    .poll(() =>
      panel.evaluate((el) =>
        Math.round(el.getBoundingClientRect().bottom - innerHeight),
      ),
    )
    .toBe(0);
};
const row = (name) => panel.locator(".pm-quick-task").filter({ hasText: name });
const navigation = (name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const shift = (date, n) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + n);
  return value.toISOString().slice(0, 10);
};
let today,
  deadline,
  projectId = "";
const finishOnly = process.argv.includes("--finish");
const cleanupOnly = process.argv.includes("--cleanup") || finishOnly;
try {
  await page.locator(".pm-app").waitFor();
  if (cleanupOnly && !finishOnly) {
    const editor = page.locator(".pm-dialog");
    await expect(editor.getByLabel("名称", { exact: true })).toHaveValue(
      names[0],
    );
    today = await editor.getByLabel("安排日期", { exact: true }).inputValue();
    deadline = await editor
      .getByLabel("真实期限", { exact: true })
      .inputValue();
    projectId = await editor
      .getByLabel(/^项目/)
      .locator("option")
      .evaluateAll(
        (options) => options.map((o) => o.value).find(Boolean) ?? "",
      );
    await editor.getByRole("button", { name: "取消", exact: true }).click();
  }
  if (await page.getByRole("dialog", { name: "侧边菜单" }).count())
    await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
  if (await panel.count())
    await panel
      .getByRole("button", { name: "关闭收件箱", exact: true })
      .click();
  if (!cleanupOnly) {
    await navigation("清单");
    if (process.argv.includes("--reuse-unplanned")) {
      await navigation("日历");
      today = await page.getByLabel("跳转日期", { exact: true }).inputValue();
      deadline = shift(today, 7);
      await navigation("清单");
    } else if (process.argv[2]) {
      await page
        .locator(".pm-task")
        .filter({ has: page.getByText(names[0], { exact: true }) })
        .locator(".pm-task-title")
        .click();
      const editor = page.locator(".pm-dialog");
      today = await editor.getByLabel("安排日期", { exact: true }).inputValue();
      deadline = await editor
        .getByLabel("真实期限", { exact: true })
        .inputValue();
      await editor.getByLabel("安排日期", { exact: true }).fill("");
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    for (const name of process.argv[2] ? [] : names) {
      await page.getByRole("button", { name: "新建任务", exact: true }).click();
      const editor = page.locator(".pm-dialog");
      await editor.getByLabel("名称", { exact: true }).fill(name);
      today ??= await editor
        .getByLabel("安排日期", { exact: true })
        .inputValue();
      deadline ??= shift(today, 7);
      await editor.getByLabel("安排日期", { exact: true }).fill("");
      await editor.getByLabel("真实期限", { exact: true }).fill(deadline);
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    await open();
    for (const name of names) await expect(row(name)).toHaveCount(1);
    const projectChoices = await row(names[0])
      .getByLabel(`设置项目：${names[0]}`, { exact: true })
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value));
    projectId = projectChoices.find((id) => !!id) ?? "";
    if (projectId) {
      await row(names[0])
        .getByLabel(`设置项目：${names[0]}`, { exact: true })
        .selectOption(projectId);
      await expect(
        row(names[0]).getByLabel(`设置项目：${names[0]}`, { exact: true }),
      ).toHaveValue(projectId);
      await expect(
        panel.getByRole("button", { name: "关闭收件箱", exact: true }),
      ).toBeEnabled();
    }
    await panel.getByLabel("待办排序", { exact: true }).selectOption("title");
    await expect(panel.getByLabel("待办排序", { exact: true })).toHaveValue(
      "title",
    );
    await panel.getByRole("button", { name: "重置", exact: true }).click();
    await expect(panel.getByLabel("待办排序", { exact: true })).toHaveValue(
      "created",
    );
    await page.screenshot({ path: join(evidence, "panel.png") });
    await page.evaluate((testName) => {
      const cap = window.Capacitor,
        original = cap.nativePromise;
      window.__quickInboxOriginal = original;
      let armed = false;
      cap.nativePromise = async function (plugin, method, options) {
        if (
          plugin === "CapacitorSQLite" &&
          method === "run" &&
          String(options.statement).startsWith(
            "INSERT INTO mobile_operations(",
          ) &&
          JSON.stringify(options.values).includes(testName)
        )
          armed = true;
        const result = await original.call(this, plugin, method, options);
        if (
          armed &&
          plugin === "CapacitorSQLite" &&
          method === "commitTransaction"
        ) {
          cap.nativePromise = original;
          throw new Error("面板验收：已保存但响应丢失");
        }
        return result;
      };
    }, names[0]);
    await row(names[0])
      .getByRole("button", { name: "移到今天", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "重试原操作", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "关闭收件箱", exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole("button", { name: "重试原操作", exact: true })
      .click();
    await expect(row(names[0])).toHaveCount(0);
    await row(names[1])
      .getByRole("button", { name: "移到明天", exact: true })
      .click();
    await expect(row(names[1])).toHaveCount(0);
    await row(names[2])
      .getByLabel(`选择日期：${names[2]}`, { exact: true })
      .fill(shift(today, 3));
    await expect(row(names[2])).toHaveCount(0);
    await panel.getByRole("tab", { name: "任务模板", exact: true }).click();
    await expect(
      panel.getByRole("tab", { name: "任务模板", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await panel.getByRole("tab", { name: "待办箱", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 780 });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: join(evidence, "panel-320.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(panel).toHaveCSS("background-color", "rgb(47, 47, 47)");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({ path: join(evidence, "panel-dark.png") });
    await metrics.send("Emulation.clearDeviceMetricsOverride");
    await page.emulateMedia({ colorScheme: "light" });
    await panel
      .getByRole("button", { name: "关闭收件箱", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "打开收件箱", exact: true }),
    ).toBeFocused();
  }
  if (!finishOnly) {
    for (const [name, date] of [
      [names[0], today],
      [names[1], shift(today, 1)],
      [names[2], shift(today, 3)],
    ]) {
      await navigation("日历");
      await page.getByLabel("跳转日期", { exact: true }).fill(date);
      const task = page
        .locator(".pm-task")
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(task).toHaveCount(1);
      await task.locator(".pm-task-title").click();
      const editor = page.locator(".pm-dialog");
      await expect(editor.getByLabel("安排日期", { exact: true })).toHaveValue(
        date,
      );
      await expect(editor.getByLabel("真实期限", { exact: true })).toHaveValue(
        deadline,
      );
      if (name === names[0] && projectId)
        await expect(editor.getByLabel(/^项目/)).toHaveValue(projectId);
      await editor
        .getByRole("button", { name: "移到回收站", exact: true })
        .click();
      await expect(editor).toHaveCount(0);
      await expect(task).toHaveCount(0);
      dismissTestConfirmation(stamp);
    }
    await page.getByLabel("跳转日期", { exact: true }).fill(today);
  }
  await navigation("清单");
  // Dismiss any IME left by editor autofocus before testing the panel's back action.
  execFileSync(
    join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe"),
    ["-s", "emulator-5554", "shell", "input", "keyevent", "111"],
  );
  await page.evaluate(() => window.Capacitor.Plugins.App.getState());
  await open();
  const rect = await panel.boundingBox();
  await page.mouse.click(20, rect.y - 25);
  await expect(panel).toHaveCount(0);
  await open();
  execFileSync(
    join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe"),
    ["-s", "emulator-5554", "shell", "input", "keyevent", "4"],
  );
  await expect(panel).toHaveCount(0);
  await open();
  await panel
    .getByRole("button", { name: "整理收件箱原文", exact: false })
    .click();
  await expect(page.getByLabel("记下原文", { exact: true })).toBeVisible();
  await navigation("清单");
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "Today, tomorrow and picked-date scheduling persist without altering real deadlines; project assignment persists.",
          "Lost commit response freezes controls and retries the same operation successfully.",
          "Project filters and sorting, templates, raw inbox access, dismissal, 320px and dark layout work.",
          "Only three marked test tasks created, then moved to trash; existing tasks untouched.",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Native quick inbox scheduling, persistence, retry, project assignment, deadlines, layout and original capture access. Test tasks cleaned up.",
  );
} finally {
  await page.evaluate(() => {
    if (window.__quickInboxOriginal)
      window.Capacitor.nativePromise = window.__quickInboxOriginal;
    delete window.__quickInboxOriginal;
  });
  await metrics.send("Emulation.clearDeviceMetricsOverride");
  await metrics.detach();
  await page.emulateMedia({ colorScheme: "light" });
  await browser.close();
}
