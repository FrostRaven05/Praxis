// Isolated browser UI test doubles. Actual SQLite/Store checks remain separate.
import { chromium, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const clientRequire = createRequire(resolve("apps/client/package.json"));
const { createServer } = await import(
  pathToFileURL(clientRequire.resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(clientRequire.resolve("@vitejs/plugin-react")).href
);
const scenario = process.env.PRAXIS_UI_SCENARIO;
const evidence = resolve(process.env.PRAXIS_UI_EVIDENCE ?? "docs/evidence/p1-01-2026-11-11");
await mkdir(evidence, { recursive: true });
const capId = "\0personal-todo-capacitor",
  nativeId = "\0personal-todo-native",
  entryId = "\0personal-todo-entry.tsx";
const fixtureUrl =
  "/@fs/" +
  resolve("scripts/fixtures/personal-todo-browser.mjs").replaceAll("\\", "/");
const stylePaths = [
  "theme",
  "styles",
  "compact",
  "components",
  "interface",
  "reference",
  "todoist",
  "date-picker",
  "project-workspace",
  "project-board",
  "project-gantt",
  "content",
  "modern",
  "polish",
  "redesign",
];
const server = await createServer({
  configFile: false,
  root: resolve("apps/client"),
  cacheDir: resolve(".scratch/p1-01-vite-cache"),
  plugins: [
    {
      name: "personal-todo-browser-doubles",
      enforce: "pre",
      configureServer(devServer) {
        devServer.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__personal-todo")) return next();
          const html = await devServer.transformIndexHtml(
            req.url,
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>个人待办隔离验证</title><div id="root"></div><script type="module" src="/@id/virtual:personal-todo-entry.tsx"></script></html>',
          );
          res.setHeader("content-type", "text/html");
          res.end(html);
        });
      },
      resolveId(source) {
        if (source === "@capacitor/core") return capId;
        if (
          source
            .replaceAll("\\", "/")
            .includes("packages/storage-mobile/src/native")
        )
          return nativeId;
        if (source === "virtual:personal-todo-entry.tsx") return entryId;
      },
      load(id) {
        if (id === capId)
          return `export const Capacitor={isNativePlatform:()=>window.__todoFixture?.mode==='mobile',getPlatform:()=>window.__todoFixture?.mode==='mobile'?'android':'web'};export const registerPlugin=()=>new Proxy({},{get:(_,key)=>key==='then'?undefined:async(...args)=>key==='aiRequest'?window.__todoFixture.aiRequest(...args):key==='accountStatus'?window.__todoFixture.account():key==='status'?{configured:false,databaseName:'praxis',baseUrl:''}:key==='addListener'?{remove:async()=>{}}:undefined});`;
        if (id === nativeId)
          return `export const mobileStorage=new Proxy({},{get:(_,key)=>(...args)=>window.__todoFixture.mobileStorage[key](...args)});export const mobileDatabaseName=async()=>'praxis';`;
        if (id === entryId)
          return `${stylePaths.map((p) => `import '/src/${p}.css';`).join("\n")}
      import React from 'react';import {createRoot} from 'react-dom/client';import {installFixture} from ${JSON.stringify(fixtureUrl)};
      const mode=new URLSearchParams(location.search).get('mode')||'desktop';installFixture(mode);
      const component=mode==='mobile'?(await import('/src/mobile/MobileApp.tsx')).MobileApp:(await import('/src/App.tsx')).App;
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(component)));`;
      },
    },
    react(),
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  logLevel: "error",
});
const checks = [],
  errors = [];
let browser, activePage;
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const channel =
    process.env.PRAXIS_TEST_BROWSER_CHANNEL ||
    (process.platform === "win32" ? "msedge" : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(channel ? { channel } : {}),
  });
  for (const mode of ["desktop", "mobile"]) {
    const context = await browser.newContext({
      viewport:
        mode === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    activePage = page;
    page.on("pageerror", (e) => errors.push(`${mode}: ${e.message}`));
    page.setDefaultTimeout(10000);
    if (scenario === "inline" || scenario === "remaining") await page.clock.install({ time: new Date() });
    await page.goto(`${base}__personal-todo?mode=${mode}`);
    if (scenario === "projects") {
      const { runProjectScenario } = await import("./fixtures/personal-project-scenario.mjs");
      await runProjectScenario(page, mode, evidence, checks);
      await context.close();
      continue;
    }
    if (scenario === "inline") {
      const { runInlineScenario } = await import("./fixtures/personal-inline-scenario.mjs");
      await runInlineScenario(page, mode, evidence, checks);
      await context.close();
      continue;
    }
    if (scenario === "remaining") {
      const { runRemainingScenario } = await import("./fixtures/remaining-mvp-scenario.mjs");
      await runRemainingScenario(page, mode, evidence, checks);
      await context.close();
      continue;
    }
    const home = page.getByRole("region", { name: "个人待办", exact: true });
    await expect(home).toBeVisible();
    await expect(home.locator('[data-group="undated"]')).toBeVisible();
    for (const [key, count] of [
      ["overdue", 2],
      ["today", 1],
      ["later", 1],
      ["undated", 4],
    ])
      await expect(
        home.locator(`[data-group="${key}"] .personal-todo-row`),
      ).toHaveCount(count);
    await expect(
      home.getByRole("button", { name: "已取消不进入待办", exact: true }),
    ).toHaveCount(0);
    await expect(
      home.getByRole("button", { name: "已删除不进入待办", exact: true }),
    ).toHaveCount(0);
    await expect(
      home.getByRole("button", { name: "历史完成日期未知", exact: true }),
    ).toBeHidden();
    await expect(
      home.getByRole("button", { name: "未安排到今日的项目任务", exact: true }),
    ).toBeVisible();
    await expect(home).toContainText("America/Los_Angeles");
    await expect(home).toContainText("等待");
    await expect(home).toContainText("阻塞");
    checks.push(
      `${mode}: default homepage includes both projects, independent/unplanned tasks, all four deadline groups; deleted/cancelled excluded; completed collapsed; old states/instant zone retained`,
    );
    await page.screenshot({
      path: join(evidence, `${mode}-home.png`),
      fullPage: true,
    });
    if (mode === "mobile")
      await expect(
        page.getByText("账户与登录设置", { exact: true }),
      ).toHaveCount(0);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({
      path: join(evidence, `${mode}-home-dark.png`),
      fullPage: true,
    });
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    await writeFile(
      join(evidence, `${mode}-layout.json`),
      JSON.stringify(
        await home.evaluate((el) => {
          const button = el.querySelector(".personal-todo-title"),
            check = el.querySelector(".personal-todo-check");
          const s = getComputedStyle(button),
            c = getComputedStyle(check);
          const rules = Array.from(document.styleSheets)
            .flatMap((sheet) => {
              try {
                return Array.from(sheet.cssRules);
              } catch {
                return [];
              }
            })
            .filter((r) => r.selectorText && button.matches(r.selectorText))
            .map((r) => r.cssText);
          return {
            title: {
              border: s.borderWidth,
              padding: s.padding,
              background: s.backgroundColor,
            },
            check: { width: c.width, height: c.height, border: c.borderWidth },
            width: document.documentElement.scrollWidth,
            viewport: innerWidth,
            rules,
          };
        }),
        null,
        2,
      ),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const before = await page.evaluate(() =>
      window.__todoFixture.current().tasks.map((t) => t.id),
    );
    await home
      .getByRole("button", { name: "完成：没有日期的独立任务", exact: true })
      .click();
    await expect(
      home.getByRole("button", { name: "没有日期的独立任务", exact: true }),
    ).toBeHidden();
    await home.locator(".personal-todo-completed summary").filter({hasText:/^已完成/}).click();
    await home
      .getByRole("button", {
        name: "重新打开：没有日期的独立任务",
        exact: true,
      })
      .click();
    await expect(
      home.getByRole("button", { name: "没有日期的独立任务", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.__todoFixture.current().tasks.map((t) => t.id),
      ),
    ).toEqual(before);
    expect(
      await page.evaluate(
        () =>
          window.__todoFixture
            .current()
            .tasks.find((t) => t.title === "历史完成日期未知").completedAt,
      ),
    ).toBeNull();
    checks.push(
      `${mode}: complete/reopen keeps identities and historical unknown completion dates`,
    );
    await page.evaluate(() => (window.__todoFixture.writeFault = "unknown"));
    await home
      .getByRole("button", { name: "完成：之后的独立任务", exact: true })
      .click();
    await expect(
      home.getByRole("button", { name: "重试原操作", exact: true }),
    ).toBeVisible();
    await expect(
      home.getByRole("button", { name: "刷新待办", exact: true }),
    ).toBeDisabled();
    const applies = await page.evaluate(() => window.__todoFixture.applies);
    await home.getByRole("button", { name: "重试原操作", exact: true }).click();
    await expect(home.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => window.__todoFixture.applies)).toBe(
      applies,
    );
    const replay = await page.evaluate(() =>
      window.__todoFixture.commands.slice(-2),
    );
    expect(replay[0]).toEqual(replay[1]);
    checks.push(
      `${mode}: unknown result retries the exact command once; refresh blocked until acknowledged`,
    );
    await page.evaluate(() =>
      window.__todoFixture.editVersion("项目乙今日截止"),
    );
    await home
      .getByRole("button", { name: "完成：项目乙今日截止", exact: true })
      .click();
    await expect(home.getByRole("alert")).toBeVisible();
    await expect(
      home.getByRole("button", { name: "重试原操作", exact: true }),
    ).toHaveCount(0);
    await home.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(home.getByRole("alert")).toHaveCount(0);
    checks.push(
      `${mode}: definite stale-version rejection offers reload instead of an unknown-result retry`,
    );
    await page.evaluate(
      () => (window.__todoFixture.readAfterWriteFault = true),
    );
    await home
      .getByRole("button", { name: "完成：项目甲逾期任务", exact: true })
      .click();
    await expect(home.getByRole("alert")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          window.__todoFixture
            .current()
            .tasks.find((t) => t.title === "项目甲逾期任务").status,
      ),
    ).toBe("completed");
    await page.evaluate(() => (window.__todoFixture.readFault = false));
    await home.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(home.getByRole("alert")).toHaveCount(0);
    checks.push(
      `${mode}: committed write plus failed refresh keeps a read-recovery path without resubmitting`,
    );
    if (mode === "desktop") {
      await home
        .getByRole("button", { name: "未安排到今日的项目任务", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "任务属性",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("button", { name: "关闭任务编辑", exact: true })
        .click();
      await home
        .locator(".personal-todo-row", { hasText: "未安排到今日的项目任务" })
        .getByRole("button", { name: "个人项目甲", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "个人项目甲", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "我的待办", exact: true })
        .click();
      await page.locator(".personal-compat-navigation > summary").click();
      await page
        .getByRole("navigation", { name: "兼容功能", exact: true })
        .getByRole("link", { name: "今日与近期", exact: true })
        .click();
      await expect(home).toHaveCount(0);
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "我的待办", exact: true })
        .click();
    } else {
      await home
        .getByRole("button", { name: "未安排到今日的项目任务", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await home
        .locator(".personal-todo-row", { hasText: "未安排到今日的项目任务" })
        .getByRole("button", { name: "个人项目甲", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "个人项目甲", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "待办", exact: true })
        .click();
      await page.getByRole("button", { name: "打开菜单", exact: true }).click();
      await page.getByRole("button", { name: "任务清单", exact: true }).click();
      await expect(home).toHaveCount(0);
      await expect(page.locator(".pm-week")).toBeVisible();
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "待办", exact: true })
        .click();
    }
    await expect(home).toBeVisible();
    checks.push(
      `${mode}: task and project context open; previous daily view remains reachable and returns home`,
    );
    await page.evaluate(() => window.__todoFixture.switchOwner("account-b"));
    await expect(
      home.getByRole("button", { name: "另一个账号的个人任务", exact: true }),
    ).toBeVisible();
    await expect(
      home.getByRole("button", { name: "未安排到今日的项目任务", exact: true }),
    ).toHaveCount(0);
    await home
      .getByRole("button", { name: "完成：另一个账号的个人任务", exact: true })
      .click();
    await expect(
      home.getByText("暂时没有未完成任务", { exact: true }),
    ).toBeVisible();
    await expect(home.locator(".personal-todo-group")).toHaveCount(0);
    checks.push(
      `${mode}: refresh replaces account scope even for colliding IDs; empty groups hidden and all-complete state shown (browser fixture scope only)`,
    );
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "ui-results.json"),
    JSON.stringify(
      {
        date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }),
        executedAt: new Date().toISOString(),
        passed: true,
        environment:
          "headless Chromium; real App/MobileApp and personal modules; synthetic native/Capacitor test doubles, not device acceptance",
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({ passed: true, checks: checks.length, errors }, null, 2) +
      "\n",
  );
} catch (error) {
  if (activePage) {
    await activePage
      .screenshot({ path: join(evidence, "ui-failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(evidence, "ui-failure-body.txt"),
      await activePage
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await writeFile(
      join(evidence, "ui-debug.json"),
      JSON.stringify(
        await activePage
          .evaluate(() => ({
            href: location.href,
            mode: window.__todoFixture?.mode,
            tauri: window.isTauri,
            internals: !!window.__TAURI_INTERNALS__,
            tasks: window.__todoFixture?.current().tasks.length,
          }))
          .catch(() => ({})),
        null,
        2,
      ),
    );
  }
  await writeFile(
    join(evidence, "ui-failure.json"),
    JSON.stringify(
      { passed: false, error: String(error), checks, errors },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
