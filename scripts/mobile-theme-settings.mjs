import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const evidence = resolve("docs/evidence/mobile-theme");
await mkdir(evidence, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const current = () =>
  page.evaluate(() => document.documentElement.dataset.themeColor);
const navigate = async (name) => {
  if (name === "项目") {
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await page
      .getByRole("navigation", { name: "功能菜单" })
      .getByRole("button", { name, exact: true })
      .click();
  } else
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
};
const titles = async () => {
  await navigate("清单");
  return page.locator(".pm-task-title strong").allTextContents();
};
async function choose(name, color) {
  await navigate("我的");
  await page.getByRole("radio", { name, exact: true }).click();
  await expect.poll(current).toBe(color);
  await expect(page.getByRole("radio", { name, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("praxis.theme.color")),
  ).toBe(color);
}
try {
  await page.locator(".pm-app").waitFor();
  if (process.argv.includes("--after-restart")) {
    const before = JSON.parse(
      await readFile(join(evidence, "before-restart.json"), "utf8"),
    );
    await expect.poll(current).toBe("#C8BDE8");
    expect(await titles()).toEqual(before.titles);
    await choose("冰蓝", "#BDE7EE");
    await page.locator(".theme-settings").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "settings.png") });
    expect(errors).toEqual([]);
    await writeFile(
      join(evidence, "verification.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "All four presets and custom colors update mobile navigation, task outlines, project icons and settings without task changes.",
            "Neutral backgrounds, readable dark mode and 320px layout verified.",
            "The selected theme survives a native Android restart; restored ice blue afterwards.",
          ],
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: Native Android restart preserves theme, existing tasks unchanged; restored ice blue.",
    );
  } else {
    const before = await titles();
    await navigate("我的");
    await expect(
      page.getByRole("radiogroup", { name: "主题颜色", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(4);
    await expect(
      page.getByRole("radio", { name: "原始红色", exact: true }),
    ).toHaveCount(0);
    for (const [name, color, foreground, fill] of [
      ["冰蓝", "#BDE7EE", "rgb(40, 127, 145)", "rgb(189, 231, 238)"],
      ["珊瑚红", "#D1453B", "rgb(209, 69, 59)", "rgb(209, 69, 59)"],
      ["鼠尾草绿", "#ADD8C6", "rgb(57, 123, 97)", "rgb(173, 216, 198)"],
      ["雾紫", "#C8BDE8", "rgb(123, 96, 174)", "rgb(200, 189, 232)"],
    ]) {
      await choose(name, color);
      await expect(page.locator(".theme-choice-check")).toHaveCSS(
        "color",
        foreground,
      );
      await expect(page.locator(".theme-settings")).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
      expect(await titles()).toEqual(before);
      await expect(page.locator(".pm-bottom .active")).toHaveCSS(
        "color",
        foreground,
      );
      await expect(page.locator(".pm-fab")).toHaveCSS("background-color", fill);
      expect(
        await page
          .locator(".pm-check")
          .first()
          .evaluate((el) => getComputedStyle(el, "::before").borderTopColor),
      ).toBe(foreground);
      if (name === "冰蓝")
        await page.screenshot({ path: join(evidence, "tasks.png") });
      await navigate("项目");
      await expect(page.locator(".pm-project-symbol").first()).toHaveCSS(
        "color",
        foreground,
      );
    }
    await navigate("我的");
    await page.getByLabel("自定义颜色", { exact: true }).evaluate((input) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, "#123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect.poll(current).toBe("#123456");
    await page.reload();
    await expect.poll(current).toBe("#123456");
    await choose("冰蓝", "#BDE7EE");
    const metrics = await page.context().newCDPSession(page);
    try {
      await page.setViewportSize({ width: 320, height: 780 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator(".theme-custom-color input")).toHaveCSS(
        "width",
        "42px",
      );
      await page.screenshot({ path: join(evidence, "settings-320.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator(".theme-settings")).toHaveCSS(
        "background-color",
        await page
          .locator(".pm-profile")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      await expect(
        page.getByRole("radio", { name: "冰蓝", exact: true }),
      ).toHaveCSS("color", "rgb(236, 236, 236)");
      await page.screenshot({ path: join(evidence, "settings-dark.png") });
    } finally {
      await metrics.send("Emulation.clearDeviceMetricsOverride");
      await metrics.detach();
      await page.emulateMedia({ colorScheme: "light" });
    }
    await choose("雾紫", "#C8BDE8");
    expect(errors).toEqual([]);
    await writeFile(
      join(evidence, "before-restart.json"),
      JSON.stringify({ titles: before }),
    );
    console.log(
      "PASS: Four themes, custom persistence, unchanged tasks, dark mode, and 320px mobile layout.",
    );
  }
} finally {
  await browser.close();
}
