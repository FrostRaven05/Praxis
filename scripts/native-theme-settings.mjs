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
const evidence = join(root, "docs/evidence/theme-settings");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/theme-settings-qa-"));
let browser, child, page;
let launchCount = 0;
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
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview-" + ++launchCount),
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

const neutral = () =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        "--surface",
        "--surface-secondary",
        "--surface-tertiary",
        "--surface-canvas",
        "--sidebar-surface",
        "--text-primary",
        "--text-secondary",
      ].map((key) => [key, style.getPropertyValue(key).trim().toUpperCase()]),
    );
  });
const expectedLight = {
  "--surface": "#FFFFFF",
  "--surface-secondary": "#F9F9F9",
  "--surface-tertiary": "#F0F0F0",
  "--surface-canvas": "#F6F7F9",
  "--sidebar-surface": "#FBFBFC",
  "--text-primary": "#0D0D0D",
  "--text-secondary": "#6E6E80",
};
const current = () =>
  page.evaluate(() => document.documentElement.dataset.themeColor);
const choose = async (name, color) => {
  await page.getByRole("radio", { name, exact: true }).click();
  await expect.poll(current).toBe(color);
  await expect(page.getByRole("radio", { name, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect((await ipc("read_theme_color")).color).toBe(color);
  expect(await neutral()).toEqual(expectedLight);
};
try {
  await start();
  expect(await current()).toBe("#BDE7EE");
  expect(await neutral()).toEqual(expectedLight);
  await expect(page.locator(".brand-mark")).toHaveCSS(
    "background-color",
    "rgb(189, 231, 238)",
  );
  await ipc("save_project", {
    command: command({
      projectId: uuid(),
      expectedVersion: null,
      name: "Lorem project",
      outcome: "Lorem ipsum",
      targetDate: null,
      priority: 0,
    }),
  });
  await page.reload();
  await expect(page.locator(".sidebar-project-icon")).toHaveCount(1);
  await page
    .getByLabel("任务标题", { exact: true })
    .fill("Lorem unchanged task");
  await page.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(page.locator(".task-item")).toHaveCount(1);
  const tasks = (await ipc("productivity_snapshot")).tasks;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "主题颜色", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("radiogroup", { name: "主题颜色", exact: true })
      .getByRole("radio"),
  ).toHaveCount(4);
  await expect(
    page.getByRole("radio", { name: "冰蓝", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  for (const [name, color, foreground, file] of [
    ["冰蓝", "#BDE7EE", "rgb(40, 127, 145)", "ice-blue"],
    ["珊瑚红", "#D1453B", "rgb(209, 69, 59)", "coral"],
    ["鼠尾草绿", "#ADD8C6", "rgb(57, 123, 97)", "sage"],
    ["雾紫", "#C8BDE8", "rgb(123, 96, 174)", "purple"],
  ]) {
    await choose(name, color);
    await page.getByRole("link", { name: "今日与近期", exact: true }).click();
    await expect(
      page.locator('.timeline-switcher button[aria-pressed="true"]'),
    ).toHaveCSS("color", foreground);
    await expect(page.locator(".reference-day .capture-circle")).toHaveCSS(
      "border-top-color",
      foreground,
    );
    await expect(page.locator(".sidebar-project-icon")).toHaveCSS(
      "color",
      foreground,
    );
    await expect(page.locator(".sidebar .nav-item.active")).toHaveCSS(
      "color",
      foreground,
    );
    expect(await neutral()).toEqual(expectedLight);
    expect((await ipc("productivity_snapshot")).tasks).toEqual(tasks);
    await page.screenshot({
      path: join(evidence, `${file}-accents.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
  }
  checks.push(
    "Every preset shares one stronger accent across the Today tab, capture outline, project icons and selected navigation while retaining neutral surfaces and pastel fills.",
  );
  await page.getByLabel("自定义颜色", { exact: true }).evaluate((input) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, "#123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(current).toBe("#123456");
  await expect(page.locator(".theme-color-value")).toHaveText("#123456");
  expect((await ipc("read_theme_color")).color).toBe("#123456");
  expect(await neutral()).toEqual(expectedLight);
  const bad = await ipc("save_theme_color", { color: "#12345;" }).then(
    () => null,
    (e) => String(e),
  );
  expect(bad).not.toBeNull();
  expect((await ipc("read_theme_color")).color).toBe("#123456");
  await page.screenshot({
    path: join(evidence, "theme-settings.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "今日与近期", exact: true }).click();
  await expect(page.locator(".task-row")).toContainText("Lorem unchanged task");
  expect((await ipc("productivity_snapshot")).tasks).toEqual(tasks);
  expect(await neutral()).toEqual(expectedLight);
  await page.screenshot({
    path: join(evidence, "accent-only.png"),
    fullPage: true,
  });
  await page.reload();
  await expect.poll(current).toBe("#123456");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".theme-color-value")).toHaveText("#123456");
  checks.push(
    "Default ice blue and all presets change only accent colors; custom colors save immediately and leave tasks, backgrounds and normal text unchanged.",
  );
  await browser.close();
  browser = null;
  child.kill();
  await delay(500);
  await start();
  expect(await current()).toBe("#123456");
  expect(await neutral()).toEqual(expectedLight);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".theme-color-value")).toHaveText("#123456");
  await page.getByRole("button", { name: "恢复冰蓝", exact: true }).click();
  await expect.poll(current).toBe("#BDE7EE");
  await expect(
    page.getByRole("radio", { name: "冰蓝", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("button", { name: "恢复冰蓝", exact: true }),
  ).toBeDisabled();
  checks.push(
    "The preference survives a native restart with a new WebView cache; invalid values cannot overwrite it, and reset restores #BDE7EE.",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".theme-settings")).toHaveCSS(
    "background-color",
    "rgb(47, 47, 47)",
  );
  const dark = await neutral();
  expect(dark["--surface"]).toBe("#212121");
  expect(dark["--sidebar-surface"]).toBe("#171717");
  expect(dark["--text-primary"]).toBe("#ECECEC");
  await expect(
    page.getByRole("radio", { name: "珊瑚红", exact: true }),
  ).toHaveCSS("background-color", "rgb(47, 47, 47)");
  await expect(
    page.getByRole("radio", { name: "冰蓝", exact: true }),
  ).toHaveCSS("color", "rgb(236, 236, 236)");
  await page.screenshot({
    path: join(evidence, "theme-dark.png"),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "light" });
  await choose("冰蓝", "#BDE7EE");
  await page.screenshot({
    path: join(evidence, "theme-default.png"),
    fullPage: true,
  });
  checks.push(
    "Dark mode retains its original neutral surfaces and readable accent foregrounds.",
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
