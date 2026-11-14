import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

const root = resolve(import.meta.dirname, "..");
const data = await mkdtemp(join(root, ".tools/cultivation-layout-"));
const evidence = join(root, "docs/evidence/cultivation-layout");
await mkdir(evidence, { recursive: true });
const exe = join(data, "Praxis.exe");
await copyFile(
  resolve(
    root,
    process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
  ),
  exe,
);
const server = net.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PRAXIS_DATA_DIR: join(data, "client"),
    WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});
let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null)
      throw Error(`Desktop exited: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 500,
      });
      break;
    } catch {
      await delay(250);
    }
  }
  if (!browser) throw Error("Desktop did not start");
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  await page.getByRole("button", { name: "修炼成长", exact: true }).click();
  await expect(page.locator(".cultivation-refresh")).toBeEnabled();
  for (const [width, height] of [
    [1160, 800],
    [1024, 640],
    [680, 540],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator(".workspace").evaluate((el) => el.scrollTo({ top: 0 }));
    const content = await page.locator(".cultivation-page").boundingBox();
    const sidebar = await page.locator(".sidebar").boundingBox();
    const fixedSidebar = await page
      .locator(".sidebar")
      .evaluate((el) => getComputedStyle(el).position === "fixed");
    if (fixedSidebar) {
      expect(
        content.x,
        `cultivation content is covered by sidebar at ${width}x${height}`,
      ).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1);
    } else {
      expect(
        content.y,
        `cultivation content overlaps navigation at ${width}x${height}`,
      ).toBeGreaterThanOrEqual(sidebar.y + sidebar.height - 1);
    }
    await page.locator("#cultivation-title").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, `heading-${width}-${height}.png`),
    });
    console.log(JSON.stringify({ width, height, content, sidebar }));
    const bottom = page.locator(".cultivation-refresh");
    await bottom.scrollIntoViewIfNeeded();
    const layout = await bottom.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const ancestors = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const css = getComputedStyle(p),
          box = p.getBoundingClientRect();
        ancestors.push({
          class: p.className,
          top: box.top,
          bottom: box.bottom,
          height: p.clientHeight,
          scrollHeight: p.scrollHeight,
          overflowY: css.overflowY,
          display: css.display,
        });
      }
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewport: innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        ancestors,
      };
    });
    console.log(JSON.stringify({ width, height, ...layout }));
    await page.screenshot({
      path: join(evidence, `layout-${width}-${height}.png`),
    });
    expect(
      layout.top,
      `refresh button above viewport at ${width}x${height}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      layout.bottom,
      `bottom of cultivation page is unreachable at ${width}x${height}`,
    ).toBeLessThanOrEqual(height + 1);
    expect(
      layout.pageWidth,
      `horizontal overflow at ${width}x${height}`,
    ).toBeLessThanOrEqual(width);
    await bottom.click({ timeout: 2000 });
    await expect(bottom).toBeEnabled();
    await page.locator("#cultivation-title").scrollIntoViewIfNeeded();
    await expect(page.locator("#cultivation-title")).toBeInViewport();
  }
  console.log(
    "PASS: cultivation page scrolls from heading to refresh at all desktop sizes.",
  );
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
