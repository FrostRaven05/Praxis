// Isolated component evidence only; this is not native app/device acceptance.
import { chromium, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const requireClient = createRequire(resolve("apps/client/package.json"));
const { createServer } = await import(
  pathToFileURL(requireClient.resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(requireClient.resolve("@vitejs/plugin-react")).href
);
const evidence = resolve("docs/evidence/p2-2026-11-12");
await mkdir(evidence, { recursive: true });
const entry = "\0personal-growth-entry";
const server = await createServer({
  configFile: false,
  root: resolve("apps/client"),
  cacheDir: resolve(".scratch/p2-growth-vite-cache"),
  plugins: [
    {
      name: "growth-component-only",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__personal-growth")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@id/virtual:personal-growth-entry"></script></html>',
            ),
          );
        });
      },
      resolveId(id) {
        if (id === "virtual:personal-growth-entry") return entry;
      },
      load(id) {
        if (id !== entry) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {PersonalGrowthStrip} from '/src/PersonalGrowthStrip.tsx';import '/src/theme.css';import '/src/styles.css';import '/src/personal-todo.css';
    const now=new Date();const initial=Array.from({length:10},(_,i)=>({id:'task-'+i,status:i===9?'todo':'completed',completedAt:i===0?null:now.toISOString()}));let update;
    window.__growthFixture={scope:'account-a/local',tasks:initial,update:(fn)=>update(fn)};
    function Host(){const[f,set]=React.useState({scope:window.__growthFixture.scope,tasks:initial});update=fn=>set(old=>fn(structuredClone(old)));return React.createElement('main',{className:'personal-todo-home'},React.createElement('h1',null,'我的待办'),React.createElement(PersonalGrowthStrip,{scopeKey:f.scope,tasks:f.tasks,timeZone:'Asia/Hong_Kong',now,onOpenLegacy:()=>window.__legacyOpened=true}),React.createElement('p',null,'任务列表继续可用'));}createRoot(document.getElementById('root')).render(React.createElement(Host));`;
      },
    },
    react(),
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  logLevel: "error",
});
let browser;
const checks = [],
  errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  for (const [mode, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${mode}: ${e.message}`));
    await page.goto(server.resolvedUrls.local[0] + "__personal-growth");
    const strip = page.getByRole("region", { name: "个人成长", exact: true });
    await expect(strip).toContainText("总计 90 XP · 今天完成 8 项");
    await expect(strip).toContainText("Lv.1");
    checks.push(
      `${mode}: initial read shows task XP and today from persisted facts without adding old cultivation experience`,
    );
    await page.evaluate(() =>
      window.__growthFixture.update((f) => ({
        ...f,
        tasks: f.tasks.map((t) =>
          t.id === "task-9"
            ? {
                ...t,
                status: "completed",
                completedAt: new Date().toISOString(),
              }
            : t,
        ),
      })),
    );
    await expect(strip).toContainText("总计 100 XP");
    await expect(strip).toContainText("Lv.2");
    await expect(strip.getByRole("status")).toContainText("+10 XP");
    await page.evaluate(() =>
      window.__growthFixture.update((f) => ({
        ...f,
        tasks: f.tasks.map((t) =>
          t.id === "task-9" ? { ...t, deleted: true } : t,
        ),
      })),
    );
    await expect(strip).toContainText("总计 90 XP");
    await page.evaluate(() =>
      window.__growthFixture.update((f) => ({
        ...f,
        tasks: f.tasks.map((t) =>
          t.id === "task-9" ? { ...t, deleted: false } : t,
        ),
      })),
    );
    await expect(strip).toContainText("总计 100 XP");
    checks.push(
      `${mode}: completion, level-up, deletion and restoration update the same contribution without a claim step`,
    );
    await strip.getByText("成长显示设置", { exact: true }).click();
    await expect(strip).toContainText("1 项历史任务完成日期未知");
    await strip
      .getByRole("checkbox", { name: "减少成长动效", exact: true })
      .check();
    await strip
      .getByRole("button", { name: "旧修炼与奖励", exact: true })
      .click();
    expect(await page.evaluate(() => window.__legacyOpened)).toBe(true);
    await strip.getByRole("button", { name: "隐藏成长", exact: true }).click();
    await expect(
      strip.getByRole("button", { name: "显示成长", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      strip.getByRole("button", { name: "显示成长", exact: true }),
    ).toBeVisible();
    checks.push(
      `${mode}: hide/reduced-motion preferences survive reload and hiding retains a restore control`,
    );
    await page.evaluate(() =>
      window.__growthFixture.update((f) => ({
        ...f,
        scope: "account-b/local",
      })),
    );
    await expect(strip).toContainText("个人成长");
    await strip.getByText("成长显示设置", { exact: true }).click();
    await expect(
      strip.getByRole("checkbox", { name: "减少成长动效", exact: true }),
    ).not.toBeChecked();
    await page.evaluate(() =>
      window.__growthFixture.update((f) => ({
        ...f,
        scope: "account-a/local",
      })),
    );
    await expect(
      strip.getByRole("button", { name: "显示成长", exact: true }),
    ).toBeVisible();
    await strip.getByRole("button", { name: "显示成长", exact: true }).click();
    await strip.getByText("成长显示设置", { exact: true }).click();
    await expect(
      strip.getByRole("checkbox", { name: "减少成长动效", exact: true }),
    ).toBeChecked();
    checks.push(
      `${mode}: account/workspace remounts do not leak appearance preferences or previous-account announcements`,
    );
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await expect(strip).toHaveClass(/reduce-motion/);
      await page.screenshot({
        path: join(evidence, `${mode}-growth-${theme}.png`),
        fullPage: true,
      });
    }
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      body: document.documentElement.scrollWidth,
      animation: getComputedStyle(
        document.querySelector(".personal-growth-feedback"),
      ).animationName,
    }));
    expect(layout.body).toBeLessThanOrEqual(layout.viewport);
    expect(layout.animation).toBe("none");
    await writeFile(
      join(evidence, `${mode}-layout.json`),
      JSON.stringify(layout, null, 2),
    );
    checks.push(
      `${mode}: light/dark and reduced motion fit the viewport with all task-management content still available`,
    );
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw Error("synthetic unavailable storage");
      };
    });
    await strip
      .getByRole("checkbox", { name: "减少成长动效", exact: true })
      .uncheck();
    await expect(strip).toContainText("偏好仅在本页生效");
    await expect(
      page.getByText("任务列表继续可用", { exact: true }),
    ).toBeVisible();
    checks.push(
      `${mode}: unavailable preference storage gives a non-blocking warning`,
    );
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "component-ui-results.json"),
    JSON.stringify(
      {
        date: "2026-11-12",
        passed: true,
        environment:
          "isolated PersonalGrowthStrip in real React; synthetic task facts, not native app/device acceptance",
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({ passed: true, checks: checks.length, errors }) + "\n",
  );
} catch (error) {
  await writeFile(
    join(evidence, "component-ui-failure.json"),
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
