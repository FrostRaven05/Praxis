// Run against paired, running native Apps. Never writes directly to the API.
// Desktop: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// Android: adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const evidence = new URL("../docs/evidence/lan-dual-sync/", import.meta.url);
const mobileEndpoint = process.env.PRAXIS_MOBILE_CDP ?? "http://127.0.0.1:9223";
const desktopEndpoint =
  process.env.PRAXIS_DESKTOP_CDP ?? "http://127.0.0.1:9222";
const adbPath =
  process.env.PRAXIS_ADB ??
  join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
const adb = (...args) =>
  execFileSync(
    adbPath,
    ["-s", process.env.PRAXIS_ANDROID_SERIAL ?? "emulator-5554", ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
const stamp = `【双端同步验收 ${Date.now()}】`;
const checks = [];
const errors = [];
await mkdir(evidence, { recursive: true });
let desktopBrowser, mobileBrowser, desktop, mobile;
let wifi, data;
async function connect(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => !p.url().startsWith("devtools:"));
  if (!page) throw new Error(`No App WebView at ${endpoint}`);
  page.on("pageerror", (error) => errors.push(error.message));
  // The script does not approve destructive or unrelated dialogs.
  page.on("dialog", (dialog) => dialog.dismiss());
  return { browser, page };
}
async function mobileInbox() {
  if (
    await mobile
      .getByRole("button", { name: "打开收件箱", exact: true })
      .isVisible()
  ) {
    await mobile
      .getByRole("button", { name: "打开收件箱", exact: true })
      .click();
  }
  await expect(mobile.getByLabel("记下原文", { exact: true })).toBeVisible();
}
const mobileItem = (text) =>
  mobile.locator(".pm-capture").filter({ hasText: text });
const desktopItem = (text) =>
  desktop.locator("article.content-card").filter({ hasText: text });
async function editMobile(before, after) {
  await mobileItem(before)
    .getByRole("button", { name: "编辑原文", exact: true })
    .click();
  await mobile.getByLabel("编辑原文", { exact: true }).fill(after);
  await mobile
    .getByRole("button", { name: "保存原文编辑", exact: true })
    .click();
  await expect(mobile.getByLabel("记下原文", { exact: true })).toHaveValue("");
}
async function restartAndroid() {
  await mobileBrowser.close();
  adb("shell", "am", "force-stop", "com.praxis.mobile");
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(500);
    try {
      const pid = adb("shell", "pidof", "com.praxis.mobile");
      adb(
        "forward",
        `tcp:${new URL(mobileEndpoint).port}`,
        `localabstract:webview_devtools_remote_${pid}`,
      );
      ({ browser: mobileBrowser, page: mobile } =
        await connect(mobileEndpoint));
      await mobileInbox();
      return;
    } catch (error) {
      await mobileBrowser?.close().catch(() => undefined);
      if (attempt === 39) throw error;
    }
  }
}
try {
  ({ browser: desktopBrowser, page: desktop } = await connect(desktopEndpoint));
  ({ browser: mobileBrowser, page: mobile } = await connect(mobileEndpoint));
  await desktop.getByRole("button", { name: "随手记", exact: false }).click();
  await mobileInbox();
  const original = `${stamp} 桌面创建\n中文、多行、自动同步`;
  await desktop.getByLabel("原始文字", { exact: true }).fill(original);
  await desktop
    .getByRole("button", { name: "保存到本机", exact: true })
    .click();
  await expect(desktop.getByLabel("原始文字", { exact: true })).toHaveValue("");
  await expect(mobileItem(original)).toHaveCount(1, { timeout: 60000 });
  checks.push("Desktop UI creation automatically appears once in Android UI");
  const edited = `${stamp} 手机编辑\n原文换行仍保留`;
  await editMobile(original, edited);
  await expect(desktopItem(edited)).toHaveCount(1, { timeout: 60000 });
  await expect(desktopItem(original)).toHaveCount(0);
  checks.push("Android UI edit automatically updates the same desktop capture");

  if (process.env.PRAXIS_TEST_OFFLINE === "1") {
    wifi = adb("shell", "settings", "get", "global", "wifi_on");
    data = adb("shell", "settings", "get", "global", "mobile_data");
    adb("shell", "svc", "wifi", "disable");
    adb("shell", "svc", "data", "disable");
    const offline = `${stamp} 手机断网重启后待上传`;
    await editMobile(edited, offline);
    await delay(4000);
    await expect(desktopItem(offline)).toHaveCount(0);
    await restartAndroid();
    await expect(mobileItem(offline)).toHaveCount(1);
    await expect(desktopItem(offline)).toHaveCount(0);
    if (wifi === "1") adb("shell", "svc", "wifi", "enable");
    if (data === "1") adb("shell", "svc", "data", "enable");
    await expect(desktopItem(offline)).toHaveCount(1, { timeout: 60000 });
    checks.push(
      "Offline Android edit survives process restart and automatically uploads after network recovery",
    );
    if (process.env.PRAXIS_TEST_CONFLICT === "1") {
      adb("shell", "svc", "wifi", "disable");
      adb("shell", "svc", "data", "disable");
      const local = `${stamp} 冲突手机保留值`;
      const remote = `${stamp} 冲突桌面保留值`;
      await editMobile(offline, local);
      await desktopItem(offline)
        .getByRole("button", { name: "编辑原文", exact: true })
        .click();
      await desktop.getByLabel("编辑收集项原文", { exact: true }).fill(remote);
      await desktop
        .getByRole("button", { name: "保存原文", exact: true })
        .click();
      await expect(desktopItem(remote)).toHaveCount(1);
      await delay(6500);
      await expect(desktop.getByTestId("lan-sync-status")).toContainText(
        "待上传 0",
        { timeout: 60000 },
      );
      if (wifi === "1") adb("shell", "svc", "wifi", "enable");
      if (data === "1") adb("shell", "svc", "data", "enable");
      await expect(mobile.getByTestId("lan-sync-status")).toContainText(
        /[1-9][0-9]* 项原文冲突/,
        { timeout: 60000 },
      );
      await mobile.getByTestId("lan-sync-status").click();
      await expect(
        mobile.locator("pre").filter({ hasText: local }).first(),
      ).toBeVisible();
      await expect(
        mobile.locator("pre").filter({ hasText: remote }).first(),
      ).toBeVisible();
      await expect(desktopItem(remote)).toHaveCount(1);
      await delay(6500);
      checks.push(
        "Concurrent native UI edits retain both values in Android conflict review; no automatic overwrite",
      );
    }
  }
  await desktop.screenshot({
    path: fileURLToPath(new URL("desktop.png", evidence)),
    fullPage: true,
  });
  await mobile.screenshot({
    path: fileURLToPath(new URL("android.png", evidence)),
    fullPage: true,
  });
  if (errors.length) throw new Error(`App errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ stamp, checks }, null, 2));
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (wifi === "1") adb("shell", "svc", "wifi", "enable");
  if (data === "1") adb("shell", "svc", "data", "enable");
  await writeFile(
    new URL("result.json", evidence),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        stamp,
        checks,
        errors,
        scope:
          "Native UI capture sync; no direct backend mutations; only listed checks executed; server restart requires separate acceptance",
      },
      null,
      2,
    ),
  );
  await desktopBrowser?.close();
  await mobileBrowser?.close();
}
// Reconnected Android CDP sockets may outlive a killed WebView; this is a CLI run.
process.exit(0);
