import { chromium, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const shell = process.env.PRAXIS_PWSH || "pwsh";
const ps = (file) =>
  execFileSync(shell, ["-NoProfile", "-File", resolve(root, file)], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
const start = () =>
  execFileSync(
    shell,
    [
      "-NoProfile",
      "-File",
      resolve(root, "scripts/start-lan.ps1"),
      "-LanAddress",
      "192.168.5.56",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
let db = await chromium.connectOverCDP("http://127.0.0.1:9222");
const mb = await chromium.connectOverCDP("http://127.0.0.1:9223");
let desktop = db.contexts()[0].pages()[0];
const mobile = mb.contexts()[0].pages()[0];
desktop.setDefaultTimeout(15000);
mobile.setDefaultTimeout(15000);
const checks = [];
let stopped = false;
try {
  await desktop.getByRole("button", { name: "随手记", exact: false }).click();
  await mobile.getByRole("button", { name: "打开收件箱", exact: true }).click();
  await mobile.getByRole("button", { name: "整理收件箱原文", exact: false }).click();
  const previous = JSON.parse(
    await readFile(
      resolve(root, "docs/evidence/lan-dual-sync/result.json"),
      "utf8",
    ),
  );
  const local = previous.stamp + " 冲突手机保留值",
    remote = previous.stamp + " 冲突桌面保留值";
  await mobile.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
  const conflict = mobile
    .locator(".pm-lan-sync > div > div")
    .filter({ has: mobile.getByText(local, { exact: true }) });
  if (!(await conflict.isVisible()))
    await mobile.getByTestId("lan-sync-status").click();
  await expect(conflict).toHaveCount(1);
  mobile.once("dialog", (dialog) => dialog.accept());
  await conflict
    .getByRole("button", { name: "保留本机为新收集项", exact: true })
    .click();
  await expect(
    desktop.locator("article.content-card").filter({ hasText: local }),
  ).toHaveCount(1, { timeout: 60000 });
  await expect(
    desktop.locator("article.content-card").filter({ hasText: remote }),
  ).toHaveCount(1);
  checks.push(
    "Conflict keep-copy choice preserves both texts and automatically synchronizes the new capture",
  );
  ps("scripts/stop-lan.ps1");
  stopped = true;
  const text = `【服务恢复验收 ${Date.now()}】后端停机期间桌面保存`;
  await desktop.getByLabel("原始文字", { exact: true }).fill(text);
  await desktop
    .getByRole("button", { name: "保存到本机", exact: true })
    .click();
  await expect(
    desktop.locator("article.content-card").filter({ hasText: text }),
  ).toHaveCount(1);
  await expect(desktop.getByTestId("lan-sync-status")).toContainText("离线", {
    timeout: 30000,
  });
  await expect(
    mobile.locator(".pm-capture").filter({ hasText: text }),
  ).toHaveCount(0);
  await db.close();
  execFileSync(
    shell,
    [
      "-NoProfile",
      "-Command",
      "$qaId=[int](Get-Content .tools/lan-desktop-qa/process-id.txt); $p=Get-Process -Id $qaId; if($p.Path -ne (Join-Path (Get-Location) '.tools/lan-desktop-bin/Praxis.exe')){throw 'Unexpected desktop process'}; Stop-Process -Id $qaId",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  const desktopProcess = spawn(
    resolve(root, ".tools/lan-desktop-bin/Praxis.exe"),
    [],
    {
      cwd: root,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PRAXIS_DATA_DIR: resolve(root, ".tools/lan-desktop-qa"),
        WEBVIEW2_USER_DATA_FOLDER: resolve(
          root,
          ".tools/lan-desktop-qa/webview",
        ),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
          "--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1",
      },
    },
  );
  desktopProcess.unref();
  await writeFile(
    resolve(root, ".tools/lan-desktop-qa/process-id.txt"),
    String(desktopProcess.pid),
  );
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(500);
    try {
      db = await chromium.connectOverCDP("http://127.0.0.1:9222");
      break;
    } catch (error) {
      if (attempt === 29) throw error;
    }
  }
  desktop = db.contexts()[0].pages()[0];
  await desktop.getByRole("button", { name: "随手记", exact: false }).click();
  await expect(
    desktop.locator("article.content-card").filter({ hasText: text }),
  ).toHaveCount(1);
  start();
  stopped = false;
  await expect(
    mobile.locator(".pm-capture").filter({ hasText: text }),
  ).toHaveCount(1, { timeout: 60000 });
  await expect(desktop.getByTestId("lan-sync-status")).toContainText("已连接", {
    timeout: 30000,
  });
  checks.push(
    "Desktop saves and restarts while backend is stopped; server restart automatically drains durable queue and Android receives once",
  );
  await writeFile(
    resolve(root, "docs/evidence/lan-dual-sync/recovery.json"),
    JSON.stringify({ testedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  if (stopped) start();
  await db.close();
  await mb.close();
}
process.exit(0);
