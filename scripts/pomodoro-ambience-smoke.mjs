// Real browser audio decoding and the shared desktop/mobile ambience controls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const requireClient = createRequire(resolve("apps/client/package.json"));
const { createServer } = await import(
  pathToFileURL(requireClient.resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(requireClient.resolve("@vitejs/plugin-react")).href
);
const manifest = JSON.parse(
  await readFile("apps/client/public/ambience/ppbzy/manifest.json", "utf8"),
);
const tracks = Object.values(manifest.categories).flatMap(
  (group) => group.variants,
);
assert.equal(Object.keys(manifest.categories).length, 12);
assert.equal(tracks.length, 48);
for (const track of tracks) {
  const bytes = await readFile(resolve("apps/client/public", track.file));
  assert.equal(bytes.length, track.bytes, track.file);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    track.sha256,
    track.file,
  );
}

const evidence = resolve(".scratch/ppbzy-import/verification");
await mkdir(evidence, { recursive: true });
const entry = "\0ambience-smoke";
const server = await createServer({
  configFile: false,
  root: resolve("apps/client"),
  cacheDir: resolve(".scratch/ppbzy-import/vite-cache"),
  plugins: [
    {
      name: "ambience-smoke",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__ambience")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@id/virtual:ambience-smoke"></script></html>',
            ),
          );
        });
      },
      resolveId(id) {
        if (id === "virtual:ambience-smoke") return entry;
      },
      load(id) {
        if (id !== entry) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {PomodoroDock} from '/src/PomodoroDock.tsx';import '/src/theme.css';import '/src/styles.css';import '/src/pomodoro.css';
      const mobile=new URLSearchParams(location.search).has('mobile');createRoot(document.getElementById('root')).render(React.createElement('main',{className:mobile?'pm-app':'workspace modern-workspace'},React.createElement('h1',null,'环境音试听'),React.createElement(PomodoroDock,{variant:mobile?'page':'dock'})));`;
      },
    },
    react(),
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  logLevel: "error",
});
let browser;
const checks = [];
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  for (const [mode, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.__audio = [];
      window.Audio = function (...args) {
        const item = new NativeAudio(...args);
        window.__audio.push(item);
        return item;
      };
    });
    await page.goto(
      server.resolvedUrls.local[0] +
        `__ambience${mode === "mobile" ? "?mobile" : ""}`,
    );
    const trigger = page.locator(".pomodoro-noise");
    await trigger.click();
    const menu = page.getByRole("menu", { name: "环境音", exact: true });
    await expect(menu.getByRole("menuitemradio")).toHaveCount(12);
    for (const group of Object.values(manifest.categories)) {
      await menu
        .getByRole("menuitemradio", { name: group.name, exact: true })
        .click();
      const picker = page.getByRole("combobox", {
        name: `${group.name}音轨`,
        exact: true,
      });
      await expect(picker.locator("option")).toHaveCount(group.variants.length);
      const last = group.variants.at(-1);
      await picker.selectOption(last.id);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const audio = window.__audio.at(-2);
            return audio &&
              !audio.paused &&
              Number.isFinite(audio.duration) &&
              !audio.error
              ? new URL(audio.src).pathname.slice(1)
              : "";
          }),
        )
        .toBe(last.file);
    }
    await menu.getByRole("menuitemradio", { name: "猫", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "猫音轨", exact: true }),
    ).toHaveValue("Cat purr 2");
    await expect
      .poll(() =>
        page.evaluate(() => Number.isFinite(window.__audio.at(-2)?.duration)),
      )
      .toBe(true);
    await page.evaluate(() => {
      const active = window.__audio.at(-2);
      active.currentTime = active.duration - 0.25;
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__audio.at(-2)?.paused && !window.__audio.at(-1)?.paused,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: resolve(evidence, `${mode}.png`),
      fullPage: true,
    });
    const bounds = await menu.boundingBox();
    assert(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
      `${mode} menu fits the viewport`,
    );
    await menu.getByRole("menuitem", { name: "关闭", exact: true }).click();
    await expect(trigger).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(() => window.__audio.every((audio) => audio.paused)),
      )
      .toBe(true);

    // A failed asset must reset the selected control and announce a retry.
    await page.route("**/ambience/ppbzy/cat/2.mp3", (route) =>
      route.fulfill({ status: 404, body: "missing audio" }),
    );
    await trigger.click();
    await menu.getByRole("menuitemradio", { name: "猫", exact: true }).click();
    await expect(trigger).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("status")).toContainText("环境音播放失败");
    await page.unroute("**/ambience/ppbzy/cat/2.mp3");
    checks.push(
      `${mode}: 12 categories, all variant menus, playback, remembered cat variant, crossfade loop, stop and missing-asset recovery`,
    );

    if (mode === "desktop") {
      const decoded = await page.evaluate(
        async (files) => {
          const context = new AudioContext();
          const result = [];
          try {
            for (const file of files) {
              const response = await fetch("/" + file);
              if (!response.ok) throw new Error(`${response.status}: ${file}`);
              const audio = await context.decodeAudioData(
                await response.arrayBuffer(),
              );
              if (!(audio.duration > 0))
                throw new Error(`Empty audio: ${file}`);
              result.push({
                file,
                seconds: audio.duration,
                channels: audio.numberOfChannels,
                sampleRate: audio.sampleRate,
              });
            }
          } finally {
            await context.close();
          }
          return result;
        },
        tracks.map((track) => track.file),
      );
      await writeFile(
        resolve(evidence, "decoded-audio.json"),
        JSON.stringify(decoded, null, 2),
      );
      checks.push(
        `All ${decoded.length} local audio files decoded by the real browser; byte counts and SHA-256 hashes verified`,
      );
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(evidence, "verification.json"),
    JSON.stringify(
      {
        checks,
        errors,
        totalBytes: tracks.reduce((sum, track) => sum + track.bytes, 0),
      },
      null,
      2,
    ),
  );
  console.log(checks.join("\n"));
} finally {
  await browser?.close();
  await server.close();
}
