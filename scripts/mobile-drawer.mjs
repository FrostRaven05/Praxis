import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const evidence = resolve("docs/evidence/mobile-drawer");
await mkdir(evidence, { recursive: true });
const adbPath = join(
  process.env.LOCALAPPDATA,
  "Android/Sdk/platform-tools/adb.exe",
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const metrics = await page.context().newCDPSession(page);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const opener = page.getByRole("button", { name: "打开菜单", exact: true });
const drawer = page.getByRole("dialog", { name: "侧边菜单", exact: true });
const menu = page.getByRole("navigation", { name: "功能菜单", exact: true });
async function open() {
  await opener.click();
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      drawer.evaluate((el) => Math.round(el.getBoundingClientRect().x)),
    )
    .toBe(0);
}
try {
  await page.locator(".pm-app").waitFor();
  if (await drawer.count())
    await menu.getByRole("button", { name: "关闭菜单", exact: true }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "清单", exact: true })
    .click();
  const before = await page.locator(".pm-task-title strong").allTextContents();
  await open();
  expect(await drawer.evaluate((el) => el.matches(":modal"))).toBe(true);
  expect(
    Math.abs(
      (await drawer.evaluate((el) => el.getBoundingClientRect().height)) -
        (await page.evaluate(() => innerHeight)),
    ),
  ).toBeLessThanOrEqual(1);
  await expect(
    menu.getByRole("button", { name: "任务清单", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".pm-drawer-heatmap span")).toHaveCount(84);
  await expect(
    menu.getByRole("button", { name: "关闭菜单", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: join(evidence, "drawer.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await open();
  const bounds = await drawer.boundingBox();
  await page.mouse.click(bounds.width + 30, bounds.height / 2);
  await expect(drawer).toHaveCount(0);
  await open();
  execFileSync(adbPath, [
    "-s",
    "emulator-5554",
    "shell",
    "input",
    "keyevent",
    "4",
  ]);
  await expect(drawer).toHaveCount(0);
  await open();
  await menu.getByLabel("搜索工作空间", { exact: true }).fill("抽屉搜索验证");
  await menu.getByLabel("搜索工作空间", { exact: true }).press("Enter");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("搜索标题或正文", { exact: true })).toHaveValue(
    "抽屉搜索验证",
  );
  await open();
  await menu.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".pm-dialog[open]")).toBeVisible();
  await page
    .locator(".pm-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await open();
  const project = menu.locator(".pm-drawer-project").first();
  if (await project.count()) {
    const projectTitle = await project.locator("span").innerText();
    await project.click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator(".pm-list-heading h2")).toContainText(
      projectTitle,
    );
    await expect(
      page.getByRole("button", { name: "管理分区", exact: true }),
    ).toBeVisible();
    await open();
    await expect(
      menu
        .getByRole("button", { name: `打开项目：${projectTitle}`, exact: true })
        .first(),
    ).toHaveAttribute("aria-current", "page");
    await menu.getByRole("button", { name: "项目", exact: true }).click();
  } else {
    await menu.getByRole("button", { name: "关闭菜单", exact: true }).click();
  }
  for (const [route, heading] of [
    ["日历", "日历"],
    ["收件箱", "收件箱"],
    ["项目", "项目"],
    ["习惯", "习惯"],
    ["数据复盘", "数据复盘"],
    ["我的", "我的"],
    ["任务清单", "任务清单"],
  ]) {
    await open();
    await menu.getByRole("button", { name: route, exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator("h1")).toHaveText(heading);
  }
  expect(await page.locator(".pm-task-title strong").allTextContents()).toEqual(
    before,
  );
  await open();
  await page.setViewportSize({ width: 320, height: 780 });
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await menu
    .getByRole("button", { name: "回收站", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    menu.getByRole("button", { name: "我的", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: join(evidence, "drawer-320.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(drawer).toHaveCSS("background-color", "rgb(47, 47, 47)");
  await expect(
    menu.getByRole("button", { name: "回收站", exact: true }),
  ).toHaveCSS("color", "rgb(236, 236, 236)");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: join(evidence, "drawer-dark.png") });
  await menu.getByRole("button", { name: "关闭菜单", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "Full height modal drawer; focus restored, Escape, backdrop and Android back close it.",
          "Search transfers its query; project creation opens the existing editor without task writes; all navigation remains usable.",
          "Real 12-week completion heatmap, 320px internal scroll, pinned footer, dark colors and no horizontal overflow.",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Native Android drawer, search, navigation, dismissal, compact and dark layouts; tasks unchanged.",
  );
} finally {
  if (await drawer.count())
    await menu.getByRole("button", { name: "关闭菜单", exact: true }).click();
  await metrics.send("Emulation.clearDeviceMetricsOverride");
  await metrics.detach();
  await page.emulateMedia({ colorScheme: "light" });
  await browser.close();
}
