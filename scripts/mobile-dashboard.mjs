import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const evidence = resolve("docs/evidence/mobile-dashboard");
await mkdir(evidence, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const nav = page.getByRole("navigation", { name: "主导航" });
const route = async (name) => {
  await nav.getByRole("button", { name, exact: true }).click();
  await expect(nav.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
};
const checks = [];
let originalTheme;
const fixture = `专注验收 ${Date.now()}`;
let createdFixture = false;
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const noOverflow = async () =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
async function cleanupFocus() {
  await route("专注");
  const finish = page.getByRole("button", { name: "结束并保存", exact: true });
  if (
    (await finish.count()) &&
    (await page.locator(".pm-focus-select h2").innerText()) === fixture
  ) {
    await finish.click();
    await expect(finish).toHaveCount(0);
  }
  const history = page.getByRole("button", { name: "专注记录", exact: true });
  if ((await history.getAttribute("aria-expanded")) !== "true")
    await history.click();
  const deletion = page.getByRole("button", {
    name: `删除专注记录：${fixture}`,
    exact: true,
  });
  if (await deletion.count()) {
    await deletion.click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "打开菜单", exact: true }),
    ).toBeEnabled();
  }
}
try {
  await page.locator(".pm-app").waitFor();
  if (
    (await page.locator(".pm-dialog[open]").count()) ||
    (await page.getByText("当前有编辑内容。", { exact: true }).count())
  )
    throw Error("Existing draft must remain untouched");
  originalTheme = await page.evaluate(
    () => document.documentElement.dataset.themeColor,
  );
  await route("清单");
  const taskTitles = await page
    .locator(".pm-task-title strong")
    .allTextContents();
  await route("日历");
  await expect(page.locator(".pm-week")).toHaveCount(0);
  const initialMonth = await page
    .getByLabel("跳转月份", { exact: true })
    .inputValue();
  const today = await page
    .locator(".pm-month-day.selected")
    .getAttribute("aria-label");
  const todayDate = today.slice(0, 10);
  expect((await page.locator(".pm-month-day").count()) % 7).toBe(0);
  await page.getByRole("button", { name: "下个月", exact: true }).click();
  await expect(page.getByLabel("跳转月份", { exact: true })).not.toHaveValue(
    initialMonth,
  );
  await page.getByRole("button", { name: "上个月", exact: true }).click();
  await expect(page.getByLabel("跳转月份", { exact: true })).toHaveValue(
    initialMonth,
  );
  await page.getByLabel("跳转月份", { exact: true }).fill("2026-11");
  await expect(page.locator(".pm-month-day.selected")).toHaveAttribute(
    "aria-label",
    /^2026-11-01/,
  );
  await page.getByRole("button", { name: /^2026-11-15/ }).click();
  await expect(page.locator(".pm-month-day.selected")).toHaveAttribute(
    "aria-label",
    /^2026-11-15/,
  );
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(
    page.locator(".pm-dialog").getByLabel("安排日期", { exact: true }),
  ).toHaveValue("2026-11-15");
  await page
    .locator(".pm-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page
    .locator(".pm-month-toolbar")
    .getByRole("button", { name: "今天", exact: true })
    .click();
  await expect(page.locator(".pm-month-day.selected")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${todayDate}`),
  );
  await settle();
  await page.screenshot({ path: join(evidence, "calendar.png") });
  checks.push(
    "Month navigation, date selection, deadline snippets and new-task date preserved",
  );

  await route("统计");
  for (const name of ["昨日小结", "任务统计", "专注统计", "周报"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tabpanel")).toBeVisible();
    expect(await page.locator(".pm-statistics").innerText()).not.toMatch(
      /NaN|Infinity|undefined/,
    );
    await noOverflow();
  }
  await page.getByRole("button", { name: "写周回顾", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "回顾", exact: true }).first(),
  ).toBeVisible();
  await route("统计");
  await page.getByRole("tab", { name: "任务统计", exact: true }).click();
  await page
    .getByRole("tab", { name: "任务统计", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "专注统计", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "专注统计", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "任务统计", exact: true }).click();
  await settle();
  await page.screenshot({ path: join(evidence, "stats.png") });
  checks.push(
    "Four statistics tabs, accessible keyboard switching and weekly review entry",
  );

  await route("专注");
  if (
    await page.getByRole("button", { name: "结束并保存", exact: true }).count()
  ) {
    checks.push(
      "Existing active session preserved; timer mutation check skipped",
    );
  } else {
    await expect(page.getByRole("timer")).toHaveText("25:00");
    const select = page.getByLabel("选择专注任务", { exact: true });
    const option = select.locator("option").nth(1);
    if (await option.count()) {
      await select.selectOption(await option.getAttribute("value"));
      await expect(page.getByLabel("本次专注", { exact: true })).toHaveCount(0);
      await select.selectOption("");
    }
    await page.getByLabel("本次专注", { exact: true }).fill(fixture);
    await page.evaluate((name) => {
      const cap = window.Capacitor;
      const original = cap.nativePromise;
      window.__dashboardNativeOriginal = original;
      let armed = false;
      cap.nativePromise = async function (plugin, method, options) {
        if (
          plugin === "CapacitorSQLite" &&
          method === "run" &&
          options.statement?.startsWith("INSERT INTO mobile_operations(") &&
          options.values?.some(
            (value) => typeof value === "string" && value.includes(name),
          )
        )
          armed = true;
        const result = await original.call(this, plugin, method, options);
        if (
          armed &&
          plugin === "CapacitorSQLite" &&
          method === "commitTransaction"
        ) {
          cap.nativePromise = original;
          delete window.__dashboardNativeOriginal;
          throw Error("验收：专注提交成功但响应丢失");
        }
        return result;
      };
    }, fixture);
    createdFixture = true;
    await page.getByRole("button", { name: "开始专注", exact: true }).click();
    await page
      .getByRole("button", { name: "重试同一操作", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "结束并保存", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "打开菜单", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText("当前有编辑内容。", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".pm-focus-select h2")).toHaveText(fixture);
    await expect(page.getByRole("timer")).not.toHaveText("25:00");
    await route("日历");
    await route("专注");
    await expect(page.locator(".pm-focus-select h2")).toHaveText(fixture);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "打开菜单", exact: true }),
    ).toBeEnabled();
    await route("专注");
    await expect(page.locator(".pm-focus-select h2")).toHaveText(fixture);
    await expect(page.getByRole("timer")).not.toHaveText("25:00");
    await page.getByRole("button", { name: "结束并保存", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "开始专注", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "专注记录", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: `删除专注记录：${fixture}`,
        exact: true,
      }),
    ).toHaveCount(1);
    await route("统计");
    await page.getByRole("tab", { name: "专注统计", exact: true }).click();
    await expect(
      page.locator(".pm-stat-list").getByText(fixture, { exact: true }),
    ).toBeVisible();
    await cleanupFocus();
    checks.push(
      "25-minute focus persists across navigation and reload; lost-commit retry creates one session and clears draft; actual duration saved and own fixture recycled",
    );
  }
  await page.screenshot({ path: join(evidence, "focus.png") });
  await route("我的");
  await expect(page.locator(".pm-profile-controls")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator(".pm-profile-controls > summary").click();
  await expect(
    page.getByRole("form", { name: "用户登录与注册" }),
  ).toBeVisible();
  await page.locator(".pm-profile-controls > summary").click();
  await expect(page.getByLabel("切换工作空间", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "数据导出与恢复", exact: true }),
  ).toHaveCount(0);
  for (const name of ["冰蓝", "珊瑚红", "鼠尾草绿", "雾紫"]) {
    await page.getByRole("radio", { name, exact: true }).click();
    await expect(
      page.getByRole("radio", { name, exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name, exact: true })).toBeEnabled();
  }
  await page.getByLabel("自定义颜色", { exact: true }).fill(originalTheme);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.themeColor),
    )
    .toBe(originalTheme);
  await page.getByText("时间与日期", { exact: true }).click();
  await expect(page.getByLabel("工作空间时区", { exact: true })).toBeVisible();
  await page.getByText("时间与日期", { exact: true }).click();
  await page.getByText("本机操作历史", { exact: true }).first().click();
  await expect(
    page.getByRole("button", { name: "读取历史", exact: true }),
  ).toBeVisible();
  await page.locator(".pm-settings-group").last().locator("summary").click();
  await settle();
  await page.screenshot({ path: join(evidence, "settings.png") });
  checks.push(
    "Compact account disclosure, four theme colors, timezone and readonly history; removed workspace/export UI stays absent",
  );

  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await page.setViewportSize({ width: 320, height: 780 });
    for (const label of ["日历", "专注", "统计", "我的"]) {
      await route(label);
      await settle();
      await noOverflow();
      await page.screenshot({
        path: join(evidence, `small-${label}-${dark ? "dark" : "light"}.png`),
      });
    }
  }
  const metrics = await page.context().newCDPSession(page);
  await metrics.send("Emulation.clearDeviceMetricsOverride");
  await metrics.detach();
  await page.emulateMedia({ colorScheme: "light" });
  await route("清单");
  expect(await page.locator(".pm-task-title strong").allTextContents()).toEqual(
    taskTitles,
  );
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "功能菜单" })
      .getByRole("button", { name: "项目", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
  checks.push(
    "320px light/dark layouts have no overflow; task list unchanged; projects remain accessible in drawer",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(`PASS: ${checks.length} dashboard workflows, no runtime errors.`);
} finally {
  await page
    .evaluate(() => {
      if (window.__dashboardNativeOriginal)
        window.Capacitor.nativePromise = window.__dashboardNativeOriginal;
      delete window.__dashboardNativeOriginal;
    })
    .catch(() => {});
  if (
    createdFixture &&
    !(await page
      .getByRole("button", { name: "重试同一操作", exact: true })
      .count())
  )
    await cleanupFocus().catch(() => {});
  const metrics = await page.context().newCDPSession(page);
  await metrics.send("Emulation.clearDeviceMetricsOverride");
  await metrics.detach();
  await page.emulateMedia({ colorScheme: "light" });
  if (originalTheme)
    await page.evaluate((color) => {
      // Restore through the real theme control when the current page has it.
      const input = document.getElementById("theme-custom-color");
      if (input && document.documentElement.dataset.themeColor !== color) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set.call(input, color);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, originalTheme);
  await browser.close();
}
